// Package e2e is U17's proof half for the SSH host: the scenarios that need a
// real SSH client and a real host process, but NOT a live Cytale server.
//
// # What this file is, and what it is not
//
// The unit's end-to-end script (`scripts/ssh-host-e2e.sh`) drives a real `ssh`
// binary against a real host process and, in its composed mode, against the
// composed stack. This file is the in-process half of the same proof: a real
// `x/crypto/ssh` client, a real certificate, a real listener, and a real child
// process — all inside one `go test` run, so every claim below is checked on
// every invocation rather than only when a deployment is standing.
//
// Two substitutes are deliberate, and both are named so no reader mistakes them
// for the product:
//
//   - the **bridge** is an in-process HTTP double that speaks the committed wire
//     contract (header `x-cytale-bridge-credential`, body
//     `{serial, principal, fingerprint, nonce, asserted_at}`, success
//     `{access_token, token_type, expires_in, username}`, refusal 400/403
//     `{error:{key, reason, message}}`). The host's own behaviour — that it asks,
//     that it honours a refusal, that it ends the session with the right reason —
//     is what the assertions are about;
//   - the **origin** is an in-process HTTP double standing in for the Cytale
//     REST surface. It exists so the message path can be proven end to end at
//     all (keystrokes → PTY → child → token → origin → persisted → read back
//     over the API) without a Cytale server. The real server's persistence is
//     the composed end-to-end script's job, and this file does not claim it.
//
// The child process is this test binary re-executed in a helper mode. It is a
// fixture client, not the product client: it reads the token descriptor, draws a
// two-column frame (so "renders the two-column shell with a seeded channel
// visible" has an actual subject to assert on), watches the descriptor for
// renewals and the end frame, and reports the PTY's size. The product client is
// `apps/tui`, and its own suite owns its rendering.
//
// # The certificates are real, and so is the keypair shape
//
// The client keypair is written in the container the web surface emits
// (`apps/web/src/features/ssh/keygen.ts`): an unencrypted `openssh-key-v1` PEM.
// That shape is asserted byte-structurally here and handed to Go's own OpenSSH
// parser — the parser `ssh -i` agrees with — because a private key a member
// installs that OpenSSH will not read is indistinguishable, to them, from a
// broken certificate.
//
// # The negative control
//
// The host's trust boundary is not `x/crypto`'s default. `CertChecker` treats an
// empty principals list as "valid for all users", exempts `CertTimeInfinity`
// from the expiry check, and accepts `source-address` because the transport
// enforces it. TestTheGuardsAreLoadBearingCertificate controls exactly that: the
// certificates this host refuses are shown to be ACCEPTED by a bare
// `CertChecker`, so the refusals are the guard's work and not the library's.
package e2e

import (
	"bufio"
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
	"unsafe"

	gossh "golang.org/x/crypto/ssh"

	"github.com/jrimmer/hrmny/apps/ssh-host/internal/auth"
	"github.com/jrimmer/hrmny/apps/ssh-host/internal/bridge"
	"github.com/jrimmer/hrmny/apps/ssh-host/internal/session"
)

// Test constants, named so the assertions read as statements.
const (
	// loginName is the member the certificate is issued to. The certificate's
	// principal and the SSH login name must be the same string (R10).
	loginName = "jordan"

	// serial is non-zero on purpose. The host carries the certificate's serial in
	// the identity it hands the session, and `auth.ParseIdentity` refuses a
	// serial of 0 — which is exactly what `ssh-keygen -s` writes when it is not
	// given `-z`. A harness that signs with the default therefore produces a
	// certificate that authenticates and is THEN refused as `identity_missing`,
	// and the text the member sees is the same "Permission denied (publickey)" a
	// wrong login name produces. Signing with an explicit serial here is what
	// keeps that confusion out of this suite; `scripts/ssh-host-e2e.sh` carries
	// the same note, because it signs with the real `ssh-keygen`.
	serial = 900001

	// channelName is the channel the fixture's two-column frame shows, so the
	// "two-column shell with a seeded channel visible" assertion has a subject.
	channelName = "#general"

	// frameNavWidth is the navigation column's width in the fixture's frame.
	frameNavWidth = 12
)

// ---------------------------------------------------------------------------
// The trust set: a throwaway CA and real certificates
// ---------------------------------------------------------------------------

type authority struct {
	signer gossh.Signer
	public gossh.PublicKey
}

func newAuthority(t *testing.T) authority {
	t.Helper()
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate CA key: %v", err)
	}
	signer, err := gossh.NewSignerFromKey(priv)
	if err != nil {
		t.Fatalf("CA signer: %v", err)
	}
	return authority{signer: signer, public: signer.PublicKey()}
}

func newSubject(t *testing.T) gossh.Signer {
	t.Helper()
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate client key: %v", err)
	}
	signer, err := gossh.NewSignerFromKey(priv)
	if err != nil {
		t.Fatalf("client signer: %v", err)
	}
	return signer
}

// certificate signs a user certificate over the subject for one principal.
func certificate(t *testing.T, ca authority, subject gossh.Signer, principal string, notBefore, notAfter time.Time, tweak func(*gossh.Certificate)) *gossh.Certificate {
	t.Helper()
	cert := &gossh.Certificate{
		Key:             subject.PublicKey(),
		Serial:          serial,
		CertType:        gossh.UserCert,
		KeyId:           "cytale-u17-e2e",
		ValidPrincipals: []string{principal},
		ValidAfter:      uint64(notBefore.Unix()),
		ValidBefore:     uint64(notAfter.Unix()),
		Permissions:     gossh.Permissions{CriticalOptions: map[string]string{}, Extensions: map[string]string{}},
		Reserved:        []byte{},
	}
	if tweak != nil {
		tweak(cert)
	}
	if err := cert.SignCert(rand.Reader, ca.signer); err != nil {
		t.Fatalf("sign certificate: %v", err)
	}
	return cert
}

// certified pairs a certificate with the private key it certifies — the pair
// `ssh -i` presents from `<private>` and `<private>-cert.pub`.
func certified(t *testing.T, cert *gossh.Certificate, subject gossh.Signer) gossh.Signer {
	t.Helper()
	signer, err := gossh.NewCertSigner(cert, subject)
	if err != nil {
		t.Fatalf("NewCertSigner: %v", err)
	}
	return signer
}

// ---------------------------------------------------------------------------
// The web surface's private key container
//
// This mirrors apps/web/src/features/ssh/keygen.ts field for field: the
// `openssh-key-v1` magic, the `none`/`none` cipher and KDF, the FULL public blob
// in the outer position and the BARE 32-byte point inside the private section,
// the check integer written twice, and padding 1..n to the 8-byte block. The
// asymmetry between the two public-key positions is the format's own trap, so it
// is asserted rather than assumed.
// ---------------------------------------------------------------------------

const (
	webAuthMagic    = "openssh-key-v1\x00"
	webPrivateBlock = 8
	webKeyComment   = "cytale"

	// webPKCS8SeedPrefixHex is the fixed 16-byte PKCS#8 prelude WebCrypto emits
	// for a bare ed25519 key. keygen.ts slices the 32-byte seed out of exactly
	// this prefix and refuses to write a file when it does not match.
	webPKCS8SeedPrefixHex = "302e020100300506032b657004220420"
)

// webSurfaceKeypair writes the member's keypair the way the web surface does and
// returns the PEM file contents, the public-key line, and a signer.
func webSurfaceKeypair(t *testing.T) (pemBytes []byte, publicLine string, signer gossh.Signer) {
	t.Helper()

	prefix, err := hexBytes(webPKCS8SeedPrefixHex)
	if err != nil {
		t.Fatalf("decode the PKCS#8 prefix: %v", err)
	}
	if len(prefix) != 16 || len(prefix)+ed25519.SeedSize != 48 {
		t.Fatalf("the PKCS#8 prelude is %d bytes, want 16 so that the seed lands at 48", len(prefix))
	}

	seed := make([]byte, ed25519.SeedSize)
	if _, err := io.ReadFull(rand.Reader, seed); err != nil {
		t.Fatalf("read seed: %v", err)
	}
	point := ed25519.NewKeyFromSeed(seed).Public().(ed25519.PublicKey)

	var checkBytes [4]byte
	if _, err := io.ReadFull(rand.Reader, checkBytes[:]); err != nil {
		t.Fatalf("read check integer: %v", err)
	}
	check := binary.BigEndian.Uint32(checkBytes[:])

	pemBytes = pemArmor("OPENSSH PRIVATE KEY", webContainer(check, seed, point, webKeyComment))

	// The decisive consumer of this file is OpenSSH's own parser.
	signer, err = gossh.ParsePrivateKey(pemBytes)
	if err != nil {
		t.Fatalf("the web surface's private key is not readable as an OpenSSH key: %v", err)
	}
	if !bytes.Equal(signer.PublicKey().Marshal(), webPublicBlob(point)) {
		t.Fatal("the key OpenSSH parsed out of the container is not the key the container advertises")
	}

	publicLine = strings.TrimSpace(string(gossh.MarshalAuthorizedKey(signer.PublicKey()))) + " " + webKeyComment
	return pemBytes, publicLine, signer
}

// webContainer builds the `openssh-key-v1` container exactly as keygen.ts does.
func webContainer(check uint32, seed, point []byte, comment string) []byte {
	var out bytes.Buffer
	out.WriteString(webAuthMagic)
	out.Write(sshString([]byte("none")))       // ciphername
	out.Write(sshString([]byte("none")))       // kdfname
	out.Write(sshString(nil))                  // kdfoptions
	out.Write(uint32BE(1))                     // one key
	out.Write(sshString(webPublicBlob(point))) // the FULL blob, outer position
	out.Write(sshString(webPrivateSection(check, seed, point, comment)))
	return out.Bytes()
}

func webPrivateSection(check uint32, seed, point []byte, comment string) []byte {
	var section bytes.Buffer
	section.Write(uint32BE(check))
	section.Write(uint32BE(check)) // twice, and equal: the "none" cipher's only integrity signal
	section.Write(sshString([]byte("ssh-ed25519")))
	section.Write(sshString(point)) // the BARE point this time, not the blob
	section.Write(sshString(append(append([]byte{}, seed...), point...)))
	section.Write(sshString([]byte(comment)))

	padding := (webPrivateBlock - section.Len()%webPrivateBlock) % webPrivateBlock
	for i := 0; i < padding; i++ {
		section.WriteByte(byte(i + 1))
	}
	return section.Bytes()
}

