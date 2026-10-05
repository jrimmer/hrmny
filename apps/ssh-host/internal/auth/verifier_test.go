package auth_test

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"encoding/pem"
	"errors"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"charm.land/ssh"
	"github.com/jrimmer/hrmny/apps/ssh-host/internal/auth"
	gossh "golang.org/x/crypto/ssh"
)

// ---------------------------------------------------------------------------
// Fixtures: a throwaway CA and certificates built from it.
//
// The real signer is U1's (Elixir); these fixtures use x/crypto's own
// Certificate.SignCert, which is the same primitive any conforming issuer
// produces, so a certificate that passes here is a certificate the verifier
// accepts on the wire.
// ---------------------------------------------------------------------------

type ca struct {
	signer  gossh.Signer
	public  gossh.PublicKey
	comment string
}

func newCA(t *testing.T) ca {
	t.Helper()
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate CA key: %v", err)
	}
	signer, err := gossh.NewSignerFromKey(priv)
	if err != nil {
		t.Fatalf("CA signer: %v", err)
	}
	return ca{signer: signer, public: signer.PublicKey()}
}

func newUserKey(t *testing.T) gossh.Signer {
	t.Helper()
	signer, _ := newUserKeyPair(t)
	return signer
}

// newUserKeyPair returns a signer and the same key in OpenSSH private-key PEM
// form, which the host-key loading tests need.
func newUserKeyPair(t *testing.T) (gossh.Signer, []byte) {
	t.Helper()
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate user key: %v", err)
	}
	signer, err := gossh.NewSignerFromKey(priv)
	if err != nil {
		t.Fatalf("user signer: %v", err)
	}
	block, err := gossh.MarshalPrivateKey(priv, "")
	if err != nil {
		t.Fatalf("marshal private key: %v", err)
	}
	return signer, pem.EncodeToMemory(block)
}

// certSpec describes a certificate, with a zero value meaning "a valid one for
// jordan".
type certSpec struct {
	certType     uint32
	principals   []string
	validAfter   time.Time
	validBefore  time.Time
	critical     map[string]string
	indefinite   bool
	serial       uint64
	authorityKey gossh.Signer
	subjectKey   gossh.Signer
}

func (s certSpec) build(t *testing.T, fallback gossh.Signer) gossh.PublicKey {
	t.Helper()

	if s.certType == 0 {
		s.certType = gossh.UserCert
	}
	if s.serial == 0 {
		s.serial = 4242
	}
	if s.principals == nil {
		s.principals = []string{"jordan"}
	}
	if s.validAfter.IsZero() {
		s.validAfter = time.Now().Add(-time.Minute)
	}
	if s.validBefore.IsZero() && !s.indefinite {
		s.validBefore = time.Now().Add(24 * time.Hour)
	}
	if s.authorityKey == nil {
		s.authorityKey = fallback
	}
	if s.subjectKey == nil {
		s.subjectKey = newUserKey(t)
	}

	validBefore := uint64(s.validBefore.Unix())
	if s.indefinite {
		validBefore = gossh.CertTimeInfinity
	}

	certificate := &gossh.Certificate{
		Key:             s.subjectKey.PublicKey(),
		Serial:          s.serial,
		CertType:        s.certType,
		KeyId:           "cytale-test",
		ValidPrincipals: s.principals,
		ValidAfter:      uint64(s.validAfter.Unix()),
		ValidBefore:     validBefore,
		Permissions: gossh.Permissions{
			CriticalOptions: s.critical,
			Extensions:      map[string]string{},
		},
		Reserved: []byte{},
	}
	if err := certificate.SignCert(rand.Reader, s.authorityKey); err != nil {
		t.Fatalf("sign certificate: %v", err)
	}
	return certificate
}

// fakeConn is the ConnMetadata the callback sees: the requested login name and
// nothing else that matters here.
type fakeConn struct{ user string }

func (c fakeConn) User() string          { return c.user }
func (c fakeConn) SessionID() []byte     { return []byte("fake-session-id") }
func (c fakeConn) ClientVersion() []byte { return []byte("SSH-2.0-test-client") }
func (c fakeConn) ServerVersion() []byte { return []byte("SSH-2.0-cytale-ssh-host") }
func (c fakeConn) RemoteAddr() net.Addr {
	return &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 51000}
}
func (c fakeConn) LocalAddr() net.Addr {
	return &net.TCPAddr{IP: net.IPv4(10, 0, 0, 1), Port: 2222}
}

