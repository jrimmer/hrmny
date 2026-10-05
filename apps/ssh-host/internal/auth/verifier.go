// Package auth is the SSH host's trust boundary: it decides whether a
// presented public key authenticates a connection, and it carries the verified
// identity forward to the session (R10, KTD4).
//
// # Why this is not `wish.WithTrustedUserCAKeys`
//
// The wish convenience option builds a bare `gossh.CertChecker` with an empty
// `SupportedCriticalOptions` and calls `CheckCert` directly. `CheckCert` checks
// neither the certificate type nor the issuing authority, so a HOST certificate
// signed by the same CA would pass it. `CertChecker.Authenticate` adds both
// checks. It is, however, still not enough on its own, for three reasons the
// plan enumerates (KTD4) and this package closes:
//
//   - an EMPTY principals list is treated as "valid for all users/hosts" by
//     `CheckCert`, so a certificate with no principal authenticates as anyone;
//   - an INDEFINITE validity window (`CertTimeInfinity`) is explicitly exempted
//     from the expiry check;
//   - `Authenticate` appends `source-address` to `SupportedCriticalOptions` and
//     only declines to *reject* it — the enforcement lives in the transport's
//     auth loop, so any critical option an operator did not intend must be
//     refused here rather than trusted to be enforced downstream.
//
// # Why `Authenticate` is wired as the callback itself
//
// The callback is assigned directly to `gossh.ServerConfig.PublicKeyCallback`
// through the server-config seam (`ssh.Server.ServerConfigCallback`). Going
// through charm's `PublicKeyHandler` would run the returned permissions through
// the fork's own wrapper and, worse, would let the fork replace the callback
// entirely — so the callback IS the seam, and AssertVerifierWired checks that
// nothing shadows it.
//
// # How the identity travels
//
// In raw `x/crypto` the certificate object is not reachable after
// authentication: `ServerConn` exposes only `Permissions`, and no
// `Permissions()` accessor returns the key. `x/crypto`'s own documentation for
// `PublicKeyCallback` says exactly what to do instead — "To record any data
// depending on the public key, store it inside a Permissions.Extensions entry."
// So the verified identity is marshalled into a namespaced extension and read
// back from the session. Re-reading the certificate later is not an option that
// exists.
//
// Nothing a client sends can populate that entry: Permissions are produced by
// the server-side callback, not parsed from the wire.
package auth

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"sort"
	"strings"
	"time"

	"charm.land/ssh"
	gossh "golang.org/x/crypto/ssh"
)

// IdentityExtensionKey is the Permissions.Extensions entry the verified
// identity travels in. Namespaced so it cannot collide with the fork's own
// `gliderlabs/ssh.PublicKey` entry.
const IdentityExtensionKey = "cytale.dev/ssh-identity"

// Rejection reasons, named so a test can assert the exact check that fired
// rather than a message prefix.
var (
	// ErrNotACertificate is a plain public key. `UserKeyFallback` is
	// deliberately nil: on this host a key is not a login, a certificate is.
	ErrNotACertificate = errors.New("ssh: presented key is not a certificate; this host accepts user certificates only")

	// ErrEmptyPrincipals is the wildcard case. `CheckCert` skips the principal
	// check entirely when the list is empty, so a certificate with no principal
	// would authenticate as any login name.
	ErrEmptyPrincipals = errors.New("ssh: certificate has an empty principals list, which is a wildcard and is refused")

	// ErrIndefiniteValidity is `CertTimeInfinity`.
	ErrIndefiniteValidity = errors.New("ssh: certificate has an indefinite validity window, which is refused")

	// ErrCriticalOptions is any non-empty critical-options map, including
	// source-address, because `Authenticate` accepts that one without this
	// host acting on it.
	ErrCriticalOptions = errors.New("ssh: certificate carries critical options this host does not act on")

	// ErrNoIdentity is a session whose permissions carry no verified identity,
	// which means the session is running outside the verifier.
	ErrNoIdentity = errors.New("ssh: no verified identity on this connection")
)