// webPublicBlob is `string("ssh-ed25519") || string(32-byte point)`.
func webPublicBlob(point []byte) []byte {
	var blob bytes.Buffer
	blob.Write(sshString([]byte("ssh-ed25519")))
	blob.Write(sshString(point))
	return blob.Bytes()
}

// pemArmor wraps a body the way keygen.ts does: 70 columns, trailing newline.
func pemArmor(label string, body []byte) []byte {
	encoded := base64.StdEncoding.EncodeToString(body)
	var out bytes.Buffer
	fmt.Fprintf(&out, "-----BEGIN %s-----\n", label)
	for i := 0; i < len(encoded); i += 70 {
		end := i + 70
		if end > len(encoded) {
			end = len(encoded)
		}
		out.WriteString(encoded[i:end])
		out.WriteByte('\n')
	}
	fmt.Fprintf(&out, "-----END %s-----\n", label)
	return out.Bytes()
}

func sshString(value []byte) []byte {
	out := make([]byte, 4, 4+len(value))
	binary.BigEndian.PutUint32(out, uint32(len(value)))
	return append(out, value...)
}

func uint32BE(value uint32) []byte {
	out := make([]byte, 4)
	binary.BigEndian.PutUint32(out, value)
	return out
}

func hexBytes(hex string) ([]byte, error) {
	if len(hex)%2 != 0 {
		return nil, errors.New("odd-length hex")
	}
	out := make([]byte, len(hex)/2)
	for i := 0; i < len(out); i++ {
		parsed, err := strconv.ParseUint(hex[i*2:i*2+2], 16, 8)
		if err != nil {
			return nil, err
		}
		out[i] = byte(parsed)
	}
	return out, nil
}

func readSSHString(reader *bytes.Reader) ([]byte, error) {
	lengthBytes := make([]byte, 4)
	if _, err := io.ReadFull(reader, lengthBytes); err != nil {
		return nil, err
	}
	length := binary.BigEndian.Uint32(lengthBytes)
	if int(length) > reader.Len() {
		return nil, fmt.Errorf("length %d exceeds the %d bytes left", length, reader.Len())
	}
	value := make([]byte, length)
	if _, err := io.ReadFull(reader, value); err != nil {
		return nil, err
	}
	return value, nil
}

// TestTheWebSurfacesKeypairShapeIsWhatTheHostAccepts is the plan's "the
// `-cert.pub` and private key produced by the web surface drive a real
// connection", reduced to what can be proven without a browser: the container
// the web surface emits is structurally what it claims to be, OpenSSH's parser
// reads it, and a certificate over it authenticates against the real host.
//
// The browser-side half — that WebCrypto exports the PKCS#8 prefix the module
// slices — is `apps/web`'s own suite; what is asserted here is every byte after
// that point, plus the connection it drives.
func TestTheWebSurfacesKeypairShapeIsWhatTheHostAccepts(t *testing.T) {
	pemBytes, publicLine, subject := webSurfaceKeypair(t)

	// The container's structure, asserted rather than assumed.
	block, rest := pem.Decode(pemBytes)
	if block == nil || len(rest) != 0 {
		t.Fatal("the emitted file is not one PEM block with nothing after it")
	}
	if block.Type != "OPENSSH PRIVATE KEY" {
		t.Fatalf("PEM label = %q, want OPENSSH PRIVATE KEY (what ssh -i reads)", block.Type)
	}

	reader := bytes.NewReader(block.Bytes)
	magic := make([]byte, len(webAuthMagic))
	if _, err := io.ReadFull(reader, magic); err != nil || string(magic) != webAuthMagic {
		t.Fatalf("container magic = %q, want %q", magic, webAuthMagic)
	}
	for _, field := range []string{"ciphername", "kdfname", "kdfoptions"} {
		value, err := readSSHString(reader)
		if err != nil {
			t.Fatalf("read %s: %v", field, err)
		}
		switch field {
		case "ciphername", "kdfname":
			if string(value) != "none" {
				t.Errorf("%s = %q, want none (an unencrypted key is what the member installs)", field, value)
			}
		case "kdfoptions":
			if len(value) != 0 {
				t.Errorf("kdfoptions is %d bytes, want empty for a none-KDF key", len(value))
			}
		}
	}
	countBytes := make([]byte, 4)
	if _, err := io.ReadFull(reader, countBytes); err != nil {
		t.Fatalf("read the key count: %v", err)
	}
	if count := binary.BigEndian.Uint32(countBytes); count != 1 {
		t.Fatalf("the container holds %d keys, want 1", count)
	}
	outerBlob, err := readSSHString(reader)
	if err != nil {
		t.Fatalf("read the outer public blob: %v", err)
	}
	privateField, err := readSSHString(reader)
	if err != nil {
		t.Fatalf("read the private section: %v", err)
	}
	if reader.Len() != 0 {
		t.Fatalf("the container carries %d trailing bytes", reader.Len())
	}

	// The outer position is the full blob, and it is what the public line and the
	// fingerprint are computed from.
	wantLine := "ssh-ed25519 " + base64.StdEncoding.EncodeToString(outerBlob) + " " + webKeyComment
	if publicLine != wantLine {
		t.Fatalf("public line = %q, want %q", publicLine, wantLine)
	}
	if !bytes.Equal(subject.PublicKey().Marshal(), outerBlob) {
		t.Fatal("the public line's blob is not the key OpenSSH parsed out of the private key")
	}

	// The private section, field for field.
	private := bytes.NewReader(privateField)
	first := make([]byte, 4)
	second := make([]byte, 4)
	if _, err := io.ReadFull(private, first); err != nil {
		t.Fatalf("read the first check integer: %v", err)
	}
	if _, err := io.ReadFull(private, second); err != nil {
		t.Fatalf("read the second check integer: %v", err)
	}
	if !bytes.Equal(first, second) {
		t.Fatal("the two check integers differ; OpenSSH reads that as a wrong passphrase")
	}
	keyType, err := readSSHString(private)
	if err != nil {
		t.Fatalf("read the private section's key type: %v", err)
	}
	if string(keyType) != "ssh-ed25519" {
		t.Fatalf("private section key type = %q", keyType)
	}
	innerPoint, err := readSSHString(private)
	if err != nil {
		t.Fatalf("read the private section's public point: %v", err)
	}
	if len(innerPoint) != ed25519.PublicKeySize {
		t.Fatalf("the private section's public point is %d bytes, want the BARE %d-byte point (not the blob)",
			len(innerPoint), ed25519.PublicKeySize)
	}

	// The outer blob and the inner point must be the same key: the format carries
	// it twice, in two different encodings, and a mismatch is exactly the silent
	// breakage keygen.ts's own suite exists to catch.
	outerReader := bytes.NewReader(outerBlob)
	if _, err := readSSHString(outerReader); err != nil {
		t.Fatalf("read the outer blob's key type: %v", err)
	}
	outerPoint, err := readSSHString(outerReader)
	if err != nil {
		t.Fatalf("read the outer blob's point: %v", err)
	}
	if !bytes.Equal(innerPoint, outerPoint) {
		t.Fatal("the private section's point is not the outer blob's point")
	}
	if outerReader.Len() != 0 {
		t.Fatalf("the outer blob carries %d trailing bytes", outerReader.Len())
	}

	seedAndPoint, err := readSSHString(private)
	if err != nil {
		t.Fatalf("read the seed: %v", err)
	}
	if len(seedAndPoint) != ed25519.PrivateKeySize {
		t.Fatalf("the private key field is %d bytes, want %d (seed then point)",
			len(seedAndPoint), ed25519.PrivateKeySize)
	}
	derived := ed25519.NewKeyFromSeed(seedAndPoint[:ed25519.SeedSize]).Public().(ed25519.PublicKey)
	// bytes.Equal, not ed25519.PublicKey.Equal: the latter type-asserts its
	// argument back to ed25519.PublicKey and returns false for a plain []byte,
	// which would make this assertion fail for the wrong reason.
	if !bytes.Equal(derived, innerPoint) {
		t.Fatal("the seed in the container does not derive the point beside it")
	}
	comment, err := readSSHString(private)
	if err != nil {
		t.Fatalf("read the comment: %v", err)
	}
	if string(comment) != webKeyComment {
		t.Fatalf("comment = %q, want %q", comment, webKeyComment)
	}
	padding := private.Len()
	if padding < 0 || padding >= webPrivateBlock {
		t.Fatalf("padding is %d bytes, want fewer than %d", padding, webPrivateBlock)
	}
	trailing := make([]byte, padding)
	if _, err := io.ReadFull(private, trailing); err != nil {
		t.Fatalf("read the padding: %v", err)
	}
	for i, b := range trailing {
		if b != byte(i+1) {
			t.Fatalf("padding byte %d = %d, want %d (1..n, as OpenSSH writes it)", i, b, i+1)
		}
	}

	// And then: the shape is not merely well-formed, it authenticates. The
	// certificate is signed over the very key this container holds.
	ca := newAuthority(t)
	cert := certificate(t, ca, subject, loginName, time.Now().Add(-time.Minute), time.Now().Add(time.Hour), nil)
	h := startHost(t, hostOptions{ca: ca, scanDirs: []string{t.TempDir()}})

	client, err := dial(t, h.address, loginName, gossh.PublicKeys(certified(t, cert, subject)))
	if err != nil {
		t.Fatalf("a certificate over the web surface's key did not authenticate: %v", err)
	}
	defer client.Close()

	shell := openShell(t, client, 120, 40)
	defer shell.close()

	if _, ok := shell.waitFor("TOKEN ", 10*time.Second); !ok {
		t.Fatalf("the session never carried a token, so the connection did not really land:\n%s\n----- host log -----\n%s", shell.rest(), h.logs.String())
	}
	if got := h.bridge.request(0).body["fingerprint"]; got != gossh.FingerprintSHA256(subject.PublicKey()) {
		t.Fatalf("the bridge was told fingerprint %v, want the web surface's key fingerprint %s",
			got, gossh.FingerprintSHA256(subject.PublicKey()))
	}
}

// ---------------------------------------------------------------------------
// The bridge double: the committed wire contract, over real HTTP
// ---------------------------------------------------------------------------

type bridgeCall struct {
	at     time.Time
	path   string
	header string
	body   map[string]any
}

type bridgeDouble struct {
	server *httptest.Server

	mu    sync.Mutex
	calls []bridgeCall
	reply func(call int, body map[string]any) (int, string)
}