func verifierFor(t *testing.T, authorities ...gossh.PublicKey) *auth.Verifier {
	t.Helper()
	v, err := auth.NewVerifier(authorities)
	if err != nil {
		t.Fatalf("NewVerifier: %v", err)
	}
	return v
}

// ---------------------------------------------------------------------------
// The happy path
// ---------------------------------------------------------------------------

// TestValidCertificateAuthenticatesAndCarriesIdentity is the core assertion:
// a certificate from the trusted CA with a principal equal to the requested
// login name authenticates, and the verified identity reaches the permissions
// the transport stores.
func TestValidCertificateAuthenticatesAndCarriesIdentity(t *testing.T) {
	authority := newCA(t)
	subject := newUserKey(t)
	certificate := certSpec{authorityKey: authority.signer, subjectKey: subject, serial: 777}

	v := verifierFor(t, authority.public)
	perms, err := v.Authenticate(fakeConn{user: "jordan"}, certificate.build(t, authority.signer))
	if err != nil {
		t.Fatalf("Authenticate: %v", err)
	}

	identity, err := auth.IdentityFromPermissions(perms)
	if err != nil {
		t.Fatalf("identity did not reach the permissions: %v", err)
	}
	if identity.Serial != 777 {
		t.Errorf("serial = %d, want 777 (the bridge looks the issuance up by this value)", identity.Serial)
	}
	if identity.Principal != "jordan" {
		t.Errorf("principal = %q, want jordan", identity.Principal)
	}
	wantFingerprint := gossh.FingerprintSHA256(subject.PublicKey())
	if identity.Fingerprint != wantFingerprint {
		t.Errorf("fingerprint = %q, want %q", identity.Fingerprint, wantFingerprint)
	}
	if identity.ValidBefore.IsZero() || identity.ValidBefore.Before(time.Now()) {
		t.Errorf("valid_before = %v, want a future timestamp the renewal loop can compare against", identity.ValidBefore)
	}
	if len(perms.CriticalOptions) != 0 {
		t.Errorf("critical options were carried for a clean certificate: %v", perms.CriticalOptions)
	}
	if _, ok := perms.Extensions[auth.IdentityExtensionKey]; !ok {
		t.Fatalf("permissions have no %q entry", auth.IdentityExtensionKey)
	}
}

// TestIdentitySurvivesThePermissionsRoundTrip pins the carriage: the identity
// is a marshalled extension value, so the encoding must survive intact.
func TestIdentitySurvivesThePermissionsRoundTrip(t *testing.T) {
	original := auth.Identity{
		Serial:      99,
		Principal:   "jordan",
		Fingerprint: "SHA256:abcdef",
		KeyID:       "key-1",
		ValidBefore: time.Unix(1757800000, 0).UTC(),
	}
	encoded, err := original.Marshal()
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	decoded, err := auth.ParseIdentity(encoded)
	if err != nil {
		t.Fatalf("ParseIdentity: %v", err)
	}
	if decoded != original {
		t.Fatalf("round trip changed the identity:\n got %+v\nwant %+v", decoded, original)
	}

	// A permissions set with no entry is ErrNoIdentity, not a zero identity that
	// a caller might mistake for a real one.
	if _, err := auth.IdentityFromPermissions(&gossh.Permissions{}); !errors.Is(err, auth.ErrNoIdentity) {
		t.Fatalf("IdentityFromPermissions on empty perms err = %v, want ErrNoIdentity", err)
	}
	if _, err := auth.IdentityFromPermissions(nil); !errors.Is(err, auth.ErrNoIdentity) {
		t.Fatalf("IdentityFromPermissions(nil) err = %v, want ErrNoIdentity", err)
	}
}

// ---------------------------------------------------------------------------
// One refusal per reason
// ---------------------------------------------------------------------------

