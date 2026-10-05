// Package bridge is the session host's half of the authentication bridge
// (R7): it exchanges a locally verified certificate identity for a short-lived
// Cytale access token.
//
// # The wire contract is not this package's to design
//
// The server side is already implemented and committed
// (CytaleWeb.SessionBridgeController, Cytale.SessionBridge), so every field
// name, status code and reason string below mirrors it exactly rather than
// being chosen here:
//
//	POST /internal/ssh/session
//	x-cytale-bridge-credential: <credential>
//	{"serial":"<decimal string>","principal":"<username>",
//	 "fingerprint":"SHA256:<b64>","nonce":"<base64 8..256 bytes>",
//	 "asserted_at":<unix seconds>}
//
//	200 {"access_token","token_type","expires_in","username"}
//	400 {"error":{"key","reason","message"}}   malformed shape
//	403 {"error":{"key","reason","message"}}   a well-shaped assertion the
//	                                            server declines
//
// The reasons the server may return are `unknown_serial`,
// `certificate_expired`, `principal_mismatch`, `fingerprint_mismatch`,
// `account_deleted`, `unverified`, `credential_epoch_moved`,
// `replayed_assertion` and `stale_assertion`; this package carries them through
// verbatim so the session-end message can name the cause (R19a) instead of
// reporting "the bridge said no".
//
// # The nonce is fresh per mint, the serial is not
//
// The server records the nonce single-use and keys its replay guard on it, so
// reusing a nonce on a renewal is refused as `replayed_assertion`. The serial
// is the issuance-row lookup key and stays the same across every renewal of one
// session. Sending a stable nonce would kill the first renewal; sending a fresh
// serial is impossible (the serial is the certificate's).
//
// # Secrets
//
// The credential is held in memory only. It never appears in a URL, a query
// string, a log line, or an error message: refusals quote the server's own
// reason and never the request headers. LoadCredential reads it once at boot
// and unlinks the file (R12a).
package bridge

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

// Route is the bridge's single path. It is on the bridge's OWN listener, which
// is bound to the internal network and is not the listener the public edge
// proxies (R8a).
const Route = "/internal/ssh/session"

// CredentialHeader is the request header carrying the bridge credential.
const CredentialHeader = "x-cytale-bridge-credential"

// nonceBytes is the size of the fresh nonce each mint carries. The server
// accepts 8..256 bytes; 32 random bytes are unambiguous and never collide.
const nonceBytes = 32

// maxBodyBytes bounds how much of a refusal body this client will read. A
// refusal is a small JSON envelope; anything larger is a broken peer.
const maxBodyBytes = 64 << 10

// MintRequest is a verified identity asserting itself to the bridge.
type MintRequest struct {
	// Serial is the certificate's serial. Stable across a session's renewals.
	Serial uint64

	// Principal is the certificate principal, which the host has already
	// checked equals the requested login name.
	Principal string

	// Fingerprint is the OpenSSH SHA256 fingerprint of the certified public
	// key, in Go's `SHA256:<base64>` spelling. The server normalizes the
	// padding, so its own unpadded spelling compares equal.
	Fingerprint string
}

// Minted is a successful mint.
type Minted struct {
	// AccessToken is the Cytale access token. Never log this value.
	AccessToken string

	// TokenType is the scheme the token is presented with; always "Bearer".
	TokenType string

	// ExpiresIn is the token's lifetime in seconds, as the server stated it.
	ExpiresIn int

	// Username is the principal the server resolved the mint to. It rides back
	// so the host starts the client already knowing who it is.
	Username string
}

// ExpiresAt is when the token stops being usable, per the local clock.
func (m Minted) ExpiresAt() time.Time {
	return time.Now().Add(time.Duration(m.ExpiresIn) * time.Second)
}

// String redacts the token body.
func (m Minted) String() string {
	return fmt.Sprintf("bridge.Minted{user=%q expires_in=%d access_token=[redacted]}", m.Username, m.ExpiresIn)
}

// Refusal is a 400 or 403 the bridge returned: a well-formed request this
// server declined. Reason is the machine-readable cause the session-end
// message carries (R19a).
type Refusal struct {
	// Status is the HTTP status: 400 for a malformed shape, 403 for a refusal.
	Status int `json:"-"`

	// Key is the error envelope's key; "bridge_refused" on the mint route,
	// "bridge_unauthorized" when the credential gate refused first.
	Key string `json:"key"`

	// Reason is the machine-readable cause.
	Reason string `json:"reason"`

	// Message is the member-facing sentence the server wrote for the cause.
	Message string `json:"message"`
}