// newBridgeDouble stands up the bridge's route. A `reply` that returns a zero
// status falls through to a successful mint.
func newBridgeDouble(t *testing.T, reply func(call int, body map[string]any) (int, string)) *bridgeDouble {
	t.Helper()

	double := &bridgeDouble{reply: reply}

	double.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(req.Body).Decode(&body)
		_ = req.Body.Close()

		double.mu.Lock()
		double.calls = append(double.calls, bridgeCall{
			at:     time.Now(),
			path:   req.URL.Path,
			header: req.Header.Get(bridge.CredentialHeader),
			body:   body,
		})
		call := len(double.calls)
		reply := double.reply
		double.mu.Unlock()

		w.Header().Set("Content-Type", "application/json")

		if reply != nil {
			if status, payload := reply(call, body); status != 0 {
				w.WriteHeader(status)
				_, _ = io.WriteString(w, payload)
				return
			}
		}

		principal, _ := body["principal"].(string)
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, `{"access_token":"`+TokenFor(call, principal)+
			`","token_type":"Bearer","expires_in":900,"username":"`+principal+`"}`)
	}))
	t.Cleanup(double.server.Close)
	return double
}

// TokenFor is the token the double mints on the given call. The double owns the
// value, so a test can look for it on disk without the host ever printing a
// secret.
func TokenFor(call int, principal string) string {
	return fmt.Sprintf("e2e-token-%d-%s", call, principal)
}

func (b *bridgeDouble) count() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return len(b.calls)
}

func (b *bridgeDouble) request(i int) bridgeCall {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.calls[i]
}

// ---------------------------------------------------------------------------
// The origin double: the REST surface's shape, without a Cytale server
// ---------------------------------------------------------------------------

type originRequest struct {
	path          string
	authorization string
	credential    string
	body          map[string]any
}

type originDouble struct {
	server *httptest.Server

	mu       sync.Mutex
	requests []originRequest
	messages map[string][]string
}

func newOriginDouble(t *testing.T) *originDouble {
	t.Helper()
	double := &originDouble{messages: map[string][]string{}}

	double.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		var body map[string]any
		if req.Body != nil {
			_ = json.NewDecoder(req.Body).Decode(&body)
			_ = req.Body.Close()
		}

		channel, _ := body["channel_id"].(string)
		if channel == "" {
			channel = req.URL.Query().Get("channel_id")
		}

		double.mu.Lock()
		double.requests = append(double.requests, originRequest{
			path:          req.URL.Path,
			authorization: req.Header.Get("Authorization"),
			credential:    req.Header.Get(bridge.CredentialHeader),
			body:          body,
		})
		double.mu.Unlock()

		// Every request on this surface carries a bearer token: the token path is
		// the only credential it knows.
		if !strings.HasPrefix(req.Header.Get("Authorization"), "Bearer e2e-token-") {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = io.WriteString(w, `{"error":{"key":"unauthorized"}}`)
			return
		}

		w.Header().Set("Content-Type", "application/json")

		switch {
		case req.Method == http.MethodPost && req.URL.Path == "/api/v1/messages":
			content, _ := body["content"].(string)
			double.mu.Lock()
			double.messages[channel] = append(double.messages[channel], content)
			double.mu.Unlock()
			w.WriteHeader(http.StatusCreated)
			_, _ = io.WriteString(w, `{"id":"m-1","channel_id":`+mustJSON(channel)+`,"content":`+mustJSON(content)+`}`)

		case req.Method == http.MethodGet && req.URL.Path == "/api/v1/messages":
			double.mu.Lock()
			stored := append([]string(nil), double.messages[channel]...)
			double.mu.Unlock()
			entries := make([]string, 0, len(stored))
			for _, content := range stored {
				entries = append(entries, `{"content":`+mustJSON(content)+`}`)
			}
			w.WriteHeader(http.StatusOK)
			_, _ = io.WriteString(w, `{"messages":[`+strings.Join(entries, ",")+`]}`)

		default:
			w.WriteHeader(http.StatusNotFound)
			_, _ = io.WriteString(w, `{"error":{"key":"not_found"}}`)
		}
	}))
	t.Cleanup(double.server.Close)
	return double
}

func (o *originDouble) allRequests() []originRequest {
	o.mu.Lock()
	defer o.mu.Unlock()
	return append([]originRequest(nil), o.requests...)
}

func (o *originDouble) contents(channel string) []string {
	o.mu.Lock()
	defer o.mu.Unlock()
	return append([]string(nil), o.messages[channel]...)
}

func mustJSON(value string) string {
	encoded, err := json.Marshal(value)
	if err != nil {
		return `""`
	}
	return string(encoded)
}

// ---------------------------------------------------------------------------
// The host under test
// ---------------------------------------------------------------------------

type hostFixture struct {
	t          *testing.T
	host       *session.Host
	address    string
	ca         authority
	bridge     *bridgeDouble
	origin     *originDouble
	originURL  string
	clientDir  string
	secretsDir string
	logs       *syncBuffer
}

// originAddress is the origin the session's messages point at, whether it is the
// double or a deployment passed in.
func (f *hostFixture) originAddress() string {
	if f.origin != nil {
		return f.origin.server.URL
	}
	return f.originURL
}

// hostOptions tunes one assembled host. Every field is optional.
type hostOptions struct {
	ca         authority
	origin     string
	tune       func(*session.Config)
	reply      func(call int, body map[string]any) (int, string)
	noBridge   bool
	clientArgs []string
	scanDirs   []string
}

const (
	credentialFile = "bridge-credential"
	hostKeyFile    = "ssh_host_ed25519_key"
)

type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

func startHost(t *testing.T, opts hostOptions) *hostFixture {
	t.Helper()

	secrets := t.TempDir()
	credentialPath := filepath.Join(secrets, credentialFile)
	hostKeyPath := filepath.Join(secrets, hostKeyFile)

	if err := os.WriteFile(credentialPath, []byte("e2e-bridge-credential\n"), 0o600); err != nil {
		t.Fatalf("write the bridge credential: %v", err)
	}
	_, hostKeyPEM := newHostKeyPair(t)
	if err := os.WriteFile(hostKeyPath, hostKeyPEM, 0o600); err != nil {
		t.Fatalf("write the host key: %v", err)
	}

	// Read once and unlink, which is the boot posture R12a requires: after boot
	// there is no readable file for a same-uid child to open.
	credential, err := bridge.LoadCredential(credentialPath, false)
	if err != nil {
		t.Fatalf("LoadCredential: %v", err)
	}
	hostKey, err := auth.LoadHostKey(hostKeyPath, false)
	if err != nil {
		t.Fatalf("LoadHostKey: %v", err)
	}

	origin := opts.origin
	var originAPI *originDouble
	if origin == "" {
		originAPI = newOriginDouble(t)
		origin = originAPI.server.URL
	}

	var bridgeMock *bridgeDouble
	bridgeURL := "http://127.0.0.1:1"
	if !opts.noBridge {
		bridgeMock = newBridgeDouble(t, opts.reply)
		bridgeURL = bridgeMock.server.URL
	}

	minter, err := bridge.New(bridgeURL, credential)
	if err != nil {
		t.Fatalf("bridge.New: %v", err)
	}

	ca := opts.ca
	if ca.signer == nil {
		ca = newAuthority(t)
	}
	verifier, err := auth.NewVerifier([]gossh.PublicKey{ca.public})
	if err != nil {
		t.Fatalf("auth.NewVerifier: %v", err)
	}

	logs := &syncBuffer{}
	clientDir := t.TempDir()

	// The child is this test binary re-executed in its fixture mode. The default
	// is stated here rather than left to each caller because the alternative is
	// not a neutral one: a child started with NO argv re-runs this whole suite,
	// which recurses instead of failing.
	args := append([]string(nil), opts.clientArgs...)
	if len(args) == 0 {
		args = childArgs("frame", "message-channel")
	}
	if len(opts.scanDirs) > 0 {
		args = append(args, opts.scanDirs...)
	}

	cfg := session.Config{
		ListenAddress:    "127.0.0.1:0",
		ClientCommand:    []string{os.Args[0]},
		ClientArgs:       args,
		ClientDir:        clientDir,
		Origin:           origin,
		ChildPath:        "/usr/bin:/bin",
		Logger:           slog.New(slog.NewTextHandler(logs, nil)),
		IdlePollInterval: 50 * time.Millisecond,
		KillGrace:        500 * time.Millisecond,
	}
	if opts.tune != nil {
		opts.tune(&cfg)
	}

	host, err := session.NewHost(cfg, verifier, minter, hostKey)
	if err != nil {
		t.Fatalf("session.NewHost: %v", err)
	}

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	go func() { _ = host.Serve(listener) }()
	t.Cleanup(func() { _ = host.Close() })

	return &hostFixture{
		t:          t,
		host:       host,
		address:    listener.Addr().String(),
		ca:         ca,
		bridge:     bridgeMock,
		origin:     originAPI,
		originURL:  origin,
		clientDir:  clientDir,
		secretsDir: secrets,
		logs:       logs,
	}
}

func newHostKeyPair(t *testing.T) (gossh.Signer, []byte) {
	t.Helper()
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate host key: %v", err)
	}
	signer, err := gossh.NewSignerFromKey(priv)
	if err != nil {
		t.Fatalf("host key signer: %v", err)
	}
	block, err := gossh.MarshalPrivateKey(priv, "")
	if err != nil {
		t.Fatalf("marshal host key: %v", err)
	}
	return signer, pem.EncodeToMemory(block)
}

// ---------------------------------------------------------------------------
// The client side
// ---------------------------------------------------------------------------

// dial connects with one authentication method and a bounded timeout, so a hang
// is a failure rather than a slow test.
func dial(t *testing.T, address, login string, method gossh.AuthMethod) (*gossh.Client, error) {
	t.Helper()
	return gossh.Dial("tcp", address, &gossh.ClientConfig{
		User:            login,
		Auth:            []gossh.AuthMethod{method},
		HostKeyCallback: gossh.InsecureIgnoreHostKey(),
		Timeout:         5 * time.Second,
	})
}

// dialCertificate is the ordinary path: a fresh key certified for the login name.
func dialCertificate(t *testing.T, f *hostFixture, login string, notBefore, notAfter time.Time, tweak func(*gossh.Certificate)) (*gossh.Client, error) {
	t.Helper()
	subject := newSubject(t)
	cert := certificate(t, f.ca, subject, login, notBefore, notAfter, tweak)
	return dial(t, f.address, login, gossh.PublicKeys(certified(t, cert, subject)))
}