func TestRefusals(t *testing.T) {
	authority := newCA(t)
	otherAuthority := newCA(t)

	cases := []struct {
		name    string
		spec    certSpec
		wantErr error
		wantSub string
	}{
		{
			name:    "untrusted CA",
			spec:    certSpec{authorityKey: otherAuthority.signer},
			wantSub: "unrecognized authority",
		},
		{
			name:    "host certificate signed by the trusted CA",
			spec:    certSpec{certType: gossh.HostCert},
			wantSub: "cert has type",
		},
		{
			name:    "expired certificate",
			spec:    certSpec{validAfter: time.Now().Add(-2 * time.Hour), validBefore: time.Now().Add(-time.Hour)},
			wantSub: "expired",
		},
		{
			name:    "not yet valid certificate",
			spec:    certSpec{validAfter: time.Now().Add(time.Hour), validBefore: time.Now().Add(2 * time.Hour)},
			wantSub: "not yet valid",
		},
		{
			name:    "principal differs from the login name",
			spec:    certSpec{principals: []string{"someone-else"}},
			wantSub: "not in the set of valid principals",
		},
		{
			name:    "empty principals list",
			spec:    certSpec{principals: []string{}},
			wantErr: auth.ErrEmptyPrincipals,
		},
		{
			name:    "indefinite validity window",
			spec:    certSpec{indefinite: true},
			wantErr: auth.ErrIndefiniteValidity,
		},
		{
			name:    "source-address critical option",
			spec:    certSpec{critical: map[string]string{"source-address": "127.0.0.1/32"}},
			wantErr: auth.ErrCriticalOptions,
		},
		{
			name:    "force-command critical option",
			spec:    certSpec{critical: map[string]string{"force-command": "/bin/true"}},
			wantSub: "unsupported critical option",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			v := verifierFor(t, authority.public)
			perms, err := v.Authenticate(fakeConn{user: "jordan"}, tc.spec.build(t, authority.signer))
			if err == nil {
				t.Fatal("certificate authenticated; it must be refused")
			}
			if perms != nil {
				t.Fatalf("a refused certificate returned permissions: %+v", perms)
			}
			if tc.wantErr != nil && !errors.Is(err, tc.wantErr) {
				t.Fatalf("err = %v, want %v", err, tc.wantErr)
			}
			if tc.wantSub != "" && !strings.Contains(err.Error(), tc.wantSub) {
				t.Fatalf("err = %v, want it to mention %q", err, tc.wantSub)
			}
		})
	}
}

// TestSourceAddressIsTheGapThisPackageCloses documents the reason
// ErrCriticalOptions exists rather than trusting CertChecker alone: a bare
// Authenticate with empty SupportedCriticalOptions still ACCEPTS source-address,
// because the override it appends is what admits it. Without this package's
// reject, a certificate pinning an address would authenticate here and rely on
// the transport's loop for enforcement the host never configured.
func TestSourceAddressIsTheGapThisPackageCloses(t *testing.T) {
	authority := newCA(t)
	certificate := certSpec{
		critical:     map[string]string{"source-address": "127.0.0.1/32"},
		authorityKey: authority.signer,
	}.build(t, authority.signer)

	bare := &gossh.CertChecker{
		IsUserAuthority: func(key gossh.PublicKey) bool {
			return string(key.Marshal()) == string(authority.public.Marshal())
		},
	}
	if _, err := bare.Authenticate(fakeConn{user: "jordan"}, certificate); err != nil {
		t.Fatalf("a bare CertChecker refused source-address (%v); the fixture no longer demonstrates the gap this package closes", err)
	}

	v := verifierFor(t, authority.public)
	if _, err := v.Authenticate(fakeConn{user: "jordan"}, certificate); !errors.Is(err, auth.ErrCriticalOptions) {
		t.Fatalf("err = %v, want ErrCriticalOptions", err)
	}
}

// TestEmptyPrincipalsIsAWildcardDownstream documents the second gap: the
// underlying check treats an empty principal list as valid for every login.
func TestEmptyPrincipalsIsAWildcardDownstream(t *testing.T) {
	authority := newCA(t)
	certificate := certSpec{principals: []string{}, authorityKey: authority.signer}.build(t, authority.signer)

	bare := &gossh.CertChecker{
		IsUserAuthority: func(key gossh.PublicKey) bool {
			return string(key.Marshal()) == string(authority.public.Marshal())
		},
	}
	if err := bare.CheckCert("anyone-at-all", certificate.(*gossh.Certificate)); err != nil {
		t.Fatalf("CheckCert refused an empty-principal certificate (%v); the fixture no longer demonstrates the wildcard", err)
	}

	v := verifierFor(t, authority.public)
	if _, err := v.Authenticate(fakeConn{user: "anyone-at-all"}, certificate); !errors.Is(err, auth.ErrEmptyPrincipals) {
		t.Fatalf("err = %v, want ErrEmptyPrincipals", err)
	}
}