func (e *Refusal) Error() string {
	return fmt.Sprintf("bridge refused (%d): %s — %s", e.Status, e.Reason, e.Message)
}

// ReasonUnknownSerial and friends are named so callers can branch without
// string comparison at each site.
const (
	ReasonUnknownSerial        = "unknown_serial"
	ReasonCertificateExpired   = "certificate_expired"
	ReasonPrincipalMismatch    = "principal_mismatch"
	ReasonFingerprintMismatch  = "fingerprint_mismatch"
	ReasonAccountDeleted       = "account_deleted"
	ReasonUnverified           = "unverified"
	ReasonCredentialEpochMoved = "credential_epoch_moved"
	ReasonReplayedAssertion    = "replayed_assertion"
	ReasonStaleAssertion       = "stale_assertion"
	ReasonMissingCredential    = "missing_credential"
	ReasonBadCredential        = "bad_credential"
)

// IsRefusal reports whether err is a bridge refusal and returns it.
//
// A refusal is terminal: the bridge understood the request and said no, so
// retrying it inside a renewal window would just fail again more slowly. A
// transport error is not terminal.
func IsRefusal(err error) (*Refusal, bool) {
	var refusal *Refusal
	if errors.As(err, &refusal) {
		return refusal, true
	}
	return nil, false
}

// Client mints access tokens from the bridge.
type Client struct {
	endpoint   *url.URL
	credential string
	http       *http.Client
	now        func() time.Time
	rand       io.Reader
}

// Option configures a Client.
type Option func(*Client)

// WithHTTPClient replaces the transport, which tests use to point at an
// httptest server and to inject timeouts.
func WithHTTPClient(c *http.Client) Option {
	return func(cl *Client) { cl.http = c }
}

// WithClock replaces the clock used for the asserted_at timestamp.
func WithClock(now func() time.Time) Option {
	return func(cl *Client) { cl.now = now }
}

// WithRand replaces the nonce source.
func WithRand(r io.Reader) Option {
	return func(cl *Client) { cl.rand = r }
}

// New builds a bridge client.
//
// baseURL is the bridge listener's base URL (its own port on the internal
// network, not the public origin). The credential must be non-empty: a bridge
// client without one can only produce 401s, so failing here is failing closed
// at boot rather than at the first member's connection.
func New(baseURL, credential string, opts ...Option) (*Client, error) {
	if strings.TrimSpace(credential) == "" {
		return nil, errors.New("bridge: base URL and a non-empty credential are both required")
	}

	parsed, err := url.Parse(strings.TrimSpace(baseURL))
	if err != nil {
		return nil, fmt.Errorf("bridge: parse base URL: %w", err)
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return nil, fmt.Errorf("bridge: base URL scheme %q is not http or https", parsed.Scheme)
	}
	if parsed.Host == "" {
		return nil, errors.New("bridge: base URL has no host")
	}

	parsed.Path = strings.TrimSuffix(parsed.Path, "/") + Route

	c := &Client{
		endpoint:   parsed,
		credential: strings.TrimSpace(credential),
		http:       &http.Client{Timeout: 10 * time.Second},
		now:        time.Now,
		rand:       rand.Reader,
	}
	for _, opt := range opts {
		opt(c)
	}
	return c, nil
}

// Endpoint is the absolute route the client posts to. It is exposed so a test
// can assert the path without reaching into the client.
func (c *Client) Endpoint() string { return c.endpoint.String() }