type sshClient struct {
	client  *gossh.Client
	session *gossh.Session
	stdin   io.WriteCloser
	lines   chan string
}

// openShell opens a session with a PTY of the given size and starts the shell. A
// zero size means no PTY was requested, which is `ssh -T`.
func openShell(t *testing.T, client *gossh.Client, width, height int) *sshClient {
	t.Helper()

	session, err := client.NewSession()
	if err != nil {
		t.Fatalf("NewSession: %v", err)
	}
	if width > 0 && height > 0 {
		if err := session.RequestPty("xterm-256color", height, width, gossh.TerminalModes{}); err != nil {
			t.Fatalf("RequestPty: %v", err)
		}
	}
	stdout, err := session.StdoutPipe()
	if err != nil {
		t.Fatalf("StdoutPipe: %v", err)
	}
	stdin, err := session.StdinPipe()
	if err != nil {
		t.Fatalf("StdinPipe: %v", err)
	}

	c := &sshClient{
		client:  client,
		session: session,
		stdin:   stdin,
		lines:   make(chan string, 1024),
	}
	go func() {
		defer close(c.lines)
		scanner := bufio.NewScanner(stdout)
		scanner.Buffer(make([]byte, 0, 64*1024), 1<<20)
		for scanner.Scan() {
			c.lines <- strings.TrimRight(scanner.Text(), "\r")
		}
	}()

	if err := session.Shell(); err != nil {
		t.Fatalf("Shell: %v", err)
	}
	return c
}

// waitFor consumes lines until one carries the prefix, or the deadline passes.
func (c *sshClient) waitFor(prefix string, timeout time.Duration) (string, bool) {
	deadline := time.After(timeout)
	for {
		select {
		case line, ok := <-c.lines:
			if !ok {
				return "", false
			}
			if strings.HasPrefix(line, prefix) {
				return line, true
			}
		case <-deadline:
			return "", false
		}
	}
}

// rest drains everything left until the session's output ends.
func (c *sshClient) rest() string {
	var b strings.Builder
	for line := range c.lines {
		b.WriteString(line)
		b.WriteString("\n")
	}
	return b.String()
}

func (c *sshClient) send(line string) {
	if _, err := io.WriteString(c.stdin, line+"\n"); err != nil {
		_ = c.client.Close()
	}
}

// exitStatus waits for the session to end. The status is the server's, from the
// ExitError a refused or failed session carries; the error is returned alongside
// it so a caller can tell a clean exit from a refusal.
func (c *sshClient) exitStatus() (int, error) {
	_ = c.stdin.Close()
	err := c.session.Wait()

	var exit *gossh.ExitError
	if errors.As(err, &exit) {
		return exit.ExitStatus(), err
	}
	if err != nil {
		return -1, err
	}
	return 0, nil
}

func (c *sshClient) close() {
	_ = c.stdin.Close()
	_ = c.session.Close()
	_ = c.client.Close()
}

// ---------------------------------------------------------------------------
// The happy path
// ---------------------------------------------------------------------------

// TestASignedCertificateAuthenticatesAndTheSessionRenders is the unit's goal
// sentence in three parts: a signed certificate authenticates with the username
// as the login name; the session renders the two-column frame with the seeded
// channel visible; and the descriptor carries the token the connection earned.
//
// The renderer is the fixture client, so what this asserts is the host's half —
// the PTY, the frame that reaches the member's channel, and the token on the
// descriptor. The product client's own two-column shell is `apps/tui`'s, and the
// composed end-to-end script is where it is driven for real.
func TestASignedCertificateAuthenticatesAndTheSessionRenders(t *testing.T) {
	f := startHost(t, hostOptions{
		clientArgs: childArgs("frame", "message-channel"),
		scanDirs:   []string{t.TempDir()},
	})

	client, err := dialCertificate(t, f, loginName, time.Now().Add(-time.Minute), time.Now().Add(time.Hour), nil)
	if err != nil {
		t.Fatalf("a signed certificate did not authenticate: %v", err)
	}
	defer client.Close()

	shell := openShell(t, client, 120, 40)
	defer shell.close()

	tokenLine, ok := shell.waitFor("TOKEN ", 10*time.Second)
	if !ok {
		t.Fatalf("the child never read a token from its descriptor:\n%s", shell.rest())
	}
	// The double minted `e2e-token-1-<principal>`; the first twelve characters
	// identify the mint without the fixture printing a whole secret.
	if want := TokenFor(1, loginName)[:12]; !strings.Contains(tokenLine, want) {
		t.Fatalf("the descriptor carried %q, want the host's first mint (%s…)", tokenLine, want)
	}

	userLine, ok := shell.waitFor("USER ", 10*time.Second)
	if !ok {
		t.Fatalf("the child never learned who it was:\n%s", shell.rest())
	}
	if !strings.Contains(userLine, loginName) {
		t.Fatalf("the token frame told the child %q, want %q", userLine, loginName)
	}

	frame, ok := shell.waitFor("FRAME ", 10*time.Second)
	if !ok {
		t.Fatalf("the two-column frame never rendered:\n%s", shell.rest())
	}
	if !strings.Contains(frame, "120x40") {
		t.Fatalf("the frame rendered at %q, want the requested 120x40", frame)
	}
	navLine, ok := shell.waitFor("| ", 5*time.Second)
	if !ok {
		t.Fatalf("the frame has no navigation column:\n%s", shell.rest())
	}
	if !strings.Contains(navLine, "cytale") {
		t.Fatalf("the navigation column reads %q, want the workspace name", navLine)
	}
	if !strings.Contains(navLine, channelName) {
		t.Fatalf("the seeded channel %q is not visible in the frame: %q", channelName, navLine)
	}

	// The member quits the client, which is the clean exit that prints nothing.
	shell.send("quit")
	if _, ok := shell.waitFor("BYE", 10*time.Second); !ok {
		t.Fatalf("the fixture client never reached its exit:\n%s", shell.rest())
	}

	status, err := shell.exitStatus()
	if err != nil {
		t.Fatalf("the session did not end cleanly: %v", err)
	}
	if status != 0 {
		t.Fatalf("the session's exit status was %d, want 0", status)
	}
	if output := shell.rest(); strings.Contains(output, "session ended") {
		t.Fatalf("a clean client exit printed a session-end block:\n%s", output)
	}

	// The bridge was told the verified identity: the login name as the principal,
	// the certificate's serial as a decimal string, and the key's fingerprint.
	if f.bridge.count() == 0 {
		t.Fatal("the bridge was never asked")
	}
	first := f.bridge.request(0)
	if first.path != bridge.Route {
		t.Errorf("the host minted at %q, want %q", first.path, bridge.Route)
	}
	if first.header != "e2e-bridge-credential" {
		t.Errorf("the bridge credential header was %q", first.header)
	}
	if first.body["principal"] != loginName {
		t.Errorf("the assertion's principal = %#v, want %q", first.body["principal"], loginName)
	}
	if first.body["serial"] != strconv.FormatUint(serial, 10) {
		t.Errorf("the assertion's serial = %#v, want %d as a decimal string", first.body["serial"], serial)
	}
	if !strings.HasPrefix(fmt.Sprint(first.body["fingerprint"]), "SHA256:") {
		t.Errorf("the assertion's fingerprint = %#v, want the OpenSSH SHA256 spelling", first.body["fingerprint"])
	}
}

// TestTypingAMessageIsPersistedAndObservableThroughTheAPI drives the whole path a
// member's keystrokes travel — the SSH channel, the PTY, the child, the token the
// host minted, and the origin's REST surface — and then reads the message back
// over the API rather than out of the child's mouth.
//
// The origin is a double. What this proves is that the host's path carries a
// member's message to a server and back; the Cytale server's own persistence is
// the composed end-to-end script's job, not this file's claim.
func TestTypingAMessageIsPersistedAndObservableThroughTheAPI(t *testing.T) {
	const channel = "c-e2e"
	f := startHost(t, hostOptions{
		clientArgs: childArgs("frame", channel),
		scanDirs:   []string{t.TempDir()},
	})

	client, err := dialCertificate(t, f, loginName, time.Now().Add(-time.Minute), time.Now().Add(time.Hour), nil)
	if err != nil {
		t.Fatalf("a signed certificate did not authenticate: %v", err)
	}
	defer client.Close()

	shell := openShell(t, client, 100, 30)
	defer shell.close()

	if _, ok := shell.waitFor("TOKEN ", 10*time.Second); !ok {
		t.Fatalf("the session never carried a token:\n%s", shell.rest())
	}

	text := "typed-through-ssh-" + strconv.FormatInt(time.Now().UnixNano(), 36)
	shell.send("send " + text)

	if _, ok := shell.waitFor("SENT 201", 10*time.Second); !ok {
		t.Fatalf("the client did not send the line:\n%s", shell.rest())
	}
	if _, ok := shell.waitFor("READBACK "+text, 10*time.Second); !ok {
		t.Fatalf("the client could not read its own message back:\n%s", shell.rest())
	}

	// The API's own view, which is the observable the plan names.
	if stored := f.origin.contents(channel); len(stored) != 1 || stored[0] != text {
		t.Fatalf("the API holds %q, want exactly the line that was typed", stored)
	}

	// The token was USED, so "the message arrived" cannot be confused with a
	// vacuous assertion — and the bridge's own material never reached the origin.
	if requests := f.origin.allRequests(); len(requests) == 0 {
		t.Fatal("the origin saw no request, so the message path was never exercised")
	}
	for _, request := range f.origin.allRequests() {
		if request.credential != "" {
			t.Fatalf("a bridge credential reached the public origin on %s", request.path)
		}
		if _, isAssertion := request.body["asserted_at"]; isAssertion {
			t.Fatalf("a bridge assertion reached the public origin on %s", request.path)
		}
	}
}

// ---------------------------------------------------------------------------
// The certificate refusals, and the text a member sees
// ---------------------------------------------------------------------------