// TestPlainPublicKeyIsRefused is the UserKeyFallback-is-nil scenario: a bare
// key with no certificate is not a login on this host.
func TestPlainPublicKeyIsRefused(t *testing.T) {
	authority := newCA(t)
	v := verifierFor(t, authority.public)

	if _, err := v.Authenticate(fakeConn{user: "jordan"}, newUserKey(t).PublicKey()); !errors.Is(err, auth.ErrNotACertificate) {
		t.Fatalf("err = %v, want ErrNotACertificate", err)
	}
}

// TestMultipleAuthoritiesKeepTheWholeTrustSet proves IsUserAuthority compares
// against the configured set rather than its first member.
func TestMultipleAuthoritiesKeepTheWholeTrustSet(t *testing.T) {
	first := newCA(t)
	second := newCA(t)
	untrusted := newCA(t)

	v := verifierFor(t, first.public, second.public)

	for name, authority := range map[string]ca{"first": first, "second": second} {
		t.Run(name, func(t *testing.T) {
			perms, err := v.Authenticate(fakeConn{user: "jordan"}, certSpec{authorityKey: authority.signer}.build(t, authority.signer))
			if err != nil {
				t.Fatalf("Authenticate: %v", err)
			}
			if _, err := auth.IdentityFromPermissions(perms); err != nil {
				t.Fatalf("identity missing: %v", err)
			}
		})
	}

	if _, err := v.Authenticate(fakeConn{user: "jordan"}, certSpec{authorityKey: untrusted.signer}.build(t, untrusted.signer)); err == nil {
		t.Fatal("a certificate from a CA outside the trust set authenticated")
	}
}

// TestAlgorithmFamilyIsPinnedToTheCA asserts the wiring step that narrows
// authentication to what the host can verify. An empty list would be treated as
// "use the defaults" by x/crypto — a silent widening — so this also pins the
// non-empty case.
func TestAlgorithmFamilyIsPinnedToTheCA(t *testing.T) {
	authority := newCA(t)
	v := verifierFor(t, authority.public)

	algorithms := v.PublicKeyAuthAlgorithms()
	if len(algorithms) == 0 {
		t.Fatal("no algorithms pinned; x/crypto would fall back to its defaults")
	}
	if len(algorithms) != 1 || algorithms[0] != gossh.KeyAlgoED25519 {
		t.Fatalf("algorithms = %v, want [ssh-ed25519] for an ed25519 CA", algorithms)
	}

	// The returned slice is a copy: a caller cannot widen the pin in place.
	algorithms[0] = "ssh-rsa"
	if v.PublicKeyAuthAlgorithms()[0] != gossh.KeyAlgoED25519 {
		t.Fatal("PublicKeyAuthAlgorithms returned its own slice")
	}
}

func TestNewVerifierRequiresATrustSet(t *testing.T) {
	if _, err := auth.NewVerifier(nil); err == nil {
		t.Fatal("NewVerifier accepted an empty trust set")
	}
}

// ---------------------------------------------------------------------------
// The boot assertion
// ---------------------------------------------------------------------------

// TestAssertVerifierWiredFailsOnTheFailOpen is R11's assertion: the fork sets
// NoClientAuth when every handler and callback is nil, which accepts every
// connection without authentication.
func TestAssertVerifierWiredFailsOnTheFailOpen(t *testing.T) {
	// The exact shape the fork turns into NoClientAuth = true.
	if err := auth.AssertVerifierWired(&ssh.Server{}, &gossh.ServerConfig{}); err == nil {
		t.Fatal("the assert passed on the fail-open shape")
	}

	// An explicit NoClientAuth is a failure even when a callback exists.
	if err := auth.AssertVerifierWired(&ssh.Server{}, &gossh.ServerConfig{
		NoClientAuth:      true,
		PublicKeyCallback: func(gossh.ConnMetadata, gossh.PublicKey) (*gossh.Permissions, error) { return nil, nil },
	}); err == nil {
		t.Fatal("the assert passed with NoClientAuth true")
	}

	// A nil config means the verifier never got registered at all.
	if err := auth.AssertVerifierWired(&ssh.Server{}, nil); err == nil {
		t.Fatal("the assert passed with no server config")
	}
}

