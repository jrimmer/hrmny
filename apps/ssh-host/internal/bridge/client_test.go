package bridge_test

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/jrimmer/hrmny/apps/ssh-host/internal/bridge"
)

// received is what the fake bridge saw, so the test asserts the request shape
// rather than the client's own idea of it.
type received struct {
	mu     sync.Mutex
	path   string
	header string
	body   map[string]any
	calls  int
}

func (r *received) record(req *http.Request) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.calls++
	r.path = req.URL.Path
	r.header = req.Header.Get(bridge.CredentialHeader)
	defer req.Body.Close() //nolint:errcheck // test server
	_ = json.NewDecoder(req.Body).Decode(&r.body)
}

func (r *received) snapshot() (int, string, string, map[string]any) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.calls, r.path, r.header, r.body
}

// TestMintSendsTheCommittedWireContract asserts every field name, type and
// presence the server side parses. This is the whole point of the package: the
// bridge is already implemented, so a drift here is a session that cannot
// start.
func TestMintSendsTheCommittedWireContract(t *testing.T) {
	rec := &received{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		rec.record(req)
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"access_token":"tok-1","token_type":"Bearer","expires_in":900,"username":"jordan"}`)
	}))
	defer srv.Close()

	client, err := bridge.New(srv.URL, "bridge-credential-value")
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	minted, err := client.Mint(context.Background(), bridge.MintRequest{
		Serial:      987654321,
		Principal:   "jordan",
		Fingerprint: "SHA256:abc123",
	})
	if err != nil {
		t.Fatalf("Mint: %v", err)
	}

	if minted.AccessToken != "tok-1" || minted.ExpiresIn != 900 || minted.Username != "jordan" {
		t.Fatalf("Mint returned %+v", minted)
	}

	calls, path, header, body := rec.snapshot()
	if calls != 1 {
		t.Fatalf("bridge saw %d requests, want 1", calls)
	}
	if path != "/internal/ssh/session" {
		t.Errorf("path = %q, want /internal/ssh/session", path)
	}
	if header != "bridge-credential-value" {
		t.Errorf("%s header = %q", bridge.CredentialHeader, header)
	}

	// The serial is a decimal string, per the committed shape.
	if got, want := body["serial"], "987654321"; got != want {
		t.Errorf("serial = %#v, want the decimal string %q", got, want)
	}
	if body["principal"] != "jordan" {
		t.Errorf("principal = %#v", body["principal"])
	}
	if body["fingerprint"] != "SHA256:abc123" {
		t.Errorf("fingerprint = %#v", body["fingerprint"])
	}

	// asserted_at is a JSON number of unix seconds.
	seconds, ok := body["asserted_at"].(float64)
	if !ok || seconds < 1 {
		t.Fatalf("asserted_at = %#v, want unix seconds as a number", body["asserted_at"])
	}

	// The nonce is base64 of 8..256 bytes, which is the server's accepted range.
	nonce, ok := body["nonce"].(string)
	if !ok {
		t.Fatalf("nonce = %#v, want a string", body["nonce"])
	}
	decoded, err := base64.StdEncoding.DecodeString(nonce)
	if err != nil {
		t.Fatalf("nonce %q is not standard base64: %v", nonce, err)
	}
	if len(decoded) < 8 || len(decoded) > 256 {
		t.Fatalf("nonce is %d bytes, want 8..256", len(decoded))
	}
}

// TestNonceIsFreshPerMintAndSerialIsStable is the renewal contract the server's
// replay guard depends on: a reused nonce is `replayed_assertion`, and the
// serial is the certificate's so it cannot change between renewals.
func TestNonceIsFreshPerMintAndSerialIsStable(t *testing.T) {
	var nonces []string
	var serials []any

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(req.Body).Decode(&body)
		req.Body.Close() //nolint:errcheck // test server
		if nonce, ok := body["nonce"].(string); ok {
			nonces = append(nonces, nonce)
		}
		serials = append(serials, body["serial"])
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"access_token":"tok","token_type":"Bearer","expires_in":900,"username":"jordan"}`)
	}))
	defer srv.Close()

	client, err := bridge.New(srv.URL, "cred")
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	req := bridge.MintRequest{Serial: 7, Principal: "jordan", Fingerprint: "SHA256:x"}
	for i := 0; i < 3; i++ {
		if _, err := client.Mint(context.Background(), req); err != nil {
			t.Fatalf("Mint %d: %v", i, err)
		}
	}

	if len(nonces) != 3 {
		t.Fatalf("saw %d mints, want 3", len(nonces))
	}
	seen := map[string]bool{}
	for i, nonce := range nonces {
		if seen[nonce] {
			t.Fatalf("nonce %d repeated (%q); the server records a nonce single-use, so a reused one is refused as replayed_assertion", i, nonce)
		}
		seen[nonce] = true
	}
	for i, serial := range serials {
		if serial != "7" {
			t.Fatalf("mint %d sent serial %#v, want the stable \"7\"", i, serial)
		}
	}
}