// TestAWrongLoginNameIsRefused is R10's principal bind over a real connection.
//
// The certificate is genuine and its window is real; the login name is not its
// principal. Publickey authentication carries no reason, so the text a member
// reads is the client's own denial — `scripts/ssh-host-e2e.sh` asserts that
// against the real `ssh`. Here: the connection is refused, the bridge is never
// asked, and the refusal is a rejection rather than a hang.
func TestAWrongLoginNameIsRefused(t *testing.T) {
	f := startHost(t, hostOptions{
		clientArgs: childArgs("frame", "message-channel"),
		scanDirs:   []string{t.TempDir()},
	})

	// The certificate is issued for loginName and the connection asks to log in as
	// someone else, which is the mismatch R10's principal bind exists to refuse.
	subject := newSubject(t)
	cert := certificate(t, f.ca, subject, loginName, time.Now().Add(-time.Minute), time.Now().Add(time.Hour), nil)

	started := time.Now()
	client, err := dial(t, f.address, "someone-else", gossh.PublicKeys(certified(t, cert, subject)))
	if err == nil {
		client.Close()
		t.Fatal("a certificate whose principal is not the login name authenticated")
	}
	if elapsed := time.Since(started); elapsed > 5*time.Second {
		t.Fatalf("the refusal took %v; it should be immediate, not a hang", elapsed)
	}
	if f.bridge.count() != 0 {
		t.Fatal("a refused connection reached the bridge")
	}
	if !isAuthenticationFailure(err) {
		t.Fatalf("the refusal was not an authentication failure: %v", err)
	}
}

// TestAnExpiredCertificateIsRefusedAndTheRecoveryIsTheReissueURL is R10's window
// check plus the actionable half of R19a.
//
// An expired certificate and a wrong login name are INDISTINGUISHABLE to the
// member: both produce the client's own "Permission denied (publickey)", because
// publickey authentication has no channel for a reason. So the recovery path
// cannot be the denial's text — it is the certificate the member holds (whose
// window `ssh-keygen -L` prints) and the session-end message the host writes when
// a certificate expires mid-session, which names the page to re-issue from.
func TestAnExpiredCertificateIsRefusedAndTheRecoveryIsTheReissueURL(t *testing.T) {
	f := startHost(t, hostOptions{
		clientArgs: childArgs("frame", "message-channel"),
		scanDirs:   []string{t.TempDir()},
	})

	client, err := dialCertificate(t, f, loginName, time.Now().Add(-2*time.Hour), time.Now().Add(-time.Hour), nil)
	if err == nil {
		client.Close()
		t.Fatal("an expired certificate authenticated")
	}
	if f.bridge.count() != 0 {
		t.Fatal("an expired certificate reached the bridge")
	}
	if !isAuthenticationFailure(err) {
		t.Fatalf("the refusal was not an authentication failure: %v", err)
	}

	reason := session.EndReason{Code: session.ReasonCertificateExpired}
	message := reason.MemberMessage(f.originAddress())
	if !strings.Contains(message, "/#/settings/ssh") {
		t.Fatalf("the expired-certificate message does not name the re-issue page: %q", message)
	}
	if !strings.Contains(message, "expired") {
		t.Fatalf("the expired-certificate message does not say what happened: %q", message)
	}
	if !reason.Reissued() {
		t.Fatal("an expired certificate is not marked as re-issue-remedied")
	}
}

// TestAnUntrustedAuthorityIsRefusedAndDoesNotHang is R10's trust-set clause with
// the timing property the plan names: a rejection, not a hang.
func TestAnUntrustedAuthorityIsRefusedAndDoesNotHang(t *testing.T) {
	f := startHost(t, hostOptions{
		clientArgs: childArgs("frame", "message-channel"),
		scanDirs:   []string{t.TempDir()},
	})

	other := newAuthority(t)
	subject := newSubject(t)
	cert := certificate(t, other, subject, loginName, time.Now().Add(-time.Minute), time.Now().Add(time.Hour), nil)

	started := time.Now()
	client, err := dial(t, f.address, loginName, gossh.PublicKeys(certified(t, cert, subject)))
	elapsed := time.Since(started)
	if err == nil {
		client.Close()
		t.Fatal("a certificate from an untrusted CA authenticated")
	}
	if elapsed > 5*time.Second {
		t.Fatalf("the rejection took %v; the plan requires a rejection, not a hang", elapsed)
	}
	if f.bridge.count() != 0 {
		t.Fatal("a certificate from an untrusted CA reached the bridge")
	}
}

// isAuthenticationFailure distinguishes "the server said no" from "the transport
// broke", because a test that cannot tell them apart passes for the wrong reason.
func isAuthenticationFailure(err error) bool {
	if err == nil {
		return false
	}
	message := err.Error()
	return strings.Contains(message, "unable to authenticate") ||
		strings.Contains(message, "no supported methods remain") ||
		errors.Is(err, gossh.ErrNoAuth)
}

// ---------------------------------------------------------------------------
// The negative control: the guards are load-bearing
// ---------------------------------------------------------------------------

// TestTheGuardsAreLoadBearingCertificate is the control the unit's evidence
// strategy asks for: for each certificate this host refuses, a bare
// `CertChecker` — what `x/crypto` offers and what the convenience wrappers build
// on — is shown to ACCEPT it. Remove the guard and the certificate authenticates,
// so the refusals are the host's work rather than the library's.
//
// Each case is asserted three ways: the library accepts, the host refuses over a
// real handshake, and the verifier refuses at the same seam the server uses.
func TestTheGuardsAreLoadBearingCertificate(t *testing.T) {
	f := startHost(t, hostOptions{
		clientArgs: childArgs("frame", "message-channel"),
		scanDirs:   []string{t.TempDir()},
	})

	bare := &gossh.CertChecker{
		IsUserAuthority:          func(gossh.PublicKey) bool { return true },
		SupportedCriticalOptions: nil,
		Clock:                    time.Now,
	}

	cases := []struct {
		name  string
		guard string
		tweak func(*gossh.Certificate)
	}{
		{
			name:  "an empty principals list",
			guard: "auth.ErrEmptyPrincipals",
			// An empty list is a WILDCARD to CheckCert: the principal check is
			// skipped entirely, so the certificate authenticates as anyone.
			tweak: func(c *gossh.Certificate) { c.ValidPrincipals = []string{} },
		},
		{
			name:  "an indefinite validity window",
			guard: "auth.ErrIndefiniteValidity",
			// CertTimeInfinity is explicitly exempted from the expiry check, so
			// the certificate never expires as far as the library is concerned.
			tweak: func(c *gossh.Certificate) { c.ValidBefore = gossh.CertTimeInfinity },
		},
		{
			name:  "a critical option the host does not act on",
			guard: "auth.ErrCriticalOptions",
			// source-address is appended to SupportedCriticalOptions by
			// Authenticate itself, because the transport enforces it.
			tweak: func(c *gossh.Certificate) {
				c.CriticalOptions = map[string]string{"source-address": "127.0.0.1/32"}
			},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			subject := newSubject(t)
			cert := certificate(t, f.ca, subject, loginName, time.Now().Add(-time.Minute), time.Now().Add(time.Hour), tc.tweak)

			// The control: the library's own check accepts this certificate for the
			// login name it was issued to, so the ONLY thing standing between it and
			// a session is the guard this host adds. If this ever stops being true
			// the guard has become redundant, and that is worth knowing.
			conn := &probeConn{user: loginName}
			if _, err := bare.Authenticate(conn, cert); err != nil {
				t.Fatalf("the control is not constructible: a bare CertChecker already refuses %s (%v)", tc.name, err)
			}

			// And for the empty-principals case, the wildcard is the whole point:
			// the same certificate authenticates as a login name it never named.
			if tc.guard == "auth.ErrEmptyPrincipals" {
				if _, err := bare.Authenticate(&probeConn{user: "someone-else-entirely"}, cert); err != nil {
					t.Fatalf("the empty-principals wildcard is not constructible: %v", err)
				}
			}

			// The verifier refuses it, at the seam the server uses.
			verifier, err := auth.NewVerifier([]gossh.PublicKey{f.ca.public})
			if err != nil {
				t.Fatalf("auth.NewVerifier: %v", err)
			}
			if _, err := verifier.Authenticate(conn, cert); err == nil {
				t.Fatalf("the verifier accepted %s", tc.name)
			}

			// And the host refuses it, over a real handshake.
			client, err := dial(t, f.address, loginName, gossh.PublicKeys(certified(t, cert, subject)))
			if err == nil {
				client.Close()
				t.Fatalf("the host accepted %s, which %s exists to refuse", tc.name, tc.guard)
			}
			if f.bridge.count() != 0 {
				t.Fatalf("the host refused %s but had already reached the bridge", tc.name)
			}
		})
	}
}

// probeConn is the ConnMetadata the callback probes need.
type probeConn struct{ user string }

func (c *probeConn) User() string          { return c.user }
func (c *probeConn) SessionID() []byte     { return []byte("e2e-probe") }
func (c *probeConn) ClientVersion() []byte { return []byte("SSH-2.0-e2e-probe") }
func (c *probeConn) ServerVersion() []byte { return []byte("SSH-2.0-Hrmny-SSH-Host") }
func (c *probeConn) RemoteAddr() net.Addr {
	return &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 40001}
}
func (c *probeConn) LocalAddr() net.Addr {
	return &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 2222}
}

// ---------------------------------------------------------------------------
// R11: no PTY is refused with a message a member can act on
// ---------------------------------------------------------------------------

// TestASessionWithNoPTYIsRefusedWithAClearMessage is the script's `ssh -T` case
// at the level the host enforces it: no PTY, no session, and the member is told
// what to do about it.
func TestASessionWithNoPTYIsRefusedWithAClearMessage(t *testing.T) {
	f := startHost(t, hostOptions{
		clientArgs: childArgs("frame", "message-channel"),
		scanDirs:   []string{t.TempDir()},
	})

	client, err := dialCertificate(t, f, loginName, time.Now().Add(-time.Minute), time.Now().Add(time.Hour), nil)
	if err != nil {
		t.Fatalf("a signed certificate did not authenticate: %v", err)
	}
	defer client.Close()

	shell := openShell(t, client, 0, 0) // no RequestPty: this is `ssh -T`
	defer shell.close()

	status, err := shell.exitStatus()
	if err == nil && status == 0 {
		t.Fatal("a session with no PTY ended with a success status")
	}
	var exit *gossh.ExitError
	if !errors.As(err, &exit) {
		t.Fatalf("the session ended with %v, want a non-zero exit status", err)
	}

	output := shell.rest()
	if !strings.Contains(output, string(session.ReasonNoPTY)) {
		t.Fatalf("the refusal does not name no_pty:\n%s", output)
	}
	if !strings.Contains(output, "needs a terminal") || !strings.Contains(output, "without -T") {
		t.Fatalf("the refusal does not tell the member what to do:\n%s", output)
	}
	if f.bridge.count() != 0 {
		t.Fatal("a session with no PTY reached the bridge")
	}
}