// TestAssertVerifierWiredPassesForTheRealShape is the other half: the wiring
// the host actually builds must satisfy the assert, or boot fails for the wrong
// reason.
func TestAssertVerifierWiredPassesForTheRealShape(t *testing.T) {
	authority := newCA(t)
	v := verifierFor(t, authority.public)

	srv := &ssh.Server{}
	cfg := &gossh.ServerConfig{
		PublicKeyCallback:       v.Authenticate,
		PublicKeyAuthAlgorithms: v.PublicKeyAuthAlgorithms(),
		MaxAuthTries:            3,
	}
	if err := auth.AssertVerifierWired(srv, cfg); err != nil {
		t.Fatalf("AssertVerifierWired: %v", err)
	}
}

// TestAssertVerifierWiredFailsWhenTheCallbackIsShadowed is the subtle one: the
// fork REPLACES ServerConfig.PublicKeyCallback when Server.PublicKeyHandler is
// set, which would discard the certificate verification seam while still
// authenticating something.
func TestAssertVerifierWiredFailsWhenTheShadowed(t *testing.T) {
	authority := newCA(t)
	v := verifierFor(t, authority.public)

	srv := &ssh.Server{
		PublicKeyHandler: func(ssh.Context, ssh.PublicKey) bool { return true },
	}
	cfg := &gossh.ServerConfig{PublicKeyCallback: v.Authenticate}
	if err := auth.AssertVerifierWired(srv, cfg); err == nil {
		t.Fatal("the assert passed with Server.PublicKeyHandler set; the fork would shadow the verifier")
	}
}

// TestAssertVerifierWiredRefusesASecondAuthMethod keeps a password or
// keyboard-interactive path from appearing beside the certificate login.
func TestAssertVerifierWiredRefusesASecondAuthMethod(t *testing.T) {
	authority := newCA(t)
	v := verifierFor(t, authority.public)

	base := func() *gossh.ServerConfig {
		return &gossh.ServerConfig{PublicKeyCallback: v.Authenticate}
	}

	if err := auth.AssertVerifierWired(&ssh.Server{
		PasswordHandler: func(ssh.Context, string) bool { return false },
	}, base()); err == nil {
		t.Fatal("the assert passed with a password handler")
	}
	if err := auth.AssertVerifierWired(&ssh.Server{}, &gossh.ServerConfig{
		PublicKeyCallback: v.Authenticate,
		KeyboardInteractiveCallback: func(gossh.ConnMetadata, gossh.KeyboardInteractiveChallenge) (*gossh.Permissions, error) {
			return nil, nil
		},
	}); err == nil {
		t.Fatal("the assert passed with a keyboard-interactive callback")
	}
}

// ---------------------------------------------------------------------------
// Boot-time key material
// ---------------------------------------------------------------------------

func TestLoadCAPublicKeys(t *testing.T) {
	dir := t.TempDir()
	first := newCA(t)
	second := newCA(t)

	body := "# the test CA\n" +
		strings.TrimSpace(string(gossh.MarshalAuthorizedKey(first.public))) + " comment\n\n" +
		strings.TrimSpace(string(gossh.MarshalAuthorizedKey(second.public))) + "\n"
	path := filepath.Join(dir, "ca.pub")
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}

	keys, err := auth.LoadCAPublicKeys(path)
	if err != nil {
		t.Fatalf("LoadCAPublicKeys: %v", err)
	}
	if len(keys) != 2 {
		t.Fatalf("loaded %d keys, want 2", len(keys))
	}

	v := verifierFor(t, keys...)
	if _, err := v.Authenticate(fakeConn{user: "jordan"}, certSpec{authorityKey: second.signer}.build(t, second.signer)); err != nil {
		t.Fatalf("a CA read from the file did not authenticate: %v", err)
	}

	// The CA public key stays on disk: it is not secret, and only the host
	// private key and the bridge credential are read once and unlinked.
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("the CA public key file was removed: %v", err)
	}
}