// Identity is the part of a verified certificate the session needs. It is the
// only certificate-derived data that leaves this package.
type Identity struct {
	// Serial is the certificate's serial, which the bridge looks the issuance
	// up by. Stable across a session's renewals.
	Serial uint64 `json:"serial"`

	// Principal is the certificate's principal, already checked against the
	// requested login name.
	Principal string `json:"principal"`

	// Fingerprint is the OpenSSH SHA256 fingerprint of the certified public
	// key, in Go's `SHA256:<base64>` spelling.
	Fingerprint string `json:"fingerprint"`

	// KeyID is the certificate's key id, carried for audit correlation.
	KeyID string `json:"key_id,omitempty"`

	// ValidBefore is the certificate's expiry. The session re-checks it before
	// every renewal (R13): a renewal must not extend a session past the
	// certificate's own window.
	ValidBefore time.Time `json:"valid_before"`
}

// Marshal encodes the identity for carriage in Permissions.Extensions.
func (i Identity) Marshal() (string, error) {
	body, err := json.Marshal(i)
	if err != nil {
		return "", fmt.Errorf("auth: marshal identity: %w", err)
	}
	return string(body), nil
}

// ParseIdentity decodes an identity from its extension spelling.
func ParseIdentity(value string) (Identity, error) {
	var id Identity
	if err := json.Unmarshal([]byte(value), &id); err != nil {
		return Identity{}, fmt.Errorf("auth: parse identity: %w", err)
	}
	if id.Principal == "" || id.Serial == 0 {
		return Identity{}, ErrNoIdentity
	}
	return id, nil
}

// IdentityFromPermissions reads the verified identity out of a permissions set.
func IdentityFromPermissions(perms *gossh.Permissions) (Identity, error) {
	if perms == nil || perms.Extensions == nil {
		return Identity{}, ErrNoIdentity
	}
	value, ok := perms.Extensions[IdentityExtensionKey]
	if !ok {
		return Identity{}, ErrNoIdentity
	}
	return ParseIdentity(value)
}

// IdentityFromContext reads the verified identity from a connection context.
//
// This is the read path the plan names: the identity is not re-derived from the
// certificate (which is unreachable), it is read back from the extensions entry
// the verifier wrote.
func IdentityFromContext(ctx ssh.Context) (Identity, error) {
	if ctx == nil {
		return Identity{}, ErrNoIdentity
	}
	perms := ctx.Permissions()
	if perms == nil {
		return Identity{}, ErrNoIdentity
	}
	return IdentityFromPermissions(perms.Permissions)
}

// IdentityFromSession reads the verified identity from an established session.
func IdentityFromSession(sess ssh.Session) (Identity, error) {
	if sess == nil {
		return Identity{}, ErrNoIdentity
	}
	perms := sess.Permissions()
	return IdentityFromPermissions(perms.Permissions)
}

// Option configures a Verifier.
type Option func(*Verifier)

// WithClock replaces the clock the certificate window is checked against.
func WithClock(now func() time.Time) Option {
	return func(v *Verifier) { v.now = now }
}

// Verifier verifies user certificates against a configured trust set.
type Verifier struct {
	checker     *gossh.CertChecker
	authorities []gossh.PublicKey
	algorithms  []string
	now         func() time.Time
}