// Mint exchanges a verified identity for an access token.
//
// The nonce is fresh on every call (crypto/rand), which is what lets one
// session renew repeatedly on one serial.
func (c *Client) Mint(ctx context.Context, req MintRequest) (Minted, error) {
	if req.Principal == "" {
		return Minted{}, errors.New("bridge: mint requires a principal")
	}
	if req.Fingerprint == "" {
		return Minted{}, errors.New("bridge: mint requires a fingerprint")
	}

	nonce := make([]byte, nonceBytes)
	if _, err := io.ReadFull(c.rand, nonce); err != nil {
		return Minted{}, fmt.Errorf("bridge: read nonce: %w", err)
	}

	// The body is built from a map with the exact field names and types the
	// controller parses: the serial is a DECIMAL STRING (the server accepts an
	// integer too, but the committed shape is the string form), and
	// asserted_at is unix seconds.
	body, err := json.Marshal(map[string]any{
		"serial":      fmt.Sprintf("%d", req.Serial),
		"principal":   req.Principal,
		"fingerprint": req.Fingerprint,
		"nonce":       base64.StdEncoding.EncodeToString(nonce),
		"asserted_at": c.now().Unix(),
	})
	if err != nil {
		return Minted{}, fmt.Errorf("bridge: marshal request: %w", err)
	}

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, c.endpoint.String(), bytes.NewReader(body))
	if err != nil {
		return Minted{}, fmt.Errorf("bridge: build request: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set(CredentialHeader, c.credential)

	resp, err := c.http.Do(httpReq)
	if err != nil {
		return Minted{}, fmt.Errorf("bridge: request failed: %w", err)
	}
	defer resp.Body.Close() //nolint:errcheck // the body is drained below

	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxBodyBytes))
	if err != nil {
		return Minted{}, fmt.Errorf("bridge: read response: %w", err)
	}

	switch {
	case resp.StatusCode == http.StatusOK:
		return parseMinted(raw)
	case resp.StatusCode == http.StatusBadRequest, resp.StatusCode == http.StatusForbidden,
		resp.StatusCode == http.StatusUnauthorized:
		return Minted{}, parseRefusal(resp.StatusCode, raw)
	default:
		// A 5xx or anything else is a transport-shaped failure: the request may
		// be worth retrying inside the renewal window. The body is deliberately
		// not quoted — it could echo the assertion.
		return Minted{}, fmt.Errorf("bridge: unexpected status %d", resp.StatusCode)
	}
}

func parseMinted(raw []byte) (Minted, error) {
	var envelope struct {
		AccessToken string `json:"access_token"`
		TokenType   string `json:"token_type"`
		ExpiresIn   int    `json:"expires_in"`
		Username    string `json:"username"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return Minted{}, fmt.Errorf("bridge: decode success body: %w", err)
	}
	if envelope.AccessToken == "" {
		return Minted{}, errors.New("bridge: success body carried no access_token")
	}
	if envelope.ExpiresIn <= 0 {
		return Minted{}, errors.New("bridge: success body carried no usable expires_in")
	}
	if envelope.TokenType == "" {
		envelope.TokenType = "Bearer"
	}
	if envelope.Username == "" {
		return Minted{}, errors.New("bridge: success body carried no username")
	}
	return Minted{
		AccessToken: envelope.AccessToken,
		TokenType:   envelope.TokenType,
		ExpiresIn:   envelope.ExpiresIn,
		Username:    envelope.Username,
	}, nil
}

func parseRefusal(status int, raw []byte) error {
	var envelope struct {
		Error Refusal `json:"error"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return &Refusal{Status: status, Reason: "malformed_refusal"}
	}
	envelope.Error.Status = status
	if envelope.Error.Reason == "" {
		envelope.Error.Reason = "bridge_refused"
	}
	return &envelope.Error
}

// LoadCredential reads the bridge credential at path once and unlinks it
// (R12a), returning the trimmed value.
//
// The credential is a PATH, never an environment value: an environment value
// stays readable to a same-UID child through the host's /proc, and
// read-once-and-unlink cannot apply to a value. After this returns, no readable
// artifact of the credential remains on the filesystem.
//
// retain exists for the one deployment the plan allows to skip the unlink:
// when the client runs under a distinct uid, the credential's readability to
// the host is not readability to the member's process. In that case the
// operator passes retain = true and is responsible for the file's mode.
func LoadCredential(path string, retain bool) (string, error) {
	if strings.TrimSpace(path) == "" {
		return "", errors.New("bridge: credential path is required")
	}

	raw, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("bridge: read credential at %s: %w", path, err)
	}
	// Clear the buffer once it has been copied into the returned string; the
	// file is about to stop existing, and a lingering copy in a slice is one
	// more place a crash dump could surface it.
	defer func() {
		for i := range raw {
			raw[i] = 0
		}
	}()

	credential := strings.TrimSpace(string(raw))
	if credential == "" {
		return "", fmt.Errorf("bridge: credential at %s is empty", path)
	}

	if !retain {
		if err := os.Remove(path); err != nil {
			return "", fmt.Errorf(
				"bridge: credential at %s could not be unlinked (%w); a same-UID client process could still read it. "+
					"Either make the file removable or run the client under a distinct uid and set the retain flag",
				path, err,
			)
		}
	}

	return credential, nil
}