// ---------------------------------------------------------------------------
// R13b: the pre-auth bound
// ---------------------------------------------------------------------------

// TestAnUnauthenticatedFloodIsBoundedAndTheHostStillServes is R13b as an operator
// experiences it: connections that never authenticate are turned away at the cap,
// and once they are gone the host serves a member normally — the flood costs the
// host a refusal count, not the host.
func TestAnUnauthenticatedFloodIsBoundedAndTheHostStillServes(t *testing.T) {
	const (
		capacity = 2
		flood    = 8
	)

	f := startHost(t, hostOptions{
		clientArgs: childArgs("frame", "message-channel"),
		scanDirs:   []string{t.TempDir()},
		tune:       func(cfg *session.Config) { cfg.MaxPreAuthConnections = capacity },
	})

	flooded := make([]net.Conn, 0, flood)
	for i := 0; i < flood; i++ {
		conn, err := net.Dial("tcp", f.address)
		if err != nil {
			break
		}
		flooded = append(flooded, conn)
	}
	if len(flooded) < capacity+1 {
		t.Fatalf("only %d connections were opened; the cap cannot be exercised", len(flooded))
	}

	// Dialing returns once the kernel has queued the connection, which can be
	// before the host's accept loop has admitted it. Wait until the flood
	// actually holds the pre-auth slots, or a loaded runner lets the real client
	// in ahead of it (CI run 2694: "admitted over the pre-auth cap" in 0.00s).
	floodDeadline := time.Now().Add(5 * time.Second)
	for f.host.Supervisor().Pending() < capacity {
		if time.Now().After(floodDeadline) {
			t.Fatalf("the flood never filled the pre-auth slots (pending %d of %d)", f.host.Supervisor().Pending(), capacity)
		}
		time.Sleep(10 * time.Millisecond)
	}

	// A real client offered while the slots are taken is turned away before its
	// handshake, so the dial fails rather than hanging.
	client, err := dialCertificate(t, f, loginName, time.Now().Add(-time.Minute), time.Now().Add(time.Hour), nil)
	if err == nil {
		client.Close()
		t.Fatal("a connection was admitted over the pre-auth cap")
	}
	if refused := f.host.Supervisor().Refused(); refused == 0 {
		t.Fatal("no connection was recorded as refused, so the cap is not what turned it away")
	}

	// Release the flood and the host serves a real session: bounded, not
	// exhausted.
	for _, conn := range flooded {
		_ = conn.Close()
	}

	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		client, err := dialCertificate(t, f, loginName, time.Now().Add(-time.Minute), time.Now().Add(time.Hour), nil)
		if err == nil {
			shell := openShell(t, client, 80, 24)
			if _, ok := shell.waitFor("TOKEN ", 10*time.Second); !ok {
				t.Fatalf("the recovered session never carried a token:\n%s", shell.rest())
			}
			shell.close()
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("the host never recovered from the flood; the pre-auth slots were not released")
}

// ---------------------------------------------------------------------------
// R27: no Cytale token on disk
// ---------------------------------------------------------------------------

// TestNoCytaleTokenIsOnDiskAfterTheSessionIsEstablished is R27 at the host's
// boundary: after a session is established, the token the host minted exists on
// the child's descriptor and nowhere the child can read it.
//
// Three things keep it from being vacuous:
//
//   - the token's value is known to the test (the bridge double minted it), so
//     the scan has a real needle;
//   - a control plants the SAME needle in a scanned directory and requires the
//     child to find it, so a broken scan cannot report "clean";
//   - the host's two secrets are asserted unlinked by boot, which is the part of
//     the property that does not depend on the child at all.
func TestNoCytaleTokenIsOnDiskAfterTheSessionIsEstablished(t *testing.T) {
	scanDir := t.TempDir()
	f := startHost(t, hostOptions{
		clientArgs: childArgs("frame", "message-channel"),
		scanDirs:   []string{scanDir},
	})

	client, err := dialCertificate(t, f, loginName, time.Now().Add(-time.Minute), time.Now().Add(time.Hour), nil)
	if err != nil {
		t.Fatalf("a signed certificate did not authenticate: %v", err)
	}
	defer client.Close()

	shell := openShell(t, client, 90, 30)
	defer shell.close()

	tokenLine, ok := shell.waitFor("TOKEN ", 10*time.Second)
	if !ok {
		t.Fatalf("the session never carried a token:\n%s", shell.rest())
	}
	token := TokenFor(1, loginName)
	if !strings.Contains(tokenLine, token[:12]) {
		t.Fatalf("the child read %q, want the token the bridge minted (%s…)", tokenLine, token[:12])
	}

	// The descriptor is the token's only carrier: the child reports its scan
	// clean, and the host's own secrets are gone.
	if _, ok := shell.waitFor("DISKCLEAN", 10*time.Second); !ok {
		t.Fatalf("the child found the token on disk, or never finished scanning:\n%s", shell.rest())
	}
	for _, path := range []string{
		filepath.Join(f.secretsDir, credentialFile),
		filepath.Join(f.secretsDir, hostKeyFile),
	} {
		if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("%s still exists after boot (%v); a same-uid child could read it", path, err)
		}
	}
	for _, dir := range []string{scanDir, f.clientDir} {
		if found, err := filesContaining(dir, token); err != nil || len(found) != 0 {
			t.Fatalf("the token is on disk under %s: %v (%v)", dir, found, err)
		}
	}

	// The control: plant the same needle where the child scans, and require the
	// child to find it.
	planted := filepath.Join(scanDir, "planted-token.txt")
	if err := os.WriteFile(planted, []byte("a leaked credential: "+token+"\n"), 0o600); err != nil {
		t.Fatalf("plant the control: %v", err)
	}
	shell.send("scan")

	line, ok := shell.waitFor("ONDISK ", 10*time.Second)
	if !ok {
		t.Fatalf("the scan reported clean with a token planted in the scanned tree, so the scan proves nothing:\n%s", shell.rest())
	}
	if !strings.Contains(line, planted) {
		t.Fatalf("the scan reported %q, want it to name the planted file %s", line, planted)
	}
}

// filesContaining walks root and returns the paths whose contents hold needle.
func filesContaining(root, needle string) ([]string, error) {
	var found []string
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if entry.IsDir() {
			return nil
		}
		info, err := entry.Info()
		if err != nil || info.Size() > 1<<20 {
			return nil
		}
		body, err := os.ReadFile(path)
		if err != nil {
			return nil
		}
		if bytes.Contains(body, []byte(needle)) {
			found = append(found, path)
		}
		return nil
	})
	return found, err
}

// ---------------------------------------------------------------------------
// The token path: renewal, and endings with a reason
// ---------------------------------------------------------------------------

// TestASessionOutlivingOneTokenReceivesARenewalAndKeepsWorking is KTD8's
// member-visible half: a token that expires mid-session is replaced on the same
// descriptor — before the old one lapses — and the session carries on.
func TestASessionOutlivingOneTokenReceivesARenewalAndKeepsWorking(t *testing.T) {
	const lifetime = 2

	f := startHost(t, hostOptions{
		clientArgs: childArgs("frame", "c-renew"),
		scanDirs:   []string{t.TempDir()},
		reply: func(call int, body map[string]any) (int, string) {
			principal, _ := body["principal"].(string)
			return http.StatusOK, `{"access_token":"` + TokenFor(call, principal) +
				`","token_type":"Bearer","expires_in":` + strconv.Itoa(lifetime) + `,"username":"` + principal + `"}`
		},
		tune: func(cfg *session.Config) {
			cfg.MaxSessionDuration = time.Minute
			cfg.IdleTimeout = time.Hour
		},
	})

	client, err := dialCertificate(t, f, loginName, time.Now().Add(-time.Minute), time.Now().Add(time.Hour), nil)
	if err != nil {
		t.Fatalf("a signed certificate did not authenticate: %v", err)
	}
	defer client.Close()

	shell := openShell(t, client, 100, 30)
	defer shell.close()

	if _, ok := shell.waitFor("TOKEN ", 10*time.Second); !ok {
		t.Fatalf("the session never carried its first token:\n%s", shell.rest())
	}

	renewed, ok := shell.waitFor("RENEW ", 15*time.Second)
	if !ok {
		t.Fatalf("the session was never given a renewal:\n%s", shell.rest())
	}
	if !strings.Contains(renewed, TokenFor(2, loginName)[:12]) {
		t.Fatalf("the renewal carried %q, want the second mint", renewed)
	}

	// The renewal came before the first token's lifetime lapsed, which is what
	// keeps the live request path from ever holding a dead token — and it did not
	// reuse the nonce, which the server records single-use.
	first := f.bridge.request(0)
	second := f.bridge.request(1)
	if gap := second.at.Sub(first.at); gap >= lifetime*time.Second {
		t.Fatalf("the renewal came %v after the first mint, at or past the %ds lifetime", gap, lifetime)
	}
	if first.body["nonce"] == second.body["nonce"] {
		t.Fatal("the renewal reused the nonce; the server records a nonce single-use and would refuse it as replayed_assertion")
	}
	if first.body["serial"] != second.body["serial"] {
		t.Fatalf("the serial changed across a renewal: %#v -> %#v", first.body["serial"], second.body["serial"])
	}

	// The session is still working: the child answers a keystroke after the
	// renewal.
	text := "after-the-renewal"
	shell.send("send " + text)
	if _, ok := shell.waitFor("READBACK "+text, 10*time.Second); !ok {
		t.Fatalf("the session did not keep working across the renewal:\n%s", shell.rest())
	}
}