// NewVerifier builds a verifier whose trust set is exactly the given CA public
// keys.
//
// The set is fixed at construction: there is no per-connection trust lookup, so
// a certificate's issuing authority either was in the boot-time configuration
// or does not exist for this process.
func NewVerifier(authorities []gossh.PublicKey, opts ...Option) (*Verifier, error) {
	if len(authorities) == 0 {
		return nil, errors.New("auth: at least one certificate authority public key is required")
	}

	v := &Verifier{
		authorities: append([]gossh.PublicKey(nil), authorities...),
		now:         time.Now,
	}
	for _, opt := range opts {
		opt(v)
	}

	trusted := make(map[string]struct{}, len(v.authorities))
	for _, authority := range v.authorities {
		trusted[string(authority.Marshal())] = struct{}{}
	}

	v.checker = &gossh.CertChecker{
		// Deliberately empty, and deliberately NOT supplemented here:
		// Authenticate appends source-address on its own, so leaving this empty
		// is what makes every OTHER critical option a refusal. The extra
		// all-critical-options reject below then closes that remaining gap.
		SupportedCriticalOptions: nil,

		// The trust set. Marshalled-blob equality, so a CA key that differs in
		// any way — including a comment or a certificate wrapping — is a
		// different authority.
		IsUserAuthority: func(authority gossh.PublicKey) bool {
			_, ok := trusted[string(authority.Marshal())]
			return ok
		},

		Clock: v.now,

		// nil on purpose: a plain public key must not authenticate (R10, and the
		// test scenario that asserts UserKeyFallback is nil).
		UserKeyFallback: nil,
	}

	v.algorithms = publicKeyAuthAlgorithms(v.authorities)
	return v, nil
}

// Authenticate is a `gossh.ServerConfig.PublicKeyCallback`.
//
// The signature matches that field exactly so it can be assigned directly,
// which is the seam the plan requires: the permissions it returns — including
// the certificate's critical options and the identity extension — reach the
// transport's own enforcement rather than being discarded by a wrapper.
func (v *Verifier) Authenticate(conn gossh.ConnMetadata, key gossh.PublicKey) (*gossh.Permissions, error) {
	cert, isCert := key.(*gossh.Certificate)
	if !isCert {
		return nil, fmt.Errorf("%w (offered %s)", ErrNotACertificate, key.Type())
	}

	// Authenticate now checks, in order: CertType == UserCert, a non-nil
	// IsUserAuthority, the authority is in our trust set, the certificate
	// signature, critical options against an empty supported list plus
	// source-address, principal membership WHEN the principal list is
	// non-empty, and the validity window.
	if _, err := v.checker.Authenticate(conn, key); err != nil {
		return nil, err
	}

	// Gap 1: an empty principals list is a wildcard to CheckCert.
	if len(cert.ValidPrincipals) == 0 {
		return nil, ErrEmptyPrincipals
	}

	// Gap 2: an indefinite window is exempt from the expiry check.
	if cert.ValidBefore == gossh.CertTimeInfinity {
		return nil, ErrIndefiniteValidity
	}

	// Gap 3: any critical option at all. source-address has already been
	// accepted by Authenticate's own SupportedCriticalOptions override; the
	// enforcement for it lives in the transport's auth loop, so a certificate
	// that pins one must be refused here rather than trusted to be enforced.
	if len(cert.CriticalOptions) > 0 {
		return nil, fmt.Errorf("%w: %s", ErrCriticalOptions, sortedKeys(cert.CriticalOptions))
	}

	// The principal bind (KTD3): the certificate's principal is the member's
	// username, the SSH login name must equal it, and the bridge resolves that
	// principal to an account. Two checks deliver it and they are exhaustive:
	// CheckCert inside Authenticate refuses a non-empty principal set that does
	// not contain conn.User(), and the empty case was refused above. There is
	// deliberately no third membership test here — an extra one is unreachable,
	// and unreachable security code reads as if it were load-bearing.
	identity := Identity{
		Serial:      cert.Serial,
		Principal:   conn.User(),
		Fingerprint: gossh.FingerprintSHA256(cert.Key),
		KeyID:       cert.KeyId,
		ValidBefore: time.Unix(int64(cert.ValidBefore), 0).UTC(),
	}
	encoded, err := identity.Marshal()
	if err != nil {
		return nil, err
	}

	return &gossh.Permissions{
		// Passed through rather than dropped. In practice this is always empty
		// because the reject above fires first; passing it through is what
		// keeps the transport's enforcement engaged if that ever changes, which
		// is the plan's stated reason for wiring the callback directly.
		CriticalOptions: cert.CriticalOptions,
		Extensions: map[string]string{
			IdentityExtensionKey: encoded,
		},
	}, nil
}