// TestRefusalCarriesTheReason is R19a's input: the host must be able to name
// why the bridge refused instead of collapsing every cause into one message.
func TestRefusalCarriesTheReason(t *testing.T) {
	cases := []struct {
		status  int
		reason  string
		message string
	}{
		{http.StatusForbidden, bridge.ReasonCredentialEpochMoved, "This account's credentials were reset."},
		{http.StatusForbidden, bridge.ReasonUnknownSerial, "This certificate was not issued by this server."},
		{http.StatusForbidden, bridge.ReasonCertificateExpired, "This certificate has expired."},
		{http.StatusForbidden, bridge.ReasonPrincipalMismatch, "The certificate's principal does not match."},
		{http.StatusForbidden, bridge.ReasonFingerprintMismatch, "The certificate's public key does not match."},
		{http.StatusForbidden, bridge.ReasonAccountDeleted, "This account has been deleted."},
		{http.StatusForbidden, bridge.ReasonUnverified, "This account is not verified."},
		{http.StatusForbidden, bridge.ReasonReplayedAssertion, "This assertion was already used."},
		{http.StatusForbidden, bridge.ReasonStaleAssertion, "This assertion is outside its acceptance window."},
		{http.StatusBadRequest, "invalid_nonce", "malformed"},
	}

	for _, tc := range cases {
		t.Run(tc.reason, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(tc.status)
				_, _ = io.WriteString(w, `{"error":{"key":"bridge_refused","reason":"`+tc.reason+`","message":"`+tc.message+`"}}`)
			}))
			defer srv.Close()

			client, err := bridge.New(srv.URL, "cred")
			if err != nil {
				t.Fatalf("New: %v", err)
			}

			_, err = client.Mint(context.Background(), bridge.MintRequest{
				Serial: 1, Principal: "jordan", Fingerprint: "SHA256:x",
			})

			refusal, ok := bridge.IsRefusal(err)
			if !ok {
				t.Fatalf("err = %v, want a *bridge.Refusal", err)
			}
			if refusal.Reason != tc.reason {
				t.Errorf("reason = %q, want %q", refusal.Reason, tc.reason)
			}
			if refusal.Message != tc.message {
				t.Errorf("message = %q, want %q", refusal.Message, tc.message)
			}
			if refusal.Status != tc.status {
				t.Errorf("status = %d, want %d", refusal.Status, tc.status)
			}
		})
	}
}

// TestCredentialRefusalIsARefusal keeps the plug's uniform 401 in the refusal
// family so a bad credential is terminal rather than retried for a minute.
func TestCredentialRefusalIsARefusal(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = io.WriteString(w, `{"error":{"key":"bridge_unauthorized","reason":"bad_credential","message":"The bridge credential is missing or incorrect."}}`)
	}))
	defer srv.Close()

	client, err := bridge.New(srv.URL, "wrong")
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	_, err = client.Mint(context.Background(), bridge.MintRequest{Serial: 1, Principal: "p", Fingerprint: "SHA256:x"})

	refusal, ok := bridge.IsRefusal(err)
	if !ok {
		t.Fatalf("err = %v, want a *bridge.Refusal", err)
	}
	if refusal.Key != "bridge_unauthorized" {
		t.Errorf("key = %q", refusal.Key)
	}
}