// TestASessionWhoseBridgeStopsMidFlightEndsWithAPrintedReason is R19a's renewal
// half with the bridge gone: the retry window elapses, the session ends, and the
// member is told why — on the descriptor, and in the block the host writes to the
// channel.
func TestASessionWhoseBridgeStopsMidFlightEndsWithAPrintedReason(t *testing.T) {
	f := startHost(t, hostOptions{
		clientArgs: childArgs("frame", "message-channel"),
		scanDirs:   []string{t.TempDir()},
		reply: func(call int, body map[string]any) (int, string) {
			if call == 1 {
				principal, _ := body["principal"].(string)
				return http.StatusOK, `{"access_token":"` + TokenFor(1, principal) +
					`","token_type":"Bearer","expires_in":1,"username":"` + principal + `"}`
			}
			// The bridge is gone: the transport fails for the whole window.
			return http.StatusInternalServerError, ``
		},
		tune: func(cfg *session.Config) {
			cfg.RenewalRetryWindow = 300 * time.Millisecond
			cfg.RenewalRetryInterval = 25 * time.Millisecond
			cfg.MaxSessionDuration = time.Minute
			cfg.IdleTimeout = time.Hour
		},
	})

	client, err := dialCertificate(t, f, loginName, time.Now().Add(-time.Minute), time.Now().Add(time.Hour), nil)
	if err != nil {
		t.Fatalf("a signed certificate did not authenticate: %v", err)
	}
	defer client.Close()

	shell := openShell(t, client, 100, 30)
	defer shell.close()

	if _, ok := shell.waitFor("TOKEN ", 10*time.Second); !ok {
		t.Fatalf("the session never carried its first token:\n%s", shell.rest())
	}

	// The frame on the client's own descriptor, which is what lets the client name
	// the cause instead of inventing one.
	frame, ok := shell.waitFor("END ", 15*time.Second)
	if !ok {
		t.Fatalf("the running client was never told why its session ended:\n%s", shell.rest())
	}
	if want := "END " + string(session.ReasonTokenPathFailed); strings.TrimSpace(frame) != want {
		t.Fatalf("the descriptor carried %q, want %q", frame, want)
	}

	output := shell.rest()
	if !strings.Contains(output, "── session ended ──") {
		t.Fatalf("the session-end block was never printed:\n%s", output)
	}
	if !strings.Contains(output, "(reason: "+string(session.ReasonTokenPathFailed)) {
		t.Fatalf("the session-end block does not name token_path_failed:\n%s", output)
	}
	// The sentence, not the exact detail: the detail names why the token path
	// failed, which is the host's to word. What the member must get is the cause
	// and the remedy.
	if !strings.Contains(output, "This session's token could not be renewed") {
		t.Fatalf("the session-end block does not explain what happened:\n%s", output)
	}
	if !strings.Contains(output, "/#/settings/ssh") {
		t.Fatalf("the session-end block omits the re-issue page:\n%s", output)
	}
	if !strings.Contains(output, f.originAddress()) {
		t.Fatalf("the session-end block's re-issue page is not on the configured origin %s:\n%s", f.originAddress(), output)
	}
}

// TestASessionRefusedAtRenewalEndsWithTheBridgesOwnReason is the other renewal
// ending: the bridge understood the assertion and declined it, so the session
// ends at that renewal — within one token lifetime — with the bridge's own reason
// carried through verbatim.
func TestASessionRefusedAtRenewalEndsWithTheBridgesOwnReason(t *testing.T) {
	f := startHost(t, hostOptions{
		clientArgs: childArgs("frame", "message-channel"),
		scanDirs:   []string{t.TempDir()},
		reply: func(call int, body map[string]any) (int, string) {
			if call == 1 {
				principal, _ := body["principal"].(string)
				return http.StatusOK, `{"access_token":"` + TokenFor(1, principal) +
					`","token_type":"Bearer","expires_in":1,"username":"` + principal + `"}`
			}
			return http.StatusForbidden, `{"error":{"key":"bridge_refused","reason":"credential_epoch_moved","message":"This account's credentials were reset."}}`
		},
		tune: func(cfg *session.Config) {
			cfg.MaxSessionDuration = time.Minute
			cfg.IdleTimeout = time.Hour
		},
	})

	client, err := dialCertificate(t, f, loginName, time.Now().Add(-time.Minute), time.Now().Add(time.Hour), nil)
	if err != nil {
		t.Fatalf("a signed certificate did not authenticate: %v", err)
	}
	defer client.Close()

	shell := openShell(t, client, 100, 30)
	defer shell.close()

	frame, ok := shell.waitFor("END ", 15*time.Second)
	if !ok {
		t.Fatalf("the running client was never told why its session ended:\n%s", shell.rest())
	}
	if want := "END " + string(session.ReasonCredentialEpochMoved); strings.TrimSpace(frame) != want {
		t.Fatalf("the descriptor carried %q, want %q", frame, want)
	}

	output := shell.rest()
	if !strings.Contains(output, bridge.ReasonCredentialEpochMoved) {
		t.Fatalf("the session-end block lost the bridge's own reason:\n%s", output)
	}
	if !strings.Contains(output, "/#/settings/ssh") {
		t.Fatalf("the session-end block omits the re-issue page:\n%s", output)
	}
}

// TestTheStartupMintFailingEndsTheSessionWithAReason keeps the fail-closed
// property in the script's scenario list: a bridge that cannot be reached at all
// means no client process, and a reason the member can read.
func TestTheStartupMintFailingEndsTheSessionWithAReason(t *testing.T) {
	f := startHost(t, hostOptions{
		clientArgs: childArgs("frame", "message-channel"),
		scanDirs:   []string{t.TempDir()},
		noBridge:   true,
		tune:       func(cfg *session.Config) { cfg.IdleTimeout = time.Hour },
	})

	client, err := dialCertificate(t, f, loginName, time.Now().Add(-time.Minute), time.Now().Add(time.Hour), nil)
	if err != nil {
		t.Fatalf("a signed certificate did not authenticate: %v", err)
	}
	defer client.Close()

	shell := openShell(t, client, 100, 30)
	defer shell.close()

	status, err := shell.exitStatus()
	if err == nil && status == 0 {
		t.Fatal("a session with no reachable bridge exited successfully")
	}
	output := shell.rest()
	if !strings.Contains(output, string(session.ReasonBridgeUnreachable)) {
		t.Fatalf("the refusal does not name bridge_unreachable:\n%s", output)
	}
	if strings.Contains(output, "DISKCLEAN") || strings.Contains(output, "FRAME ") {
		t.Fatalf("a client process ran without a token; the session must fail closed:\n%s", output)
	}
}

// ---------------------------------------------------------------------------
// The edge cases the plan names
// ---------------------------------------------------------------------------

// TestTerminalResizedMidSessionRedrawsAtTheNewWidth is the resize edge case,
// asserted on rendered output rather than on a size accessor: the fixture draws
// its frame to the width the PTY reports, and the drawn ROW'S LENGTH is the
// assertion.
func TestTerminalResizedMidSessionRedrawsAtTheNewWidth(t *testing.T) {
	f := startHost(t, hostOptions{
		clientArgs: childArgs("frame", "message-channel"),
		scanDirs:   []string{t.TempDir()},
	})

	client, err := dialCertificate(t, f, loginName, time.Now().Add(-time.Minute), time.Now().Add(time.Hour), nil)
	if err != nil {
		t.Fatalf("a signed certificate did not authenticate: %v", err)
	}
	defer client.Close()

	shell := openShell(t, client, 120, 40)
	defer shell.close()

	first, ok := shell.waitFor("FRAME ", 10*time.Second)
	if !ok {
		t.Fatalf("the frame never rendered:\n%s", shell.rest())
	}
	if !strings.Contains(first, "120x40") {
		t.Fatalf("the first frame rendered at %q, want 120x40", first)
	}
	if row, ok := shell.waitFor("| ", 5*time.Second); !ok || len(row) != 120 {
		t.Fatalf("the first frame's row is %d columns (%q), want 120", len(row), row)
	}

	if err := shell.session.WindowChange(40, 100); err != nil {
		t.Fatalf("WindowChange: %v", err)
	}

	resized := ""
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		line, ok := shell.waitFor("FRAME ", time.Until(deadline))
		if !ok {
			break
		}
		if strings.Contains(line, "100x40") {
			resized = line
			break
		}
	}
	if resized == "" {
		t.Fatalf("the terminal was never redrawn at the new width:\n%s", shell.rest())
	}
	row, ok := shell.waitFor("| ", 5*time.Second)
	if !ok {
		t.Fatalf("the redrawn frame has no row:\n%s", shell.rest())
	}
	if len(row) != 100 {
		t.Fatalf("the redrawn row is %d columns, want 100: %q", len(row), row)
	}
}

// TestABridgeAssertionNeverReachesThePublicOrigin is the host's half of "the
// bridge is unreachable from the public origin": the assertion the host posts
// carries the bridge credential, and a full session must therefore leave the
// origin's own surface untouched by it. The deployment's half — that the public
// route table carries no bridge path — is asserted by the end-to-end script
// against the running origin.
func TestABridgeAssertionNeverReachesThePublicOrigin(t *testing.T) {
	f := startHost(t, hostOptions{
		clientArgs: childArgs("frame", "message-channel"),
		scanDirs:   []string{t.TempDir()},
	})

	client, err := dialCertificate(t, f, loginName, time.Now().Add(-time.Minute), time.Now().Add(time.Hour), nil)
	if err != nil {
		t.Fatalf("a signed certificate did not authenticate: %v", err)
	}
	defer client.Close()

	shell := openShell(t, client, 80, 24)
	defer shell.close()
	if _, ok := shell.waitFor("TOKEN ", 10*time.Second); !ok {
		t.Fatalf("the session never carried a token:\n%s", shell.rest())
	}

	if f.bridge.count() == 0 {
		t.Fatal("the bridge was never asked, so this assertion is vacuous")
	}
	for _, request := range f.origin.allRequests() {
		if request.credential != "" {
			t.Fatalf("the bridge credential reached the origin on %s", request.path)
		}
		if request.path == bridge.Route {
			t.Fatal("the bridge route was served by the origin")
		}
	}
}

// ---------------------------------------------------------------------------
// The fixture client (this test binary, re-executed)
// ---------------------------------------------------------------------------

// childArgs is the host-configured argv for the fixture client. The mode, the
// channel and the directories it scans are host configuration — never anything a
// session sends (R14).
func childArgs(mode, channel string, scanDirs ...string) []string {
	args := []string{"-test.run=^TestE2EChild$", "--", mode, channel}
	return append(args, scanDirs...)
}