// PublicKeyAuthAlgorithms is the algorithm family the trust set permits, for
// `ServerConfig.PublicKeyAuthAlgorithms`.
//
// Pinned to the CA's family so the host advertises exactly what it can verify.
// Certificate types are deliberately not listed: the wire algorithm for a
// certificate is its underlying key algorithm, and x/crypto compares against
// that.
func (v *Verifier) PublicKeyAuthAlgorithms() []string {
	return append([]string(nil), v.algorithms...)
}

// Authorities returns the trust set, for a boot-time log line that names the
// fingerprints an operator pinned.
func (v *Verifier) Authorities() []gossh.PublicKey {
	return append([]gossh.PublicKey(nil), v.authorities...)
}

// LoadCAPublicKeys reads an authorized-keys file holding one or more CA public
// keys.
//
// A CA public key is not a secret: it stays on disk and is safe to bake into an
// image. Only the host PRIVATE key and the bridge credential are read once and
// unlinked (R12a).
func LoadCAPublicKeys(path string) ([]gossh.PublicKey, error) {
	if strings.TrimSpace(path) == "" {
		return nil, errors.New("auth: CA public key path is required")
	}

	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("auth: read CA public key at %s: %w", path, err)
	}

	var keys []gossh.PublicKey
	for lineNumber, line := range strings.Split(string(raw), "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		key, _, _, _, err := gossh.ParseAuthorizedKey([]byte(trimmed))
		if err != nil {
			return nil, fmt.Errorf("auth: CA public key at %s line %d is not a public key: %w", path, lineNumber+1, err)
		}
		keys = append(keys, key)
	}
	if len(keys) == 0 {
		return nil, fmt.Errorf("auth: CA public key file %s holds no keys", path)
	}
	return keys, nil
}

// LoadHostKey reads the host private key at path once and unlinks it (R12a).
//
// The host key is secret material in the same sense the bridge credential is:
// any same-UID process in the container could otherwise read it, so leaving it
// on disk after boot would be one more readable secret for no benefit.
//
// retain exists for the one deployment the plan allows to skip the unlink: when
// the client runs under a distinct uid, the key's readability to the host is
// not readability to the member's process. In that case the operator passes
// retain = true and owns the file's mode.
func LoadHostKey(path string, retain bool) (gossh.Signer, error) {
	if strings.TrimSpace(path) == "" {
		return nil, errors.New("auth: host key path is required")
	}

	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("auth: read host key at %s: %w", path, err)
	}
	defer func() {
		for i := range raw {
			raw[i] = 0
		}
	}()

	signer, err := gossh.ParsePrivateKey(raw)
	if err != nil {
		// The error from ParsePrivateKey names no key material, and the path is
		// configuration, not a secret.
		return nil, fmt.Errorf("auth: parse host key at %s: %w", path, err)
	}

	if !retain {
		if err := os.Remove(path); err != nil {
			return nil, fmt.Errorf(
				"auth: host key at %s could not be unlinked (%w); a same-UID client process could still read it. "+
					"Either make the file removable or run the client under a distinct uid and set the retain flag",
				path, err,
			)
		}
	}

	return signer, nil
}