// TestTransportFailureIsNotARefusal is the renewal loop's branch: a refusal is
// terminal, a transport failure is worth retrying inside the window.
func TestTransportFailureIsNotARefusal(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	client, err := bridge.New(srv.URL, "cred")
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	_, err = client.Mint(context.Background(), bridge.MintRequest{Serial: 1, Principal: "p", Fingerprint: "SHA256:x"})
	if err == nil {
		t.Fatal("a 500 was accepted as a mint")
	}
	if _, ok := bridge.IsRefusal(err); ok {
		t.Fatalf("a 500 was classified as a refusal: %v", err)
	}
}

// TestErrorsNeverCarryTheCredentialOrToken is the logging guard.
func TestErrorsNeverCarryTheCredentialOrToken(t *testing.T) {
	const secretCredential = "credential-that-must-not-appear"
	const secretToken = "token-that-must-not-appear"

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"access_token":"`+secretToken+`","token_type":"Bearer","expires_in":900,"username":"jordan"}`)
	}))
	defer srv.Close()

	client, err := bridge.New(srv.URL, secretCredential)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	minted, err := client.Mint(context.Background(), bridge.MintRequest{Serial: 1, Principal: "p", Fingerprint: "SHA256:x"})
	if err != nil {
		t.Fatalf("Mint: %v", err)
	}
	if strings.Contains(minted.String(), secretToken) {
		t.Fatalf("Minted.String leaked the token: %q", minted.String())
	}
	if strings.Contains(client.Endpoint(), secretCredential) {
		t.Fatalf("Endpoint leaked the credential: %q", client.Endpoint())
	}
}

// TestNewValidatesInput fails closed rather than constructing a client that can
// only ever produce 401s.
func TestNewValidatesInput(t *testing.T) {
	cases := []struct {
		name       string
		baseURL    string
		credential string
	}{
		{"empty credential", "http://127.0.0.1:4100", ""},
		{"blank credential", "http://127.0.0.1:4100", "   "},
		{"no scheme", "127.0.0.1:4100", "cred"},
		{"bad scheme", "ftp://127.0.0.1:4100", "cred"},
		{"no host", "http://", "cred"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := bridge.New(tc.baseURL, tc.credential); err == nil {
				t.Fatal("New accepted an unusable configuration")
			}
		})
	}
}

// TestLoadCredentialUnlinks is the R12a half that lives in this package: after
// boot the credential path is not merely unmentioned, it is unopenable.
func TestLoadCredentialUnlinks(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "bridge-credential")
	if err := os.WriteFile(path, []byte("  the-bridge-credential\n"), 0o600); err != nil {
		t.Fatalf("write credential: %v", err)
	}

	credential, err := bridge.LoadCredential(path, false)
	if err != nil {
		t.Fatalf("LoadCredential: %v", err)
	}
	if credential != "the-bridge-credential" {
		t.Fatalf("credential = %q, want the trimmed value", credential)
	}

	f, err := os.Open(path)
	if err == nil {
		f.Close() //nolint:errcheck // test
		t.Fatalf("the credential at %s is still openable after boot; a same-UID client process could read it (R12a)", path)
	}
	if !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("open err = %v, want os.ErrNotExist", err)
	}
}

// TestLoadCredentialFailsClosed covers the missing and empty cases: the host
// must not start with a credential it cannot vouch for.
func TestLoadCredentialFailsClosed(t *testing.T) {
	dir := t.TempDir()
	missing := filepath.Join(dir, "absent")
	if _, err := bridge.LoadCredential(missing, false); err == nil {
		t.Fatal("a missing credential file was accepted")
	}

	empty := filepath.Join(dir, "empty")
	if err := os.WriteFile(empty, []byte("\n\n"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	if _, err := bridge.LoadCredential(empty, false); err == nil {
		t.Fatal("an empty credential file was accepted")
	}
	if _, err := bridge.LoadCredential("", false); err == nil {
		t.Fatal("an empty path was accepted")
	}
}