// TestE2EChild is the fixture client. It is this test binary, re-executed by the
// host with the four variables the host builds; a run that is not the child
// skips.
//
// It reads the token descriptor the way `apps/tui/src/session/tokenPipe.ts`
// does — one NDJSON frame per line, tokens and the end frame on the same
// descriptor — and prints one line per fact, so the assertions are about
// rendered output rather than about internals.
func TestE2EChild(t *testing.T) {
	args := childArgsFromProcess()
	if len(args) < 2 {
		t.Skip("not the child process")
	}
	mode, channel := args[0], args[1]
	scanDirs := args[2:]

	fd := 3
	if value := os.Getenv(session.TokenFDEnv); value != "" {
		parsed, err := strconv.Atoi(value)
		if err != nil {
			fmt.Printf("BADFD %v\n", err)
			os.Exit(2)
		}
		fd = parsed
	}
	fmt.Printf("PID %d\n", os.Getpid())

	if mode != "frame" {
		fmt.Printf("UNKNOWNMODE %s\n", mode)
		os.Exit(5)
	}

	descriptor := os.NewFile(uintptr(fd), "cytale-token-descriptor")
	if descriptor == nil {
		fmt.Println("NOTOKENFD")
		os.Exit(3)
	}
	reader := newDescriptorReader(descriptor)

	// The first token, with a deadline: a descriptor that never yields one is a
	// failed session, not a hung test.
	first, err := reader.first(20 * time.Second)
	if err != nil {
		fmt.Printf("TOKEN-MISSING %v\n", err)
		os.Exit(4)
	}
	token, err := frameToken(first)
	if err != nil {
		fmt.Printf("TOKEN-MALFORMED %v\n", err)
		os.Exit(4)
	}
	fmt.Printf("TOKEN %s\n", short(token))
	fmt.Printf("USER %s\n", first.Username)

	if channel == "" {
		channel = "c-e2e"
	}
	scan(scanDirs, token)
	cols, rows := drawFrame()
	drawFrameOnResize(cols, rows)

	// The descriptor's reader: a renewal replaces the live token; the end frame
	// is why the session stopped.
	go func() {
		for {
			frame, err := reader.next()
			if err != nil {
				fmt.Println("DESCRIPTOR-CLOSED")
				os.Exit(0)
			}
			switch {
			case frame.End != "":
				fmt.Printf("END %s\n", frame.End)
				os.Exit(0)
			case frame.AccessToken != "":
				fmt.Printf("RENEW %s\n", short(frame.AccessToken))
			}
		}
	}()

	// Standard input is the member's keystrokes. `send <text>` is the one command
	// the fixture understands: it posts the text with the live token and reads it
	// back, which is the shortest path that exercises token → origin → API.
	scanner := bufio.NewScanner(os.Stdin)
	for scanner.Scan() {
		line := strings.TrimRight(scanner.Text(), "\r")
		switch {
		case strings.HasPrefix(line, "send "):
			text := strings.TrimPrefix(line, "send ")
			status, err := post(token, channel, text)
			if err != nil {
				fmt.Printf("SENT ERR %v\n", err)
				continue
			}
			fmt.Printf("SENT %d\n", status)
			readback, err := fetch(token, channel)
			if err != nil {
				fmt.Printf("READBACK-ERR %v\n", err)
				continue
			}
			for _, content := range readback {
				if content == text {
					fmt.Printf("READBACK %s\n", content)
				}
			}
		case line == "scan":
			scan(scanDirs, token)
		case line == "quit":
			// The member quitting the client: the ending the host reports as
			// `client_exited`, which prints nothing because the client owns the
			// terminal's last word. Waiting for stdin EOF would not do it — the
			// PTY's slave only sees end-of-stream when the host tears the session
			// down, so a fixture that waited for EOF could never exit first.
			fmt.Println("BYE")
			os.Exit(0)
		}
	}
	os.Exit(0)
}

// childArgsFromProcess returns the positional arguments after the `--`.
func childArgsFromProcess() []string {
	for i, arg := range os.Args {
		if arg == "--" {
			return os.Args[i+1:]
		}
	}
	return nil
}

// descriptorFrame is one NDJSON frame off the token descriptor: a token, or the
// session end. It mirrors the two frame kinds `internal/tokens` writes.
type descriptorFrame struct {
	AccessToken string `json:"access_token"`
	Username    string `json:"username"`
	Serial      uint64 `json:"serial"`
	Renewal     bool   `json:"renewal"`
	End         string `json:"end"`
}

// descriptorReader reads whole frames off the descriptor.
//
// The buffered reader is created ONCE and kept: a reader built per call would
// buffer a second frame the caller never sees, which turns an intermittent
// two-frame burst into a lost renewal.
//
// The read itself is a plain blocking read on a goroutine rather than a
// deadline on the os.File. The descriptor is an inherited pipe end, and
// `SetReadDeadline` refuses it ("file type does not support deadline"), so a
// deadline here would report a broken token path for a session that is working
// perfectly. The goroutine's channel is what bounds the wait instead.
type descriptorReader struct {
	frames chan descriptorFrame
	errs   chan error
}

func newDescriptorReader(file *os.File) *descriptorReader {
	reader := &descriptorReader{
		frames: make(chan descriptorFrame),
		errs:   make(chan error, 1),
	}
	buffered := bufio.NewReader(file)
	go func() {
		for {
			line, err := buffered.ReadString('\n')
			if err != nil {
				reader.errs <- err
				return
			}
			var frame descriptorFrame
			if err := json.Unmarshal([]byte(strings.TrimSpace(line)), &frame); err != nil {
				reader.errs <- err
				return
			}
			reader.frames <- frame
		}
	}()
	return reader
}

// first waits for the first frame, and reports a session that never got one as a
// failed session rather than a hung one.
func (r *descriptorReader) first(timeout time.Duration) (descriptorFrame, error) {
	select {
	case frame := <-r.frames:
		return frame, nil
	case err := <-r.errs:
		return descriptorFrame{}, err
	case <-time.After(timeout):
		return descriptorFrame{}, errors.New("no frame arrived on the token descriptor before the deadline")
	}
}

// next waits for the following frame, or reports why the descriptor will produce
// no more.
func (r *descriptorReader) next() (descriptorFrame, error) {
	select {
	case frame := <-r.frames:
		return frame, nil
	case err := <-r.errs:
		return descriptorFrame{}, err
	}
}

func frameToken(frame descriptorFrame) (string, error) {
	if frame.AccessToken == "" {
		return "", errors.New("the frame carried no access_token")
	}
	return frame.AccessToken, nil
}

// short keeps a secret off the wire while still identifying which mint it was.
func short(token string) string {
	if len(token) <= 12 {
		return token
	}
	return token[:12]
}

// scan reports whether the token is readable anywhere in the given directories.
func scan(dirs []string, token string) {
	hits := 0
	for _, dir := range dirs {
		found, err := filesContaining(dir, token)
		if err != nil {
			fmt.Printf("SCAN-ERR %s %v\n", dir, err)
			continue
		}
		for _, path := range found {
			hits++
			fmt.Printf("ONDISK %s\n", path)
		}
	}
	if hits == 0 {
		fmt.Println("DISKCLEAN")
	}
}

// drawFrame renders the two-column frame at the PTY's current width. The row's
// LENGTH is the point: a resize is only observable through what is drawn.
func drawFrame() (int, int) {
	cols, rows, err := ptySize(0)
	if err != nil {
		fmt.Printf("SIZE-ERR %v\n", err)
		return 0, 0
	}
	fmt.Printf("FRAME %dx%d\n", cols, rows)
	for _, line := range frameLines(cols) {
		fmt.Println(line)
	}
	fmt.Printf("SIZE %dx%d\n", cols, rows)
	return cols, rows
}

// drawFrameOnResize polls the PTY's size and redraws when it changes. Polling
// rather than SIGWINCH, because a missed signal would make the assertion flaky
// for a reason that has nothing to do with the host.
//
// The baseline is the size the last frame was DRAWN at, passed in. Reading it
// inside the goroutine raced the test: on a loaded box the resize could land
// before the goroutine's first read, which then took the new size as the old
// one and never redrew (the resize test hung in shell.rest()).
func drawFrameOnResize(lastCols, lastRows int) {
	go func() {
		for {
			time.Sleep(50 * time.Millisecond)
			cols, rows, err := ptySize(0)
			if err != nil || (cols == lastCols && rows == lastRows) {
				continue
			}
			lastCols, lastRows = drawFrame()
		}
	}()
}

// frameLines draws the two-column frame AT the given width, so the drawn row and
// the reported width always agree.
func frameLines(cols int) []string {
	if cols < frameNavWidth+8 {
		cols = frameNavWidth + 8
	}
	content := cols - frameNavWidth - 3
	border := "+" + strings.Repeat("-", frameNavWidth) + "+" + strings.Repeat("-", content) + "+"
	row := "| " + pad("cytale", frameNavWidth-1) + "| " + pad(channelName, content-1) + "|"
	return []string{border, row, border}
}

func pad(value string, width int) string {
	if len(value) >= width {
		return value[:width]
	}
	return value + strings.Repeat(" ", width-len(value))
}

// ptySize reads the terminal's size off a descriptor — the accessor a real
// terminal client uses to decide how wide to draw.
func ptySize(fd uintptr) (cols, rows int, err error) {
	type winsize struct {
		Row, Col, Xpixel, Ypixel uint16
	}
	size := &winsize{}
	_, _, errno := syscall.Syscall(syscall.SYS_IOCTL, fd, uintptr(syscall.TIOCGWINSZ), uintptr(unsafe.Pointer(size))) //nolint:gosec // the ioctl a terminal client uses
	if errno != 0 {
		return 0, 0, errno
	}
	return int(size.Col), int(size.Row), nil
}

// post sends one message to the origin's REST surface with the live token, which
// is what a real client does with it.
func post(token, channel, text string) (int, error) {
	body, err := json.Marshal(map[string]any{"channel_id": channel, "content": text})
	if err != nil {
		return 0, err
	}
	req, err := http.NewRequest(http.MethodPost, originURL()+"/api/v1/messages", bytes.NewReader(body))
	if err != nil {
		return 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)

	resp, err := (&http.Client{Timeout: 5 * time.Second}).Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close() //nolint:errcheck // the status is the fact
	_, _ = io.Copy(io.Discard, resp.Body)
	return resp.StatusCode, nil
}

// fetch reads the channel's messages back through the API.
func fetch(token, channel string) ([]string, error) {
	req, err := http.NewRequest(http.MethodGet, originURL()+"/api/v1/messages?channel_id="+channel, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)

	resp, err := (&http.Client{Timeout: 5 * time.Second}).Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close() //nolint:errcheck // the body is read below

	var envelope struct {
		Messages []struct {
			Content string `json:"content"`
		} `json:"messages"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&envelope); err != nil {
		return nil, err
	}
	contents := make([]string, 0, len(envelope.Messages))
	for _, message := range envelope.Messages {
		contents = append(contents, message.Content)
	}
	return contents, nil
}

// originURL is the host-configured origin the host put in the child's
// environment. The session cannot override it (R14), which is why the fixture
// reads it from the environment rather than from anything it was sent.
func originURL() string {
	return strings.TrimSuffix(os.Getenv(session.OriginEnv), "/")
}