// AssertVerifierWired is the boot assertion R11's test scenario names.
//
// It exists because the charm fork enables `NoClientAuth` — a silent fail-open
// that accepts every connection — when every handler and callback is nil, and
// because assigning `Server.PublicKeyHandler` makes the fork REPLACE
// `ServerConfig.PublicKeyCallback` with its own wrapper, which would silently
// undo the KTD4 wiring while still authenticating.
//
// It is called at boot with the server and the exact ServerConfig the
// ServerConfigCallback produces, so it evaluates the same objects the transport
// will.
func AssertVerifierWired(srv *ssh.Server, cfg *gossh.ServerConfig) error {
	if srv == nil {
		return errors.New("auth: no server to assert")
	}
	if cfg == nil {
		return errors.New("auth: the server config callback produced no config; the public-key verifier would not be registered")
	}

	// The seam itself.
	if cfg.PublicKeyCallback == nil {
		return errors.New("auth: ServerConfig.PublicKeyCallback is nil; the public-key verifier is not registered")
	}

	// The fail-open. Mirrors (*ssh.Server).config's condition exactly, so this
	// returns an error in precisely the case the fork would accept every
	// connection without authentication.
	allHandlersNil := srv.PasswordHandler == nil && srv.PublicKeyHandler == nil && srv.KeyboardInteractiveHandler == nil
	allCallbacksNil := cfg.PasswordCallback == nil && cfg.PublicKeyCallback == nil && cfg.KeyboardInteractiveCallback == nil
	if allHandlersNil && allCallbacksNil {
		return errors.New("auth: every handler and callback is nil, so the SSH server would set NoClientAuth and accept every connection")
	}
	if cfg.NoClientAuth {
		return errors.New("auth: ServerConfig.NoClientAuth is true; the host would accept unauthenticated connections")
	}

	// The shadowing. The fork overwrites the callback when this handler is set.
	if srv.PublicKeyHandler != nil {
		return errors.New("auth: Server.PublicKeyHandler is set; the fork would replace PublicKeyCallback and discard the certificate verification seam")
	}

	// No second authentication method. A password or keyboard-interactive path
	// would be an authentication factor this product never intends to offer
	// (KTD1: the certificate is the login, not a factor).
	if srv.PasswordHandler != nil || srv.KeyboardInteractiveHandler != nil {
		return errors.New("auth: a password or keyboard-interactive handler is set; the certificate is the only login this host offers")
	}
	if cfg.PasswordCallback != nil || cfg.KeyboardInteractiveCallback != nil {
		return errors.New("auth: ServerConfig offers a password or keyboard-interactive callback; the certificate is the only login this host offers")
	}

	return nil
}

// publicKeyAuthAlgorithms maps the CA key types to the wire algorithm names the
// host will accept, deduplicated and ordered.
func publicKeyAuthAlgorithms(authorities []gossh.PublicKey) []string {
	seen := map[string]struct{}{}
	var algorithms []string

	for _, authority := range authorities {
		for _, name := range algorithmFamily(authority.Type()) {
			if _, ok := seen[name]; ok {
				continue
			}
			seen[name] = struct{}{}
			algorithms = append(algorithms, name)
		}
	}

	if len(algorithms) == 0 {
		// A CA type with no known family would pin an empty list, and x/crypto
		// treats an empty list as "use the defaults" — a silent widening. Pin
		// ed25519, the algorithm the signer issues (U1), rather than widening.
		return []string{gossh.KeyAlgoED25519}
	}

	sort.Strings(algorithms)
	return algorithms
}

func algorithmFamily(keyType string) []string {
	switch {
	case strings.HasPrefix(keyType, gossh.KeyAlgoED25519):
		return []string{gossh.KeyAlgoED25519}
	case strings.HasPrefix(keyType, gossh.KeyAlgoRSA):
		// RSA keys sign with one of the SHA-2 variants; ssh-rsa (SHA-1) is not
		// offered.
		return []string{gossh.KeyAlgoRSASHA256, gossh.KeyAlgoRSASHA512}
	case strings.HasPrefix(keyType, "ecdsa-sha2-"):
		return []string{keyType}
	default:
		return nil
	}
}

func sortedKeys(m map[string]string) string {
	names := make([]string, 0, len(m))
	for name := range m {
		names = append(names, name)
	}
	sort.Strings(names)
	return strings.Join(names, ", ")
}