func TestLoadCAPublicKeysFailsClosed(t *testing.T) {
	dir := t.TempDir()

	if _, err := auth.LoadCAPublicKeys(filepath.Join(dir, "missing")); err == nil {
		t.Fatal("a missing CA key file was accepted")
	}

	empty := filepath.Join(dir, "empty")
	if err := os.WriteFile(empty, []byte("# only a comment\n"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	if _, err := auth.LoadCAPublicKeys(empty); err == nil {
		t.Fatal("a CA key file with no keys was accepted")
	}

	garbage := filepath.Join(dir, "garbage")
	if err := os.WriteFile(garbage, []byte("not a key at all\n"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	if _, err := auth.LoadCAPublicKeys(garbage); err == nil {
		t.Fatal("a malformed CA key file was accepted")
	}

	if _, err := auth.LoadCAPublicKeys(""); err == nil {
		t.Fatal("an empty CA key path was accepted")
	}
}

// TestLoadHostKeyUnlinks is R12a for the host key: after boot the path is not
// merely unmentioned, it is unopenable.
func TestLoadHostKeyUnlinks(t *testing.T) {
	dir := t.TempDir()
	signer, privatePEM := newUserKeyPair(t)

	path := filepath.Join(dir, "ssh_host_ed25519_key")
	if err := os.WriteFile(path, privatePEM, 0o600); err != nil {
		t.Fatalf("write host key: %v", err)
	}

	loaded, err := auth.LoadHostKey(path, false)
	if err != nil {
		t.Fatalf("LoadHostKey: %v", err)
	}
	if string(loaded.PublicKey().Marshal()) != string(signer.PublicKey().Marshal()) {
		t.Fatal("LoadHostKey returned a different key")
	}

	f, err := os.Open(path)
	if err == nil {
		f.Close() //nolint:errcheck // test
		t.Fatalf("the host key at %s is still openable after boot; a same-UID client process could read it (R12a)", path)
	}
	if !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("open err = %v, want os.ErrNotExist", err)
	}
}

// TestLoadHostKeyRetainIsTheDistinctUIDPosture covers the one documented
// alternative: a deployment that cannot unlink runs the client under a distinct
// uid and keeps the file.
func TestLoadHostKeyRetainIsTheDistinctUIDPosture(t *testing.T) {
	dir := t.TempDir()
	_, privatePEM := newUserKeyPair(t)
	path := filepath.Join(dir, "host_key")
	if err := os.WriteFile(path, privatePEM, 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}

	if _, err := auth.LoadHostKey(path, true); err != nil {
		t.Fatalf("LoadHostKey(retain): %v", err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("the retained host key was removed: %v", err)
	}
}

func TestLoadHostKeyFailsClosed(t *testing.T) {
	dir := t.TempDir()

	if _, err := auth.LoadHostKey(filepath.Join(dir, "missing"), false); err == nil {
		t.Fatal("a missing host key was accepted")
	}

	garbage := filepath.Join(dir, "garbage")
	if err := os.WriteFile(garbage, []byte("this is not a private key\n"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	if _, err := auth.LoadHostKey(garbage, false); err == nil {
		t.Fatal("a malformed host key was accepted")
	}
	if _, err := auth.LoadHostKey("", false); err == nil {
		t.Fatal("an empty host key path was accepted")
	}
}

// TestIdentityMarshalsAsJSONWithoutCertificateContents keeps the extension
// entry small and free of the certificate itself. Nothing about a certificate's
// contents belongs in a permissions map that travels further than the verifier.
func TestIdentityMarshalsAsJSONWithoutCertificateContents(t *testing.T) {
	authority := newCA(t)
	v := verifierFor(t, authority.public)
	perms, err := v.Authenticate(fakeConn{user: "jordan"}, certSpec{authorityKey: authority.signer}.build(t, authority.signer))
	if err != nil {
		t.Fatalf("Authenticate: %v", err)
	}

	raw := perms.Extensions[auth.IdentityExtensionKey]
	var decoded map[string]any
	if err := json.Unmarshal([]byte(raw), &decoded); err != nil {
		t.Fatalf("identity is not JSON: %v", err)
	}
	wantFields := map[string]bool{
		"serial": true, "principal": true, "fingerprint": true,
		"key_id": true, "valid_before": true,
	}
	for field := range decoded {
		if !wantFields[field] {
			t.Errorf("identity carries an unexpected field %q", field)
		}
	}
	for field := range wantFields {
		if _, ok := decoded[field]; !ok && field != "key_id" {
			t.Errorf("identity is missing %q", field)
		}
	}
	if strings.Contains(raw, "PRIVATE") || strings.Contains(raw, "signature") {
		t.Fatalf("identity extension carries key material: %s", raw)
	}
}
