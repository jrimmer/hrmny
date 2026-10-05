package session

import (
	"bufio"
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
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
	"os/exec"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"charm.land/log/v2"
	"charm.land/ssh"
	gossh "golang.org/x/crypto/ssh"

	"github.com/jrimmer/hrmny/apps/ssh-host/internal/auth"
	"github.com/jrimmer/hrmny/apps/ssh-host/internal/bridge"
	"github.com/jrimmer/hrmny/apps/ssh-host/internal/tokens"
)

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

// fakeContext is an ssh.Context. Every method the interface needs is exported,
// so the session layer can be driven without a network.
type fakeContext struct {
	context.Context

	mu        sync.Mutex
	values    map[any]any
	perms     *ssh.Permissions
	user      string
	sessionID string
}

func newFakeContext(user string, extensions map[string]string) *fakeContext {
	return &fakeContext{
		Context:   context.Background(),
		values:    map[any]any{},
		perms:     &ssh.Permissions{Permissions: &gossh.Permissions{Extensions: extensions}},
		user:      user,
		sessionID: "SID-" + user,
	}
}

func (c *fakeContext) Lock()   { c.mu.Lock() }
func (c *fakeContext) Unlock() { c.mu.Unlock() }

func (c *fakeContext) User() string                  { return c.user }
func (c *fakeContext) SessionID() string             { return c.sessionID }
func (c *fakeContext) ClientVersion() string         { return "SSH-2.0-test-client" }
func (c *fakeContext) ServerVersion() string         { return "SSH-2.0-Hrmny-SSH-Host" }
func (c *fakeContext) Permissions() *ssh.Permissions { return c.perms }

func (c *fakeContext) RemoteAddr() net.Addr {
	return &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 40001}
}

func (c *fakeContext) LocalAddr() net.Addr {
	return &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 2222}
}

func (c *fakeContext) SetValue(key, value any) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.values[key] = value
}

func (c *fakeContext) Value(key any) any {
	c.mu.Lock()
	defer c.mu.Unlock()
	if v, ok := c.values[key]; ok {
		return v
	}
	return c.Context.Value(key)
}

// fakeSession is an ssh.Session whose writes are captured instead of sent.
type fakeSession struct {
	ctx *fakeContext

	pty     ssh.Pty
	ptyChan chan ssh.Window
	hasPTY  bool

	out      bytes.Buffer
	stderr   bytes.Buffer
	environ  []string
	rawCmd   string
	exited   bool
	exitCode int
	exitOnce sync.Once
}

func newFakeSession(ctx *fakeContext) *fakeSession {
	return &fakeSession{
		ctx:     ctx,
		pty:     ssh.Pty{Term: "xterm-256color", Window: ssh.Window{Width: 120, Height: 40}},
		ptyChan: make(chan ssh.Window, 1),
	}
}

func (s *fakeSession) Read([]byte) (int, error)    { return 0, io.EOF }
func (s *fakeSession) Write(p []byte) (int, error) { return s.out.Write(p) }
func (s *fakeSession) Close() error                { return nil }
func (s *fakeSession) CloseWrite() error           { return nil }
func (s *fakeSession) Stderr() io.ReadWriter       { return &s.stderr }

func (s *fakeSession) SendRequest(string, bool, []byte) (bool, error) { return false, nil }

func (s *fakeSession) User() string                 { return s.ctx.User() }
func (s *fakeSession) RemoteAddr() net.Addr         { return s.ctx.RemoteAddr() }
func (s *fakeSession) LocalAddr() net.Addr          { return s.ctx.LocalAddr() }
func (s *fakeSession) Environ() []string            { return append([]string(nil), s.environ...) }
func (s *fakeSession) Command() []string            { return nil }
func (s *fakeSession) RawCommand() string           { return s.rawCmd }
func (s *fakeSession) Subsystem() string            { return "" }
func (s *fakeSession) PublicKey() ssh.PublicKey     { return nil }
func (s *fakeSession) Context() ssh.Context         { return s.ctx }
func (s *fakeSession) Permissions() ssh.Permissions { return *s.ctx.Permissions() }
func (s *fakeSession) EmulatedPty() bool            { return false }
func (s *fakeSession) Signals(chan<- ssh.Signal)    {}
func (s *fakeSession) Break(chan<- bool)            {}

func (s *fakeSession) Pty() (ssh.Pty, <-chan ssh.Window, bool) {
	if !s.hasPTY {
		return ssh.Pty{}, s.ptyChan, false
	}
	return s.pty, s.ptyChan, true
}

func (s *fakeSession) Exit(code int) error {
	s.exitOnce.Do(func() {
		s.exited = true
		s.exitCode = code
	})
	return nil
}

func (s *fakeSession) output() string { return s.out.String() }

// recordingObserver captures the lifecycle ordering the design guarantees.
type recordingObserver struct {
	mu      sync.Mutex
	events  []string
	reasons []EndReason
}

func (o *recordingObserver) record(event string, reason EndReason) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.events = append(o.events, event)
	o.reasons = append(o.reasons, reason)
}

func (o *recordingObserver) FirstTokenWritten(string, time.Time) {
	o.record("first-token", EndReason{})
}
func (o *recordingObserver) ChildSpawned(string, time.Time) { o.record("spawned", EndReason{}) }
func (o *recordingObserver) TokenRenewed(string, time.Time) { o.record("renewed", EndReason{}) }

func (o *recordingObserver) SessionEnded(_ string, reason EndReason, _ time.Time) {
	o.record("ended", reason)
}

func (o *recordingObserver) snapshot() ([]string, []EndReason) {
	o.mu.Lock()
	defer o.mu.Unlock()
	return append([]string(nil), o.events...), append([]EndReason(nil), o.reasons...)
}

func (o *recordingObserver) saw(event string) bool {
	events, _ := o.snapshot()
	for _, e := range events {
		if e == event {
			return true
		}
	}
	return false
}

// stubMinter is a Minter with a programmable answer.
type stubMinter struct {
	mu    sync.Mutex
	calls int
	reqs  []bridge.MintRequest
	reply func(call int, req bridge.MintRequest) (bridge.Minted, error)
}

func (m *stubMinter) Mint(_ context.Context, req bridge.MintRequest) (bridge.Minted, error) {
	m.mu.Lock()
	m.calls++
	call := m.calls
	m.reqs = append(m.reqs, req)
	reply := m.reply
	m.mu.Unlock()

	if reply == nil {
		return bridge.Minted{
			AccessToken: fmt.Sprintf("token-%s-%d", req.Principal, call),
			TokenType:   "Bearer",
			ExpiresIn:   900,
			Username:    req.Principal,
		}, nil
	}
	return reply(call, req)
}

func (m *stubMinter) callCount() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.calls
}

func (m *stubMinter) lastRequest() bridge.MintRequest {
	m.mu.Lock()
	defer m.mu.Unlock()
	if len(m.reqs) == 0 {
		return bridge.MintRequest{}
	}
	return m.reqs[len(m.reqs)-1]
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// testAuthority is a throwaway CA that exists only in this process; the test
// deployment's key is never written by a test.
type testAuthority struct {
	signer gossh.Signer
	public gossh.PublicKey
}

func newTestAuthority(t *testing.T) testAuthority {
	t.Helper()
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate CA: %v", err)
	}
	signer, err := gossh.NewSignerFromKey(priv)
	if err != nil {
		t.Fatalf("CA signer: %v", err)
	}
	return testAuthority{signer: signer, public: signer.PublicKey()}
}

func newTestKey(t *testing.T) gossh.Signer {
	t.Helper()
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	signer, err := gossh.NewSignerFromKey(priv)
	if err != nil {
		t.Fatalf("signer: %v", err)
	}
	return signer
}

// signedCert is a user certificate for principal, signed by authority.
func signedCert(t *testing.T, authority testAuthority, principal string, subject gossh.Signer, tweak func(*gossh.Certificate)) *gossh.Certificate {
	t.Helper()
	certificate := &gossh.Certificate{
		Key:             subject.PublicKey(),
		Serial:          1234500,
		CertType:        gossh.UserCert,
		KeyId:           "cytale-session-test",
		ValidPrincipals: []string{principal},
		ValidAfter:      uint64(time.Now().Add(-time.Minute).Unix()),
		ValidBefore:     uint64(time.Now().Add(time.Hour).Unix()),
		Permissions:     gossh.Permissions{CriticalOptions: map[string]string{}, Extensions: map[string]string{}},
		Reserved:        []byte{},
	}
	if tweak != nil {
		tweak(certificate)
	}
	if err := certificate.SignCert(rand.Reader, authority.signer); err != nil {
		t.Fatalf("sign certificate: %v", err)
	}
	return certificate
}

// testHostSettings is the minimum a Host needs to be constructible.
type testHostSettings struct {
	authority testAuthority
	minter    *stubMinter
	observer  Observer
	command   []string
	args      []string
	dir       string
	origin    string
	tune      func(*Config)
}

func newTestHost(t *testing.T, settings testHostSettings) (*Host, *stubMinter) {
	t.Helper()

	minter := settings.minter
	if minter == nil {
		minter = &stubMinter{}
	}

	verifier, err := auth.NewVerifier([]gossh.PublicKey{settings.authority.public})
	if err != nil {
		t.Fatalf("NewVerifier: %v", err)
	}

	command := settings.command
	if command == nil {
		if _, err := os.Stat(os.Args[0]); err != nil {
			t.Fatalf("the test binary is not on disk: %v", err)
		}
		command = []string{os.Args[0]}
	}

	dir := settings.dir
	if dir == "" {
		dir = t.TempDir()
	}

	origin := settings.origin
	if origin == "" {
		origin = "https://chat.test.invalid"
	}

	cfg := Config{
		ListenAddress: "127.0.0.1:0",
		ClientCommand: command,
		ClientArgs:    settings.args,
		ClientDir:     dir,
		Origin:        origin,
		ChildPath:     "/usr/bin:/bin",
		Observer:      settings.observer,
	}
	if settings.tune != nil {
		settings.tune(&cfg)
	}

	host, err := NewHost(cfg, verifier, minter, newTestKey(t))
	if err != nil {
		t.Fatalf("NewHost: %v", err)
	}
	return host, minter
}

// identityExtensionsFor builds the Permissions.Extensions a verified connection
// carries, so a fake session goes down the same path a real one does.
func identityExtensionsFor(t *testing.T, principal string, serial uint64) map[string]string {
	t.Helper()
	encoded, err := auth.Identity{
		Serial:      serial,
		Principal:   principal,
		Fingerprint: "SHA256:test-fingerprint",
		KeyID:       "cytale-session-test",
		ValidBefore: time.Now().Add(time.Hour),
	}.Marshal()
	if err != nil {
		t.Fatalf("marshal identity: %v", err)
	}
	return map[string]string{auth.IdentityExtensionKey: encoded}
}

func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// ---------------------------------------------------------------------------
// The child's environment (R12a, R14)
// ---------------------------------------------------------------------------

// TestChildEnvIsExactlyTheHostsEnvironment is the R14 property: the child's
// environment contains PATH, TERM, the host-configured origin and the descriptor
// number, and nothing else.
func TestChildEnvIsExactlyTheHostsEnvironment(t *testing.T) {
	cfg := Config{ChildPath: "/usr/bin:/bin", Origin: "https://chat.test.invalid"}
	env := ChildEnv(cfg, "xterm-256color", 3)

	want := []string{
		"PATH=/usr/bin:/bin",
		"TERM=xterm-256color",
		"CYTALE_ORIGIN=https://chat.test.invalid",
		"CYTALE_TOKEN_FD=3",
	}
	if len(env) != len(want) {
		t.Fatalf("environment has %d entries, want exactly %d: %v", len(env), len(want), env)
	}
	for i, entry := range want {
		if env[i] != entry {
			t.Errorf("env[%d] = %q, want %q", i, env[i], entry)
		}
	}
}

// TestChildEnvIgnoresSessionSuppliedValues is the other half of R14, and it is
// asserted rather than assumed: a session that could set CYTALE_ORIGIN could
// redirect a freshly minted token at a server of its own choosing.
func TestChildEnvIgnoresSessionSuppliedValues(t *testing.T) {
	sess := newFakeSession(newFakeContext("jordan", map[string]string{}))
	sess.environ = []string{
		"CYTALE_ORIGIN=https://attacker.invalid",
		"CYTALE_TOKEN_FD=99",
		"PATH=/tmp/evil",
		"LD_PRELOAD=/tmp/evil.so",
	}

	cfg := Config{ChildPath: "/usr/bin:/bin", Origin: "https://chat.test.invalid"}
	env := ChildEnv(cfg, "xterm-256color", 3)
	joined := strings.Join(env, "\n")

	if strings.Contains(joined, "attacker.invalid") {
		t.Fatalf("the session's origin reached the child: %v", env)
	}
	if strings.Contains(joined, "CYTALE_TOKEN_FD=99") {
		t.Fatalf("the session's descriptor number reached the child: %v", env)
	}
	if strings.Contains(joined, "LD_PRELOAD") {
		t.Fatalf("a session-supplied variable reached the child: %v", env)
	}
	if !strings.Contains(joined, "CYTALE_ORIGIN=https://chat.test.invalid") {
		t.Fatalf("the host origin is not in the child's environment: %v", env)
	}

	// The session's Environ() is never consulted, which is what makes the
	// refusal of environment requests and this construction agree.
	if got := ChildEnv(cfg, "xterm-256color", 3); len(got) != 4 {
		t.Fatalf("environment has %d entries: %v", len(got), got)
	}
}

// TestTerminalNameSanitizesHostileValue keeps a member-supplied TERM from
// carrying anything but a terminal name into a child's environment.
func TestTerminalNameSanitizesHostileValue(t *testing.T) {
	cases := map[string]string{
		"xterm-256color":            "xterm-256color",
		"":                          "xterm-256color",
		"VT100":                     "VT100",
		"xterm\nCYTALE_ORIGIN=evil": "xtermCYTALE_ORIGINevil",
		"a;rm -rf /":                "arm-rf",
		"screen.xterm-256color":     "screen.xterm-256color",
		strings.Repeat("a", 200):    strings.Repeat("a", 64),
	}
	for input, want := range cases {
		if got := terminalName(input); got != want {
			t.Errorf("terminalName(%q) = %q, want %q", input, got, want)
		}
	}
}

// ---------------------------------------------------------------------------
// The session-end vocabulary (R19a, R26a)
// ---------------------------------------------------------------------------

// TestEveryReasonHasAMemberMessage is the vocabulary's completeness check: a
// session that ends must be able to say why, except for a clean client exit,
// where the client owns the terminal's last word.
func TestEveryReasonHasAMemberMessage(t *testing.T) {
	const origin = "https://chat.test.invalid"
	reissue := ReissueURL(origin)
	if !strings.HasSuffix(reissue, "/#/settings/ssh") {
		t.Fatalf("ReissueURL = %q, want the SSH settings page", reissue)
	}

	for _, code := range []ReasonCode{
		ReasonClientFailed, ReasonClientStartFailed, ReasonNoPTY, ReasonCommandNotSupported,
		ReasonIdentityMissing, ReasonSessionLimit, ReasonBridgeUnreachable, ReasonBridgeRefused,
		ReasonCertificateExpired, ReasonCredentialEpochMoved, ReasonTokenPathFailed,
		ReasonMaxDuration, ReasonIdleTimeout, ReasonConnectionLost,
	} {
		reason := EndReason{Code: code}
		if strings.TrimSpace(reason.MemberMessage(origin)) == "" {
			t.Errorf("%s has no member message", code)
		}

		rendering := reason.Rendering(origin)
		if !strings.Contains(rendering, string(code)) {
			t.Errorf("%s does not name its code in the rendering: %q", code, rendering)
		}
		if !strings.HasSuffix(rendering, "\r\n") {
			t.Errorf("%s rendering is not newline-terminated: %q", code, rendering)
		}
		if bare := strings.Count(rendering, "\n") - strings.Count(rendering, "\r\n"); bare != 0 {
			t.Errorf("%s rendering uses a bare newline, which a raw SSH channel does not translate: %q", code, rendering)
		}
		if reason.ExitCode() != 1 {
			t.Errorf("%s exit code = %d, want 1", code, reason.ExitCode())
		}
	}

	if message := (EndReason{Code: ReasonClientExited}).MemberMessage(origin); message != "" {
		t.Errorf("a clean client exit printed %q; the client owns the terminal's last word", message)
	}
	if rendering := (EndReason{Code: ReasonClientExited}).Rendering(origin); rendering != "" {
		t.Errorf("a clean client exit rendered %q", rendering)
	}
	if code := (EndReason{Code: ReasonClientExited}).ExitCode(); code != 0 {
		t.Errorf("a clean client exit reported status %d", code)
	}

	for _, code := range []ReasonCode{ReasonCertificateExpired, ReasonCredentialEpochMoved, ReasonBridgeRefused, ReasonTokenPathFailed} {
		reason := EndReason{Code: code}
		if !reason.Reissued() {
			t.Errorf("%s should be marked as re-issue-remedied", code)
		}
		if !strings.Contains(reason.MemberMessage(origin), reissue) {
			t.Errorf("%s does not name the re-issue URL", code)
		}
	}
	if (EndReason{Code: ReasonIdleTimeout}).Reissued() {
		t.Error("an idle timeout should not be marked as re-issue-remedied")
	}
}

// TestSessionEndReasonIsRenderedInert is R26a applied to this host's own output:
// the bridge's message is server-supplied text on its way to a terminal, so a
// control sequence inside it must not reach the member's screen.
func TestSessionEndReasonIsRenderedInert(t *testing.T) {
	hostile := "\x1b[2J\x1b[31mcleared\x07\x08\r\n\x1b]0;pwned\x07"
	reason := EndReason{
		Code:         ReasonBridgeRefused,
		BridgeReason: "unknown_serial\x1b[2J",
		Detail:       hostile,
	}

	rendering := reason.Rendering("https://chat.test.invalid")
	for _, banned := range []string{"\x1b", "\x07", "\x08", "\x0b", "\x0c"} {
		if strings.Contains(rendering, banned) {
			t.Fatalf("the rendering carries control character %q: %q", banned, rendering)
		}
	}
	if !strings.Contains(rendering, "cleared") {
		t.Fatalf("sanitizing removed the message's text as well as its escapes: %q", rendering)
	}
}

// TestReissueURLCopesWithATrailingSlash keeps the URL well-formed whatever the
// operator configured.
func TestReissueURLCopesWithATrailingSlash(t *testing.T) {
	if got, want := ReissueURL("https://chat.test.invalid/"), "https://chat.test.invalid/#/settings/ssh"; got != want {
		t.Fatalf("ReissueURL = %q, want %q", got, want)
	}
}

// TestEndFrameVocabularyIsTheLiveClientRule states the rule endFrameCode
// enforces, as the two lists it splits the vocabulary into.
//
// It is deliberately a list of SPELLINGS as well as codes: the frame carries the
// code verbatim, so the string a client compares against is the same string the
// host's vocabulary names, and this test fails if the two ever part company. The
// client's own vocabulary list (apps/tui/src/session/tokenPipe.ts,
// SESSION_END_REASONS) is asserted against the same six spellings by that
// package's suite; a change here that is not mirrored there fails over there.
func TestEndFrameVocabularyIsTheLiveClientRule(t *testing.T) {
	// A host-decided ending with a client still running: the reason travels.
	carried := []struct {
		code ReasonCode
		wire string
	}{
		{ReasonMaxDuration, "max_session_duration"},
		{ReasonIdleTimeout, "idle_timeout"},
		{ReasonCertificateExpired, "certificate_expired"},
		{ReasonCredentialEpochMoved, "credential_epoch_moved"},
		{ReasonBridgeRefused, "bridge_refused"},
		{ReasonTokenPathFailed, "token_path_failed"},
	}
	for _, entry := range carried {
		if string(entry.code) != entry.wire {
			t.Fatalf("%s is spelled %q on the wire, want the code itself (%q)", entry.code, entry.wire, string(entry.code))
		}
		got, ok := endFrameCode(entry.code)
		if !ok {
			t.Fatalf("%s carries no end frame, but the host decides it while the client is still running", entry.code)
		}
		if got != entry.wire {
			t.Fatalf("endFrameCode(%s) = %q, want %q", entry.code, got, entry.wire)
		}
	}

	// No live reader, so no frame: the ending IS the client's exit or failure, or
	// the session ended before a child (and therefore a descriptor) existed, or
	// the connection that carried the member's terminal is gone.
	notCarried := []ReasonCode{
		ReasonClientExited, ReasonClientFailed, ReasonClientStartFailed,
		ReasonNoPTY, ReasonCommandNotSupported, ReasonIdentityMissing,
		ReasonSessionLimit, ReasonBridgeUnreachable, ReasonConnectionLost,
	}
	for _, code := range notCarried {
		if got, ok := endFrameCode(code); ok {
			t.Fatalf("%s carries the end frame %q, but no live client is left to read it", code, got)
		}
	}

	// Every reason in the vocabulary is on exactly one of the two lists, so a new
	// cause cannot be added without deciding which side of the rule it falls on.
	for _, code := range []ReasonCode{
		ReasonClientExited, ReasonClientFailed, ReasonClientStartFailed, ReasonNoPTY,
		ReasonCommandNotSupported, ReasonIdentityMissing, ReasonSessionLimit,
		ReasonBridgeUnreachable, ReasonBridgeRefused, ReasonCertificateExpired,
		ReasonCredentialEpochMoved, ReasonTokenPathFailed, ReasonMaxDuration,
		ReasonIdleTimeout, ReasonConnectionLost,
	} {
		_, ok := endFrameCode(code)
		onCarried := false
		for _, entry := range carried {
			if entry.code == code {
				onCarried = true
				break
			}
		}
		if ok != onCarried {
			t.Fatalf("%s is on the frame list (%t) but endFrameCode says %t", code, onCarried, ok)
		}
	}
}

// ---------------------------------------------------------------------------
// Caps (R13b)
// ---------------------------------------------------------------------------

func TestLimiterCapsPerAccount(t *testing.T) {
	limiter := NewLimiter(0, 1, 0)

	release, _, ok := limiter.Acquire("jordan", "conn-1")
	if !ok {
		t.Fatal("the first session was refused")
	}

	// The point of the per-account cap: one member occupying the aggregate cap
	// must not lock every other member out.
	if _, reason, ok := limiter.Acquire("jordan", "conn-2"); ok {
		t.Fatal("a second session for the same account was allowed past the per-account cap")
	} else if reason.Code != ReasonSessionLimit {
		t.Fatalf("reason = %v, want session_limit", reason)
	}

	if _, _, ok := limiter.Acquire("someone-else", "conn-3"); !ok {
		t.Fatal("the per-account cap refused a different account")
	}

	release()
	if _, _, ok := limiter.Acquire("jordan", "conn-4"); !ok {
		t.Fatal("a released slot was not reusable")
	}

	// Release is idempotent: a double release must not free someone else's slot.
	release()
	release()
	if total, _, _ := limiter.Counts(); total != 2 {
		t.Fatalf("total after a double release = %d, want 2", total)
	}
}

func TestLimiterCapsAggregateAndPerConnection(t *testing.T) {
	t.Run("aggregate", func(t *testing.T) {
		limiter := NewLimiter(2, 0, 0)
		if _, _, ok := limiter.Acquire("a", "c1"); !ok {
			t.Fatal("session 1 refused")
		}
		if _, _, ok := limiter.Acquire("b", "c2"); !ok {
			t.Fatal("session 2 refused")
		}
		if _, reason, ok := limiter.Acquire("c", "c3"); ok {
			t.Fatal("the aggregate cap did not refuse a third session")
		} else if reason.Code != ReasonSessionLimit {
			t.Fatalf("reason = %v", reason)
		}
	})

	t.Run("per connection", func(t *testing.T) {
		limiter := NewLimiter(0, 0, 1)
		if _, _, ok := limiter.Acquire("a", "c1"); !ok {
			t.Fatal("session 1 refused")
		}
		if _, reason, ok := limiter.Acquire("a", "c1"); ok {
			t.Fatal("a second session on one connection was allowed")
		} else if reason.Code != ReasonSessionLimit {
			t.Fatalf("reason = %v", reason)
		}
		if _, _, ok := limiter.Acquire("a", "c2"); !ok {
			t.Fatal("a session on another connection was refused")
		}
	})
}

// TestConnSupervisorCapsPreAuth is R13b's connection cap: over the cap the
// connection callback returns nil, which makes the server close the connection
// before the handshake.
func TestConnSupervisorCapsPreAuth(t *testing.T) {
	supervisor := NewConnSupervisor(2)

	first := newFakeConn(1001)
	second := newFakeConn(1002)
	third := newFakeConn(1003)

	admittedFirst := supervisor.wrap(first)
	if admittedFirst == nil {
		t.Fatal("connection 1 was refused")
	}
	if supervisor.wrap(second) == nil {
		t.Fatal("connection 2 was refused")
	}
	if got := supervisor.wrap(third); got != nil {
		t.Fatal("connection 3 was admitted over the cap")
	}
	if supervisor.Refused() != 1 {
		t.Fatalf("refused = %d, want 1", supervisor.Refused())
	}
	if supervisor.Pending() != 2 {
		t.Fatalf("pending = %d, want 2", supervisor.Pending())
	}

	// Closing a supervised connection frees its slot.
	_ = admittedFirst.Close()
	if supervisor.Pending() != 1 {
		t.Fatalf("pending after close = %d, want 1", supervisor.Pending())
	}

	// A connection that authenticates is no longer pre-auth work; its session
	// is bounded by the session caps instead.
	_ = second.Close()
	if supervisor.wrap(second) == nil {
		t.Fatal("a freed slot was not reusable")
	}
	supervisor.authenticated(&probeConn{port: 1002})
	if supervisor.Pending() != 0 {
		t.Fatalf("pending after authentication = %d, want 0", supervisor.Pending())
	}
}

// TestConnSupervisorDisablesAtZero keeps the cap configurable off.
func TestConnSupervisorDisablesAtZero(t *testing.T) {
	supervisor := NewConnSupervisor(0)
	for i := 0; i < 5; i++ {
		if supervisor.wrap(newFakeConn(2000+i)) == nil {
			t.Fatalf("connection %d was refused by a disabled cap", i)
		}
	}
}

// fakeConn is a net.Conn with a distinct remote port per instance, which is the
// key the supervisor tracks.
type fakeConn struct {
	net.Conn
	port   int
	closed bool
}

func newFakeConn(port int) *fakeConn { return &fakeConn{port: port} }

func (c *fakeConn) RemoteAddr() net.Addr {
	return &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1), Port: c.port}
}
func (c *fakeConn) LocalAddr() net.Addr              { return &net.TCPAddr{IP: net.IPv4(10, 0, 0, 1), Port: 2222} }
func (c *fakeConn) Read([]byte) (int, error)         { return 0, io.EOF }
func (c *fakeConn) Write(p []byte) (int, error)      { return len(p), nil }
func (c *fakeConn) Close() error                     { c.closed = true; return nil }
func (c *fakeConn) SetDeadline(time.Time) error      { return nil }
func (c *fakeConn) SetReadDeadline(time.Time) error  { return nil }
func (c *fakeConn) SetWriteDeadline(time.Time) error { return nil }

func TestActivityTrackerRecordsTransportTraffic(t *testing.T) {
	tracker := &ActivityTracker{}
	tracker.Touch()
	time.Sleep(5 * time.Millisecond)
	if idle := tracker.IdleFor(time.Now()); idle < 5*time.Millisecond {
		t.Fatalf("idle = %v, want at least 5ms", idle)
	}

	conn := &ActivityConn{Conn: newFakeConn(3000), tracker: tracker}
	time.Sleep(20 * time.Millisecond)
	if idle := tracker.IdleFor(time.Now()); idle < 20*time.Millisecond {
		t.Fatalf("idle = %v, want at least 20ms before any traffic", idle)
	}
	if _, err := conn.Write([]byte("x")); err != nil {
		t.Fatalf("write: %v", err)
	}
	if idle := tracker.IdleFor(time.Now()); idle > 20*time.Millisecond {
		t.Fatalf("idle = %v after a write; a write did not count as activity", idle)
	}
}

// ---------------------------------------------------------------------------
// The assembled host
// ---------------------------------------------------------------------------

func TestNewHostValidatesConfiguration(t *testing.T) {
	authority := newTestAuthority(t)
	verifier, err := auth.NewVerifier([]gossh.PublicKey{authority.public})
	if err != nil {
		t.Fatalf("NewVerifier: %v", err)
	}
	dir := t.TempDir()

	base := func() Config {
		return Config{
			ClientCommand: []string{os.Args[0]},
			ClientDir:     dir,
			Origin:        "https://chat.test.invalid",
		}
	}

	filePath := filepath.Join(dir, "a-file")
	if err := os.WriteFile(filePath, []byte("x"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}

	cases := map[string]Config{}
	{
		c := base()
		c.ClientCommand = nil
		cases["no command"] = c
	}
	{
		c := base()
		c.ClientCommand = []string{"client"}
		cases["relative command"] = c
	}
	{
		c := base()
		c.ClientCommand = []string{filepath.Join(dir, "absent")}
		cases["missing command file"] = c
	}
	{
		c := base()
		c.ClientDir = ""
		cases["no working directory"] = c
	}
	{
		c := base()
		c.ClientDir = filePath
		cases["working directory that is a file"] = c
	}
	{
		c := base()
		c.Origin = "chat.test.invalid"
		cases["origin without a scheme"] = c
	}

	for name, cfg := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := NewHost(cfg, verifier, &stubMinter{}, newTestKey(t)); err == nil {
				t.Fatal("NewHost accepted an unusable configuration")
			}
		})
	}

	if _, err := NewHost(base(), nil, &stubMinter{}, newTestKey(t)); err == nil {
		t.Fatal("NewHost accepted a nil verifier")
	}
	if _, err := NewHost(base(), verifier, nil, newTestKey(t)); err == nil {
		t.Fatal("NewHost accepted a nil minter")
	}
	if _, err := NewHost(base(), verifier, &stubMinter{}, nil); err == nil {
		t.Fatal("NewHost accepted a nil host key")
	}
}

// TestNewHostWiresTheSeamsAndFailsClosed is R11's boot assertion, asserted
// against the server the host actually builds: no fail-open, no shadowing
// handler, no second authentication method, no subsystem, no forwarding.
func TestNewHostWiresTheSeamsAndFailsClosed(t *testing.T) {
	authority := newTestAuthority(t)
	host, _ := newTestHost(t, testHostSettings{authority: authority})
	server := host.Server()

	if server.PublicKeyHandler != nil {
		t.Error("Server.PublicKeyHandler is set; it would make the fork shadow the certificate verifier")
	}
	if server.PasswordHandler != nil {
		t.Error("a password handler is installed")
	}
	if server.KeyboardInteractiveHandler != nil {
		t.Error("a keyboard-interactive handler is installed")
	}
	if len(server.SubsystemHandlers) != 0 {
		t.Errorf("subsystem handlers are installed: %v", server.SubsystemHandlers)
	}
	if server.ChannelHandlers["session"] == nil {
		t.Error("no session channel handler")
	}
	for _, forwarding := range []string{"direct-tcpip", "forwarded-tcpip"} {
		if server.ChannelHandlers[forwarding] == nil {
			t.Errorf("no explicit refusal for the %s channel type", forwarding)
		}
	}
	for _, forward := range []string{"tcpip-forward", "cancel-tcpip-forward"} {
		if server.RequestHandlers[forward] == nil {
			t.Errorf("no explicit refusal for %s", forward)
		}
	}

	cfg := server.ServerConfigCallback(nil)
	if cfg == nil {
		t.Fatal("ServerConfigCallback produced no config")
	}
	if cfg.PublicKeyCallback == nil {
		t.Fatal("PublicKeyCallback is nil: the verifier is not registered")
	}

	// The verifier must BE the callback, not a wrapper: assigning anything else
	// is how the certificate's critical options stop reaching the transport.
	if got, want := reflect.ValueOf(cfg.PublicKeyCallback).Pointer(), reflect.ValueOf(host.verifier.Authenticate).Pointer(); got != want {
		t.Errorf("PublicKeyCallback is not the verifier's own method (0x%x vs 0x%x)", got, want)
	}
	if _, err := cfg.PublicKeyCallback(&probeConn{port: 1}, &gossh.Certificate{}); err == nil {
		t.Error("the callback accepted a certificate with no type")
	}

	if cfg.NoClientAuth {
		t.Fatal("NoClientAuth is true: the server would accept unauthenticated connections")
	}
	if cfg.PasswordCallback != nil || cfg.KeyboardInteractiveCallback != nil {
		t.Fatal("a second authentication method is offered")
	}
	if cfg.MaxAuthTries != DefaultMaxAuthTries {
		t.Errorf("MaxAuthTries = %d, want %d", cfg.MaxAuthTries, DefaultMaxAuthTries)
	}
	if len(cfg.PublicKeyAuthAlgorithms) == 0 {
		t.Fatal("PublicKeyAuthAlgorithms is empty, which x/crypto treats as the defaults")
	}
	if server.HandshakeTimeout != DefaultHandshakeTimeout {
		t.Errorf("HandshakeTimeout = %v, want %v", server.HandshakeTimeout, DefaultHandshakeTimeout)
	}
	if server.MaxTimeout <= host.Config().MaxSessionDuration {
		t.Error("the transport timeout does not sit above the session bound")
	}
}

// probeConn is the ConnMetadata a callback probe needs. Its port makes it
// addressable the way a real connection is, which is the key the supervisor
// releases a slot by.
type probeConn struct{ port int }

func (c *probeConn) User() string          { return "jordan" }
func (c *probeConn) SessionID() []byte     { return []byte("probe") }
func (c *probeConn) ClientVersion() []byte { return []byte("SSH-2.0-probe") }
func (c *probeConn) ServerVersion() []byte { return []byte("SSH-2.0-Hrmny-SSH-Host") }
func (c *probeConn) RemoteAddr() net.Addr {
	return &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1), Port: c.port}
}
func (c *probeConn) LocalAddr() net.Addr { return &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 2222} }

// TestDefaultsAreStated proves the configuration defaults are applied rather
// than implied.
func TestDefaultsAreStated(t *testing.T) {
	cfg := Config{}
	cfg.applyDefaults()

	if cfg.MaxSessionDuration != DefaultMaxSessionDuration {
		t.Errorf("MaxSessionDuration = %v", cfg.MaxSessionDuration)
	}
	if cfg.IdleTimeout != DefaultIdleTimeout {
		t.Errorf("IdleTimeout = %v", cfg.IdleTimeout)
	}
	if cfg.MaxSessionsPerAccount != DefaultMaxSessionsPerAccount {
		t.Errorf("MaxSessionsPerAccount = %d", cfg.MaxSessionsPerAccount)
	}
	if cfg.MaxPreAuthConnections != DefaultMaxPreAuthConnections {
		t.Errorf("MaxPreAuthConnections = %d", cfg.MaxPreAuthConnections)
	}
	if cfg.RenewalRetryWindow != DefaultRenewalRetryWindow {
		t.Errorf("RenewalRetryWindow = %v", cfg.RenewalRetryWindow)
	}
	if cfg.ChildPath == "" || cfg.Origin == "" || cfg.ListenAddress == "" {
		t.Error("a default was left empty")
	}
	if cfg.Logger == nil {
		t.Error("no logger")
	}
}

func TestRenewLeadNeverRenewsImmediately(t *testing.T) {
	host, _ := newTestHost(t, testHostSettings{authority: newTestAuthority(t)})

	if lead := host.renewLead(900); lead != 600*time.Second {
		t.Errorf("renewLead(900) = %v, want two thirds of the lifetime", lead)
	}

	host.cfg.RenewBefore = time.Hour
	if lead := host.renewLead(900); lead != 450*time.Second {
		t.Errorf("renewLead with an oversized lead = %v, want half the lifetime", lead)
	}

	host.cfg.RenewBefore = 0
	if lead := host.renewLead(0); lead <= 0 {
		t.Errorf("renewLead(0) = %v, want a positive delay", lead)
	}
}

// ---------------------------------------------------------------------------
// The request policy (R11)
// ---------------------------------------------------------------------------

// fakeNewChannel is a gossh.NewChannel whose Accept hands back a request stream
// the test controls.
type fakeNewChannel struct {
	requests chan *gossh.Request
}

func (c *fakeNewChannel) ChannelType() string { return "session" }
func (c *fakeNewChannel) ExtraData() []byte   { return nil }

func (c *fakeNewChannel) Reject(gossh.RejectionReason, string) error { return nil }

func (c *fakeNewChannel) Accept() (gossh.Channel, <-chan *gossh.Request, error) {
	return &fakeGosshChannel{}, c.requests, nil
}

type fakeGosshChannel struct{}

func (c *fakeGosshChannel) Read([]byte) (int, error)    { return 0, io.EOF }
func (c *fakeGosshChannel) Write(p []byte) (int, error) { return len(p), nil }
func (c *fakeGosshChannel) Close() error                { return nil }
func (c *fakeGosshChannel) CloseWrite() error           { return nil }
func (c *fakeGosshChannel) Stderr() io.ReadWriter       { return &bytes.Buffer{} }
func (c *fakeGosshChannel) SendRequest(string, bool, []byte) (bool, error) {
	return false, nil
}

// TestPolicyChannelRefusesTheBannedRequests is R11's request policy at the level
// where it is enforced.
//
// The assertion is absence from the forwarded stream: a refused request never
// reaches the library's session loop, which is what "refused" means here. This
// is asserted at this level as well as over a real connection because agent
// forwarding in particular would otherwise be answered true by the library's
// own session loop.
func TestPolicyChannelRefusesTheBannedRequests(t *testing.T) {
	for _, banned := range []string{"auth-agent-req@openssh.com", "x11-req", "subsystem", "env"} {
		t.Run(banned, func(t *testing.T) {
			requests := make(chan *gossh.Request, 1)
			// WantReply false keeps Reply a no-op, so the filter is exercised
			// without an SSH mux behind it.
			requests <- &gossh.Request{Type: banned, WantReply: false}
			close(requests)

			policy := &policyChannel{NewChannel: &fakeNewChannel{requests: requests}, log: discardLogger()}
			_, forwarded, err := policy.Accept()
			if err != nil {
				t.Fatalf("Accept: %v", err)
			}
			for req := range forwarded {
				t.Fatalf("a %q request was forwarded to the session loop instead of refused", req.Type)
			}
		})
	}

	t.Run("permitted requests pass through", func(t *testing.T) {
		requests := make(chan *gossh.Request, 3)
		for _, allowed := range []string{"pty-req", "window-change", "shell"} {
			requests <- &gossh.Request{Type: allowed, WantReply: false}
		}
		close(requests)

		policy := &policyChannel{NewChannel: &fakeNewChannel{requests: requests}, log: discardLogger()}
		_, forwarded, err := policy.Accept()
		if err != nil {
			t.Fatalf("Accept: %v", err)
		}

		var seen []string
		for req := range forwarded {
			seen = append(seen, req.Type)
		}
		if len(seen) != 3 {
			t.Fatalf("forwarded %v, want pty-req, window-change and shell", seen)
		}
	})
}

// ---------------------------------------------------------------------------
// The pre-spawn refusals
// ---------------------------------------------------------------------------

func TestHandleRefusesASessionWithNoPTY(t *testing.T) {
	observer := &recordingObserver{}
	host, minter := newTestHost(t, testHostSettings{authority: newTestAuthority(t), observer: observer})

	sess := newFakeSession(newFakeContext("jordan", identityExtensionsFor(t, "jordan", 42)))
	sess.hasPTY = false

	host.handle(sess)

	output := sess.output()
	if !strings.Contains(output, string(ReasonNoPTY)) {
		t.Fatalf("output = %q, want it to name no_pty", output)
	}
	if !strings.Contains(output, "needs a terminal") {
		t.Fatalf("output = %q, want a member-readable sentence", output)
	}
	if !sess.exited || sess.exitCode != 1 {
		t.Fatalf("session exit = %v/%d, want a non-zero exit", sess.exited, sess.exitCode)
	}
	if minter.callCount() != 0 {
		t.Error("a session with no PTY reached the bridge")
	}
	if observer.saw("spawned") {
		t.Error("a client process was spawned for a session with no PTY")
	}
}

func TestHandleRefusesASessionWithACommand(t *testing.T) {
	host, minter := newTestHost(t, testHostSettings{authority: newTestAuthority(t)})

	sess := newFakeSession(newFakeContext("jordan", identityExtensionsFor(t, "jordan", 42)))
	sess.hasPTY = true
	sess.rawCmd = "ls -la"

	host.handle(sess)

	if output := sess.output(); !strings.Contains(output, string(ReasonCommandNotSupported)) {
		t.Fatalf("output = %q, want it to name command_not_supported", output)
	}
	if minter.callCount() != 0 {
		t.Error("a command-bearing session reached the bridge")
	}
}

func TestHandleRefusesASessionWithNoVerifiedIdentity(t *testing.T) {
	host, minter := newTestHost(t, testHostSettings{authority: newTestAuthority(t)})

	sess := newFakeSession(newFakeContext("jordan", map[string]string{}))
	sess.hasPTY = true

	host.handle(sess)

	if output := sess.output(); !strings.Contains(output, string(ReasonIdentityMissing)) {
		t.Fatalf("output = %q, want it to name identity_missing", output)
	}
	if minter.callCount() != 0 {
		t.Error("a session with no verified identity reached the bridge")
	}
}

// TestHandleFailsClosedWhenTheBridgeIsUnreachable is the startup half of R19a's
// bridge failure: no token means no client process at all, so a member never
// gets a shell that cannot do anything.
func TestHandleFailsClosedWhenTheBridgeIsUnreachable(t *testing.T) {
	observer := &recordingObserver{}
	minter := &stubMinter{reply: func(int, bridge.MintRequest) (bridge.Minted, error) {
		return bridge.Minted{}, errors.New("bridge: request failed: connection refused")
	}}
	host, _ := newTestHost(t, testHostSettings{authority: newTestAuthority(t), minter: minter, observer: observer})

	sess := newFakeSession(newFakeContext("jordan", identityExtensionsFor(t, "jordan", 42)))
	sess.hasPTY = true

	host.handle(sess)

	if output := sess.output(); !strings.Contains(output, string(ReasonBridgeUnreachable)) {
		t.Fatalf("output = %q, want it to name bridge_unreachable", output)
	}
	if observer.saw("first-token") {
		t.Error("a token was written without a successful mint")
	}
	if observer.saw("spawned") {
		t.Error("a client process was spawned without a token; the session must fail closed")
	}
}

// TestHandleCarriesTheBridgeReasonIntoTheSessionEnd keeps the bridge's own
// reason on the session-end line, which is what makes R19a actionable.
func TestHandleCarriesTheBridgeReasonIntoTheSessionEnd(t *testing.T) {
	minter := &stubMinter{reply: func(int, bridge.MintRequest) (bridge.Minted, error) {
		return bridge.Minted{}, &bridge.Refusal{
			Status:  403,
			Key:     "bridge_refused",
			Reason:  bridge.ReasonUnknownSerial,
			Message: "This certificate was not issued by this server.",
		}
	}}
	host, _ := newTestHost(t, testHostSettings{authority: newTestAuthority(t), minter: minter})

	sess := newFakeSession(newFakeContext("jordan", identityExtensionsFor(t, "jordan", 42)))
	sess.hasPTY = true

	host.handle(sess)

	output := sess.output()
	if !strings.Contains(output, string(ReasonBridgeRefused)) {
		t.Fatalf("output = %q, want bridge_refused", output)
	}
	if !strings.Contains(output, bridge.ReasonUnknownSerial) {
		t.Fatalf("output = %q, want the bridge's own reason", output)
	}
	if !strings.Contains(output, ReissueURL(host.Config().Origin)) {
		t.Fatalf("output = %q, want the re-issue URL", output)
	}
}

// TestHandleRefusesPastThePerAccountCap is the fairness bound at the level the
// session layer enforces it.
func TestHandleRefusesPastThePerAccountCap(t *testing.T) {
	host, minter := newTestHost(t, testHostSettings{
		authority: newTestAuthority(t),
		tune:      func(cfg *Config) { cfg.MaxSessionsPerAccount = 1 },
	})

	// Occupy the account's single slot the way a live session would.
	release, _, ok := host.Limiter().Acquire("jordan", "SID-jordan")
	if !ok {
		t.Fatal("the first session was refused")
	}
	defer release()

	sess := newFakeSession(newFakeContext("jordan", identityExtensionsFor(t, "jordan", 42)))
	sess.hasPTY = true

	host.handle(sess)

	if output := sess.output(); !strings.Contains(output, string(ReasonSessionLimit)) {
		t.Fatalf("output = %q, want session_limit", output)
	}
	if minter.callCount() != 0 {
		t.Error("a session over the cap reached the bridge")
	}
}

// ---------------------------------------------------------------------------
// The renewal path (R13, R13a, R19a)
// ---------------------------------------------------------------------------

func newPipeForTest(t *testing.T) *tokens.Pipe {
	t.Helper()
	pipe, err := tokens.New()
	if err != nil {
		t.Fatalf("tokens.New: %v", err)
	}
	t.Cleanup(func() { _ = pipe.Close() })
	return pipe
}

// readNextToken reads one token off the descriptor, the way the client does.
//
// Each call starts a fresh reader, so it is only used where exactly one token is
// expected: a buffered reader can hold a following token it has already read.
func readNextToken(t *testing.T, pipe *tokens.Pipe) tokens.Token {
	t.Helper()
	line, err := bufio.NewReader(pipe.ChildFile()).ReadString('\n')
	if err != nil {
		t.Fatalf("read token line from the descriptor: %v", err)
	}
	var token tokens.Token
	if err := json.Unmarshal([]byte(strings.TrimSpace(line)), &token); err != nil {
		t.Fatalf("decode token line: %v", err)
	}
	if token.AccessToken == "" {
		t.Fatal("the token line carried no access_token")
	}
	return token
}

// TestRenewTokenFlagsTheRenewalAndKeepsTheSerial is KTD8 in one assertion: a
// renewal is a replacement on the same descriptor, for the same certificate,
// flagged as a renewal so the client can tell it is not a new identity.
func TestRenewTokenFlagsTheRenewalAndKeepsTheSerial(t *testing.T) {
	host, minter := newTestHost(t, testHostSettings{authority: newTestAuthority(t)})
	pipe := newPipeForTest(t)
	ctx := newFakeContext("jordan", map[string]string{})

	identity := auth.Identity{
		Serial:      77,
		Principal:   "jordan",
		Fingerprint: "SHA256:test",
		ValidBefore: time.Now().Add(time.Hour),
	}

	lead, reason, terminal := host.renewToken(ctx, pipe, identity, ctx.SessionID())
	if terminal {
		t.Fatalf("the renewal ended the session: %v", reason)
	}
	if lead <= 0 {
		t.Fatalf("renewLead = %v", lead)
	}

	token := readNextToken(t, pipe)
	if !token.Renewal {
		t.Error("a renewed token is not flagged as a renewal")
	}
	if token.Serial != 77 {
		t.Errorf("serial = %d, want the certificate's 77", token.Serial)
	}
	if token.Username != "jordan" {
		t.Errorf("username = %q", token.Username)
	}
	if token.AccessToken == "" {
		t.Error("the renewed token carries no access token")
	}

	request := minter.lastRequest()
	if request.Serial != 77 || request.Principal != "jordan" || request.Fingerprint != "SHA256:test" {
		t.Fatalf("the mint asserted %+v, want the verified identity", request)
	}
}

// TestRenewTokenRefusesAfterTheCertificateExpires is R13's certificate half: a
// renewal must not extend a session past the certificate's own window.
func TestRenewTokenRefusesAfterTheCertificateExpires(t *testing.T) {
	host, minter := newTestHost(t, testHostSettings{authority: newTestAuthority(t)})
	pipe := newPipeForTest(t)
	ctx := newFakeContext("jordan", map[string]string{})

	identity := auth.Identity{
		Serial:      1,
		Principal:   "jordan",
		Fingerprint: "SHA256:test",
		ValidBefore: time.Now().Add(-time.Second),
	}

	_, reason, terminal := host.renewToken(ctx, pipe, identity, ctx.SessionID())
	if !terminal {
		t.Fatal("a renewal was attempted after the certificate expired")
	}
	if reason.Code != ReasonCertificateExpired {
		t.Fatalf("reason = %v, want certificate_expired", reason)
	}
	if minter.callCount() != 0 {
		t.Error("an expired certificate still reached the bridge")
	}
	if !strings.Contains(reason.MemberMessage(host.Config().Origin), ReissueURL(host.Config().Origin)) {
		t.Fatalf("member message = %q, want the re-issue URL", reason.MemberMessage(host.Config().Origin))
	}
}

// TestRenewTokenEndsTheSessionWhenTheEpochMoved is R13a as the host experiences
// it: the bridge refuses the mint, so the session ends at that renewal — within
// one access-token lifetime — rather than at its maximum duration.
func TestRenewTokenEndsTheSessionWhenTheEpochMoved(t *testing.T) {
	minter := &stubMinter{reply: func(int, bridge.MintRequest) (bridge.Minted, error) {
		return bridge.Minted{}, &bridge.Refusal{
			Status:  403,
			Key:     "bridge_refused",
			Reason:  bridge.ReasonCredentialEpochMoved,
			Message: "This account's credentials were reset.",
		}
	}}
	host, _ := newTestHost(t, testHostSettings{authority: newTestAuthority(t), minter: minter})
	pipe := newPipeForTest(t)
	ctx := newFakeContext("jordan", map[string]string{})

	identity := auth.Identity{Serial: 1, Principal: "jordan", Fingerprint: "SHA256:test", ValidBefore: time.Now().Add(time.Hour)}

	_, reason, terminal := host.renewToken(ctx, pipe, identity, ctx.SessionID())
	if !terminal {
		t.Fatal("a refusal did not end the session")
	}
	if reason.Code != ReasonCredentialEpochMoved {
		t.Fatalf("reason = %v, want credential_epoch_moved", reason)
	}
	if reason.BridgeReason != bridge.ReasonCredentialEpochMoved {
		t.Fatalf("the bridge's own reason was lost: %+v", reason)
	}
	if !strings.Contains(reason.MemberMessage(host.Config().Origin), "credentials were reset") {
		t.Fatalf("member message = %q", reason.MemberMessage(host.Config().Origin))
	}
}

// TestRenewTokenRetriesWithinItsWindowThenEndsWithAReason is the renewal half of
// R19a's bridge failure: retry inside the window, then end with a reason a
// member can act on.
func TestRenewTokenRetriesWithinItsWindowThenEndsWithAReason(t *testing.T) {
	minter := &stubMinter{reply: func(int, bridge.MintRequest) (bridge.Minted, error) {
		return bridge.Minted{}, errors.New("bridge: request failed: connection refused")
	}}
	host, _ := newTestHost(t, testHostSettings{
		authority: newTestAuthority(t),
		minter:    minter,
		tune: func(cfg *Config) {
			cfg.RenewalRetryWindow = 200 * time.Millisecond
			cfg.RenewalRetryInterval = 25 * time.Millisecond
		},
	})
	pipe := newPipeForTest(t)
	ctx := newFakeContext("jordan", map[string]string{})

	identity := auth.Identity{Serial: 1, Principal: "jordan", Fingerprint: "SHA256:test", ValidBefore: time.Now().Add(time.Hour)}

	started := time.Now()
	_, reason, terminal := host.renewToken(ctx, pipe, identity, ctx.SessionID())
	elapsed := time.Since(started)

	if !terminal {
		t.Fatal("an unreachable bridge did not end the session")
	}
	if reason.Code != ReasonTokenPathFailed {
		t.Fatalf("reason = %v, want token_path_failed", reason)
	}
	if attempts := minter.callCount(); attempts < 2 {
		t.Fatalf("the renewal made %d attempt(s), want retries inside the window", attempts)
	}
	if elapsed < 150*time.Millisecond {
		t.Fatalf("the retry window was not respected: %v", elapsed)
	}
	if elapsed > 3*time.Second {
		t.Fatalf("the retry window was not bounded: %v", elapsed)
	}
	if !strings.Contains(reason.MemberMessage(host.Config().Origin), ReissueURL(host.Config().Origin)) {
		t.Fatalf("member message = %q, want the re-issue URL", reason.MemberMessage(host.Config().Origin))
	}
}

// TestRenewTokenEndsWhenTheConnectionIsGone keeps a renewal from outliving its
// connection.
func TestRenewTokenEndsWhenTheConnectionIsGone(t *testing.T) {
	host, _ := newTestHost(t, testHostSettings{authority: newTestAuthority(t)})
	pipe := newPipeForTest(t)

	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	ctx := newFakeContext("jordan", map[string]string{})
	ctx.Context = cancelled

	identity := auth.Identity{Serial: 1, Principal: "jordan", Fingerprint: "SHA256:test", ValidBefore: time.Now().Add(time.Hour)}

	_, reason, terminal := host.renewToken(ctx, pipe, identity, ctx.SessionID())
	if !terminal || reason.Code != ReasonConnectionLost {
		t.Fatalf("reason = %v terminal = %t, want connection_lost", reason, terminal)
	}
}

// TestClientExitReason maps the child's status to the member-facing reason.
func TestClientExitReason(t *testing.T) {
	if reason := clientExitReason(nil); reason.Code != ReasonClientExited {
		t.Errorf("a clean exit mapped to %v", reason)
	}

	err := exec.Command("/bin/sh", "-c", "exit 3").Run()
	if err == nil {
		t.Fatal("the fixture command did not fail")
	}
	reason := clientExitReason(err)
	if reason.Code != ReasonClientFailed {
		t.Errorf("a non-zero exit mapped to %v", reason)
	}
	if !strings.Contains(reason.MemberMessage("https://chat.test.invalid"), "exited unexpectedly") {
		t.Errorf("member message = %q", reason.MemberMessage("https://chat.test.invalid"))
	}

	if reason := clientExitReason(errors.New("exec: something odd")); reason.Code != ReasonClientFailed {
		t.Errorf("a non-ExitError mapped to %v", reason)
	}
}

// TestReasonForMintFailureSeparatesRefusalFromTransport is the branch the
// renewal loop depends on: a refusal is terminal, a transport failure is
// retried.
func TestReasonForMintFailureSeparatesRefusalFromTransport(t *testing.T) {
	refusal := &bridge.Refusal{Status: 403, Key: "bridge_refused", Reason: bridge.ReasonStaleAssertion, Message: "outside its window"}
	reason := reasonForMintFailure(refusal)
	if reason.Code != ReasonBridgeRefused || reason.BridgeReason != bridge.ReasonStaleAssertion {
		t.Fatalf("reason = %+v", reason)
	}
	if !isRefusal(refusal) {
		t.Error("a refusal was classified as a transport failure")
	}

	transport := errors.New("bridge: request failed: connection refused")
	if reason := reasonForMintFailure(transport); reason.Code != ReasonBridgeUnreachable {
		t.Fatalf("reason = %+v, want bridge_unreachable", reason)
	}
	if isRefusal(transport) {
		t.Error("a transport failure was classified as a refusal")
	}

	if reason := reasonForMintFailure(nil); reason != (EndReason{}) {
		t.Fatalf("reasonForMintFailure(nil) = %+v", reason)
	}
}

// ===========================================================================
// Real-handshake tests
//
// Everything above drives the session layer directly. Everything below opens a
// real SSH connection to a real listener and authenticates with a real
// certificate, because the properties this unit is accountable for — that a
// certificate authenticates, that a refusal fires for each reason, that the
// token reaches the child's descriptor, that the child can open nothing it
// should not — are properties of the assembled system rather than of a function.
// ===========================================================================

// fakeBridge is the bridge the host talks to over HTTP. Using a real HTTP server
// (and the real bridge client) means the wire contract is exercised, not
// simulated.
type fakeBridge struct {
	server *httptest.Server

	mu       sync.Mutex
	requests []bridgeRequest
	respond  func(call int, body map[string]any) (int, string)
}

type bridgeRequest struct {
	at     time.Time
	path   string
	header string
	body   map[string]any
}

func newFakeBridge(t *testing.T, respond func(call int, body map[string]any) (int, string)) *fakeBridge {
	t.Helper()

	fake := &fakeBridge{respond: respond}
	fake.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(req.Body).Decode(&body)
		req.Body.Close() //nolint:errcheck // test server

		fake.mu.Lock()
		fake.requests = append(fake.requests, bridgeRequest{
			at:     time.Now(),
			path:   req.URL.Path,
			header: req.Header.Get(bridge.CredentialHeader),
			body:   body,
		})
		call := len(fake.requests)
		respond := fake.respond
		fake.mu.Unlock()

		w.Header().Set("Content-Type", "application/json")
		if respond == nil {
			principal, _ := body["principal"].(string)
			w.WriteHeader(http.StatusOK)
			_, _ = io.WriteString(w, `{"access_token":"`+tokenValue(principal, call)+
				`","token_type":"Bearer","expires_in":900,"username":"`+principal+`"}`)
			return
		}
		status, payload := respond(call, body)
		w.WriteHeader(status)
		_, _ = io.WriteString(w, payload)
	}))
	t.Cleanup(fake.server.Close)
	return fake
}

func tokenValue(principal string, call int) string {
	return "token-" + principal + "-" + strconv.Itoa(call)
}

func (f *fakeBridge) calls() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.requests)
}

func (f *fakeBridge) request(i int) bridgeRequest {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.requests[i]
}

func (f *fakeBridge) allRequests() []bridgeRequest {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]bridgeRequest(nil), f.requests...)
}

// harness is a running host with a throwaway CA, a fake bridge, and a client
// command that re-executes this test binary.
type harness struct {
	host      *Host
	address   string
	authority testAuthority
	bridge    *fakeBridge
	observer  *recordingObserver
}

type harnessSettings struct {
	respond   func(call int, body map[string]any) (int, string)
	tune      func(*Config)
	noBridge  bool
	expiresIn int

	// secretsDir is where the credential and host key live before boot. A test
	// that asserts the child cannot open them names the directory up front, so
	// it knows the paths without the harness having to hand them back.
	secretsDir string
}

// Secret file names inside secretsDir.
const (
	credentialFile = "bridge-credential"
	hostKeyFile    = "ssh_host_ed25519_key"
)

// secretPaths are the two paths a boot reads once and unlinks.
func secretPaths(dir string) (credential, hostKey string) {
	return filepath.Join(dir, credentialFile), filepath.Join(dir, hostKeyFile)
}

func newHarness(t *testing.T, settings harnessSettings) *harness {
	t.Helper()

	// The boot posture this unit requires: the credential and the host key are
	// read once and unlinked, so what remains is a path nothing can open.
	secrets := settings.secretsDir
	if secrets == "" {
		secrets = t.TempDir()
	}
	credPath, keyPath := secretPaths(secrets)
	if err := os.WriteFile(credPath, []byte("test-bridge-credential\n"), 0o600); err != nil {
		t.Fatalf("write credential: %v", err)
	}
	_, hostKeyPEM := newTestKeyPair(t)
	if err := os.WriteFile(keyPath, hostKeyPEM, 0o600); err != nil {
		t.Fatalf("write host key: %v", err)
	}

	credential, err := bridge.LoadCredential(credPath, false)
	if err != nil {
		t.Fatalf("LoadCredential: %v", err)
	}
	hostKey, err := auth.LoadHostKey(keyPath, false)
	if err != nil {
		t.Fatalf("LoadHostKey: %v", err)
	}

	expiresIn := settings.expiresIn
	if expiresIn == 0 {
		expiresIn = 900
	}

	respond := settings.respond
	if respond == nil && !settings.noBridge {
		respond = func(call int, body map[string]any) (int, string) {
			principal, _ := body["principal"].(string)
			return http.StatusOK, `{"access_token":"` + tokenValue(principal, call) +
				`","token_type":"Bearer","expires_in":` + strconv.Itoa(expiresIn) +
				`,"username":"` + principal + `"}`
		}
	}

	var fake *fakeBridge
	bridgeURL := "http://127.0.0.1:1"
	if !settings.noBridge {
		fake = newFakeBridge(t, respond)
		bridgeURL = fake.server.URL
		// The fake server must be reachable up to the moment it is taken down.
		bridgeURL = fake.server.URL
	}

	minter, err := bridge.New(bridgeURL, credential)
	if err != nil {
		t.Fatalf("bridge.New: %v", err)
	}

	authority := newTestAuthority(t)
	verifier, err := auth.NewVerifier([]gossh.PublicKey{authority.public})
	if err != nil {
		t.Fatalf("NewVerifier: %v", err)
	}

	observer := &recordingObserver{}
	cfg := Config{
		ListenAddress:    "127.0.0.1:0",
		ClientCommand:    []string{os.Args[0]},
		ClientDir:        t.TempDir(),
		Origin:           "https://chat.test.invalid",
		ChildPath:        "/usr/bin:/bin",
		Observer:         observer,
		IdlePollInterval: 20 * time.Millisecond,
	}
	if settings.tune != nil {
		settings.tune(&cfg)
	}

	host, err := NewHost(cfg, verifier, minter, hostKey)
	if err != nil {
		t.Fatalf("NewHost: %v", err)
	}

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	go func() { _ = host.Serve(listener) }()
	t.Cleanup(func() { _ = host.Close() })

	return &harness{
		host:      host,
		address:   listener.Addr().String(),
		authority: authority,
		bridge:    fake,
		observer:  observer,
	}
}

// helperArgs makes the client command run the child helper below.
func helperArgs(mode string, extra ...string) []string {
	args := []string{"-test.run=^TestSessionChildHelper$", "--", mode}
	return append(args, extra...)
}

// asClientCommand configures a harness whose child is the test-binary helper.
func withHelper(mode string, extra ...string) func(*Config) {
	return func(cfg *Config) { cfg.ClientArgs = helperArgs(mode, extra...) }
}

func newTestKeyPair(t *testing.T) (gossh.Signer, []byte) {
	t.Helper()
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	signer, err := gossh.NewSignerFromKey(priv)
	if err != nil {
		t.Fatalf("signer: %v", err)
	}
	block, err := gossh.MarshalPrivateKey(priv, "")
	if err != nil {
		t.Fatalf("marshal private key: %v", err)
	}
	return signer, pem.EncodeToMemory(block)
}

// ---------------------------------------------------------------------------
// The client side
// ---------------------------------------------------------------------------

type testClient struct {
	client  *gossh.Client
	session *gossh.Session
	lines   chan string
	done    chan struct{}
}

func dialCert(t *testing.T, address string, authority testAuthority, principal string, tweak func(*gossh.Certificate)) *gossh.Client {
	t.Helper()
	subject, _ := newTestKeyPair(t)
	certificate := signedCert(t, authority, principal, subject, tweak)

	certSigner, err := gossh.NewCertSigner(certificate, subject)
	if err != nil {
		t.Fatalf("NewCertSigner: %v", err)
	}

	client, err := dialWith(t, address, principal, gossh.PublicKeys(certSigner))
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	return client
}

func dialWith(t *testing.T, address, principal string, auth gossh.AuthMethod) (*gossh.Client, error) {
	t.Helper()
	return gossh.Dial("tcp", address, &gossh.ClientConfig{
		User:            principal,
		Auth:            []gossh.AuthMethod{auth},
		HostKeyCallback: gossh.InsecureIgnoreHostKey(),
		Timeout:         5 * time.Second,
	})
}

// openShell opens a session, optionally requesting a PTY, and starts a shell.
func openShell(t *testing.T, client *gossh.Client, pty bool) *testClient {
	t.Helper()
	session, err := client.NewSession()
	if err != nil {
		t.Fatalf("NewSession: %v", err)
	}
	if pty {
		if err := session.RequestPty("xterm-256color", 40, 120, gossh.TerminalModes{}); err != nil {
			t.Fatalf("RequestPty: %v", err)
		}
	}
	stdout, err := session.StdoutPipe()
	if err != nil {
		t.Fatalf("StdoutPipe: %v", err)
	}

	tc := &testClient{client: client, session: session, lines: make(chan string, 128), done: make(chan struct{})}
	go func() {
		defer close(tc.done)
		defer close(tc.lines)
		scanner := bufio.NewScanner(stdout)
		for scanner.Scan() {
			tc.lines <- strings.TrimSpace(scanner.Text())
		}
	}()

	if err := session.Shell(); err != nil {
		t.Fatalf("Shell: %v", err)
	}
	return tc
}

// waitFor reads until a line with the given prefix arrives, or the deadline
// passes.
func (c *testClient) waitFor(prefix string, timeout time.Duration) (string, bool) {
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

// collect drains every remaining line until the session ends.
func (c *testClient) collect() string {
	var b strings.Builder
	for line := range c.lines {
		b.WriteString(line)
		b.WriteString("\n")
	}
	return b.String()
}

func (c *testClient) close() {
	_ = c.session.Close()
	_ = c.client.Close()
}

// ---------------------------------------------------------------------------
// The happy path (R7, R10, R12, R12a)
// ---------------------------------------------------------------------------

// TestCertificateAuthenticatesAndTheChildGetsAtoken is the unit's goal: a
// connection bearing a valid certificate lands in a client process as the right
// member, with the token on its descriptor before it can issue a request.
func TestCertificateAuthenticatesAndTheChildGetsAtoken(t *testing.T) {
	h := newHarness(t, harnessSettings{tune: withHelper("hold")})
	client := dialCert(t, h.address, h.authority, "jordan", nil)
	defer client.Close()

	session := openShell(t, client, true)
	defer session.close()

	pidLine, ok := session.waitFor("PID", 5*time.Second)
	if !ok {
		t.Fatalf("the child never started:\n%s", session.collect())
	}

	// The token line, read as the child's FIRST action with a deadline on the
	// descriptor: a read that had to wait for the host would be indistinguishable
	// from one that found the token already there, so the child reports a
	// timeout instead of blocking.
	tokenLine, ok := session.waitFor("TOKEN", 5*time.Second)
	if !ok {
		t.Fatalf("the child read no token:\n%s", session.collect())
	}
	if !strings.Contains(tokenLine, "token-jordan-1") {
		t.Fatalf("the child read %q, want the minted token", tokenLine)
	}
	if fdLine, ok := session.waitFor("FD", 2*time.Second); !ok || !strings.Contains(fdLine, "3") {
		t.Fatalf("the child's descriptor number line = %q (ok=%t), want 3", fdLine, ok)
	}
	_ = pidLine

	// The token was written BEFORE the child existed, which is the ordering the
	// design guarantees.
	events, _ := h.observer.snapshot()
	firstTokenAt, spawnAt := -1, -1
	for i, event := range events {
		switch event {
		case "first-token":
			if firstTokenAt < 0 {
				firstTokenAt = i
			}
		case "spawned":
			if spawnAt < 0 {
				spawnAt = i
			}
		}
	}
	if firstTokenAt < 0 || spawnAt < 0 {
		t.Fatalf("lifecycle events missing: %v", events)
	}
	if firstTokenAt > spawnAt {
		t.Fatalf("the child was spawned before the first token was written: %v", events)
	}

	// The bridge saw the verified identity, bound three ways: the serial off the
	// certificate, the principal off the login name, and the key's fingerprint.
	if h.bridge.calls() == 0 {
		t.Fatal("the bridge was never called")
	}
	request := h.bridge.request(0)
	if request.path != "/internal/ssh/session" {
		t.Errorf("bridge path = %q", request.path)
	}
	if request.header != "test-bridge-credential" {
		t.Errorf("bridge credential header = %q", request.header)
	}
	if request.body["principal"] != "jordan" {
		t.Errorf("asserted principal = %#v", request.body["principal"])
	}
	if request.body["serial"] == nil || request.body["serial"] == "" {
		t.Errorf("asserted serial = %#v", request.body["serial"])
	}
	fingerprint, _ := request.body["fingerprint"].(string)
	if !strings.HasPrefix(fingerprint, "SHA256:") {
		t.Errorf("asserted fingerprint = %q, want the OpenSSH SHA256 spelling", fingerprint)
	}
}

// TestTheTokenArrivesBeforeThePreviousOneExpires is KTD8: a session outliving
// one token receives a renewal on the same descriptor, with a fresh nonce and
// the same serial.
func TestTheTokenArrivesBeforeThePreviousOneExpires(t *testing.T) {
	const lifetime = 2
	h := newHarness(t, harnessSettings{
		expiresIn: lifetime,
		tune: func(cfg *Config) {
			cfg.ClientArgs = helperArgs("two")
		},
	})

	client := dialCert(t, h.address, h.authority, "jordan", nil)
	defer client.Close()
	session := openShell(t, client, true)
	defer session.close()

	if _, ok := session.waitFor("TOKEN", 5*time.Second); !ok {
		t.Fatalf("no first token:\n%s", session.collect())
	}
	second, ok := session.waitFor("TOKEN2", 5*time.Second)
	if !ok {
		t.Fatalf("no renewed token:\n%s", session.collect())
	}
	if !strings.Contains(second, "token-jordan-2") {
		t.Fatalf("the renewed token was %q, want the second mint", second)
	}

	requests := h.bridge.allRequests()
	if len(requests) < 2 {
		t.Fatalf("the bridge minted %d time(s), want a renewal", len(requests))
	}

	first, renewed := requests[0], requests[1]
	if first.body["nonce"] == renewed.body["nonce"] {
		t.Fatal("the renewal reused the nonce; the server records a nonce single-use and would refuse it as replayed_assertion")
	}
	if first.body["serial"] != renewed.body["serial"] {
		t.Fatalf("the serial changed across a renewal: %#v -> %#v", first.body["serial"], renewed.body["serial"])
	}

	// The renewal was minted before the first token's lifetime elapsed, so the
	// live request path never saw an expired token.
	if gap := renewed.at.Sub(first.at); gap >= lifetime*time.Second {
		t.Fatalf("the renewal came %v after the first mint, which is at or past the %ds lifetime", gap, lifetime)
	}
}

// TestTwoConcurrentSessionsGetTheirOwnTokens is per-connection isolation at the
// level that matters: neither descriptor carries the other member's token.
func TestTwoConcurrentSessionsGetTheirOwnTokens(t *testing.T) {
	h := newHarness(t, harnessSettings{tune: withHelper("hold")})

	alice := dialCert(t, h.address, h.authority, "alice", nil)
	defer alice.Close()
	bob := dialCert(t, h.address, h.authority, "bob", nil)
	defer bob.Close()

	aliceSession := openShell(t, alice, true)
	defer aliceSession.close()
	bobSession := openShell(t, bob, true)
	defer bobSession.close()

	aliceToken, ok := aliceSession.waitFor("TOKEN", 5*time.Second)
	if !ok {
		t.Fatalf("alice read no token:\n%s", aliceSession.collect())
	}
	bobToken, ok := bobSession.waitFor("TOKEN", 5*time.Second)
	if !ok {
		t.Fatalf("bob read no token:\n%s", bobSession.collect())
	}

	if !strings.Contains(aliceToken, "token-alice") {
		t.Fatalf("alice read %q", aliceToken)
	}
	if !strings.Contains(bobToken, "token-bob") {
		t.Fatalf("bob read %q", bobToken)
	}
	if strings.Contains(aliceToken, "token-bob") || strings.Contains(bobToken, "token-alice") {
		t.Fatal("a session's descriptor carried another member's token")
	}

	principals := map[string]bool{}
	for _, request := range h.bridge.allRequests() {
		principal, _ := request.body["principal"].(string)
		principals[principal] = true
	}
	if !principals["alice"] || !principals["bob"] {
		t.Fatalf("the bridge saw principals %v, want both members", principals)
	}
}

// ---------------------------------------------------------------------------
// Isolation (R12a)
// ---------------------------------------------------------------------------

// TestTheChildCannotOpenTheSecretsOrSeeThemInItsEnvironment is the isolation
// assertion, and it is written the way the plan demands: the child's own open()
// failure is asserted, not the absence of an environment variable — which passes
// while the file is still readable.
func TestTheChildCannotOpenTheSecretsOrSeeThemInItsEnvironment(t *testing.T) {
	secrets := t.TempDir()
	credPath, keyPath := secretPaths(secrets)
	h := newHarness(t, harnessSettings{
		secretsDir: secrets,
		tune:       withHelper("isolation", credPath, keyPath),
	})
	client := dialCert(t, h.address, h.authority, "jordan", nil)
	defer client.Close()

	session := openShell(t, client, true)
	defer session.close()

	output := session.collect()

	// The boot posture itself: the paths do not exist any more.
	for _, path := range []string{credPath, keyPath} {
		file, err := os.Open(path)
		if err == nil {
			file.Close() //nolint:errcheck // test
			t.Fatalf("%s is still openable on the host after boot", path)
		}
		if !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("open %s: %v, want os.ErrNotExist", path, err)
		}
	}

	// The child's own failure to open them.
	if !strings.Contains(output, "OPEN "+credPath+" no-such-file") {
		t.Fatalf("the child could still open the bridge credential, or reported something else:\n%s", output)
	}
	if !strings.Contains(output, "OPEN "+keyPath+" no-such-file") {
		t.Fatalf("the child could still open the host key, or reported something else:\n%s", output)
	}

	// And the credential is not in the environment either, which is a second,
	// weaker assertion rather than the first.
	env := envLines(output)
	if joined := strings.Join(env, "\n"); strings.Contains(joined, "test-bridge-credential") {
		t.Fatalf("the bridge credential is in the child's environment:\n%s", joined)
	}

	// The child's whole environment is the host's four variables.
	wantKeys := map[string]bool{"PATH": true, "TERM": true, OriginEnv: true, TokenFDEnv: true}
	for _, entry := range env {
		key, _, _ := strings.Cut(entry, "=")
		if !wantKeys[key] {
			t.Errorf("the child's environment carries %q, which the host does not set", key)
		}
	}
	if len(env) != 4 {
		t.Errorf("the child's environment has %d entries, want exactly 4:\n%s", len(env), strings.Join(env, "\n"))
	}

	// The descriptor table. The standard streams are the PTY, the token
	// descriptor is a pipe, and NOTHING the child holds is a regular file —
	// which is the shape a leaked credential or host key would take. A file on
	// a cgroup filesystem is classified "cgroupfile", not "regular": the child's
	// own Go runtime holds its cgroup's cpu.max open (Go 1.25+), and a kernel
	// pseudo-file cannot carry a secret (see onCgroupFilesystem).
	kinds := fdKinds(output)
	for _, standard := range []int{0, 1, 2} {
		if kinds[standard] != "chardev" {
			t.Errorf("descriptor %d is %s, want the PTY's character device; the table is %v", standard, kinds[standard], kinds)
		}
	}
	if kinds[3] != "fifo" {
		t.Errorf("descriptor 3 is %s, want the token pipe; the table is %v", kinds[3], kinds)
	}
	for fd, kind := range kinds {
		if kind == "regular" {
			t.Errorf("the child holds a regular file on descriptor %d (%s); the table is %v, paths %v", fd, fdPaths(output)[fd], kinds, fdPaths(output))
		}
	}
}

// TestTheChildProcessDiesWithItsSession is R12's other half: no client process
// survives its connection.
func TestTheChildProcessDiesWithItsSession(t *testing.T) {
	h := newHarness(t, harnessSettings{tune: withHelper("hold")})
	client := dialCert(t, h.address, h.authority, "jordan", nil)

	session := openShell(t, client, true)
	pidLine, ok := session.waitFor("PID", 5*time.Second)
	if !ok {
		t.Fatalf("the child never started:\n%s", session.collect())
	}
	pid, err := strconv.Atoi(strings.TrimSpace(strings.TrimPrefix(pidLine, "PID")))
	if err != nil || pid <= 0 {
		t.Fatalf("child pid line = %q (%v)", pidLine, err)
	}

	// Dropping the whole connection must take the child with it.
	_ = client.Close()

	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if err := syscall.Kill(pid, 0); errors.Is(err, syscall.ESRCH) {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("client process %d survived its connection", pid)
}

// ---------------------------------------------------------------------------
// Refusals (R10)
// ---------------------------------------------------------------------------

// TestRefusesEachBadCertificate is one assertion per rejection reason, over a
// real handshake, so the wiring is proven rather than the function.
func TestRefusesEachBadCertificate(t *testing.T) {
	h := newHarness(t, harnessSettings{})
	otherAuthority := newTestAuthority(t)

	cases := []struct {
		name      string
		authority testAuthority
		principal string
		tweak     func(*gossh.Certificate)
	}{
		{
			name:      "certificate from an untrusted CA",
			authority: otherAuthority,
			principal: "jordan",
		},
		{
			name:      "host certificate signed by the trusted CA",
			authority: h.authority,
			principal: "jordan",
			tweak:     func(c *gossh.Certificate) { c.CertType = gossh.HostCert },
		},
		{
			name:      "expired certificate",
			authority: h.authority,
			principal: "jordan",
			tweak: func(c *gossh.Certificate) {
				c.ValidAfter = uint64(time.Now().Add(-2 * time.Hour).Unix())
				c.ValidBefore = uint64(time.Now().Add(-time.Hour).Unix())
			},
		},
		{
			name:      "certificate that is not yet valid",
			authority: h.authority,
			principal: "jordan",
			tweak: func(c *gossh.Certificate) {
				c.ValidAfter = uint64(time.Now().Add(time.Hour).Unix())
				c.ValidBefore = uint64(time.Now().Add(2 * time.Hour).Unix())
			},
		},
		{
			name:      "principal differing from the login name",
			authority: h.authority,
			principal: "someone-else",
		},
		{
			name:      "empty principals list",
			authority: h.authority,
			principal: "jordan",
			tweak:     func(c *gossh.Certificate) { c.ValidPrincipals = []string{} },
		},
		{
			name:      "indefinite validity window",
			authority: h.authority,
			principal: "jordan",
			tweak:     func(c *gossh.Certificate) { c.ValidBefore = gossh.CertTimeInfinity },
		},
		{
			name:      "critical option",
			authority: h.authority,
			principal: "jordan",
			tweak: func(c *gossh.Certificate) {
				c.CriticalOptions = map[string]string{"source-address": "127.0.0.1/32"}
			},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			subject, _ := newTestKeyPair(t)
			certificate := signedCert(t, tc.authority, tc.principal, subject, tc.tweak)
			certSigner, err := gossh.NewCertSigner(certificate, subject)
			if err != nil {
				t.Fatalf("NewCertSigner: %v", err)
			}

			// The login name is the member's, which is what the principal must
			// equal: presenting a certificate for someone-else as jordan is the
			// case that must fail.
			login := "jordan"
			client, err := dialWith(t, h.address, login, gossh.PublicKeys(certSigner))
			if err == nil {
				client.Close()
				t.Fatal("the connection authenticated with a certificate that must be refused")
			}
			if h.bridge.calls() != 0 {
				t.Fatal("a refused connection reached the bridge")
			}
		})
	}
}

// TestRefusesAPlainPublicKey is the UserKeyFallback-is-nil case over the wire:
// possession of the key is not the login, the certificate is.
func TestRefusesAPlainPublicKey(t *testing.T) {
	h := newHarness(t, harnessSettings{})
	subject, _ := newTestKeyPair(t)

	client, err := dialWith(t, h.address, "jordan", gossh.PublicKeys(subject))
	if err == nil {
		client.Close()
		t.Fatal("a plain public key authenticated")
	}
}

// TestRefusesPasswordAndKeyboardInteractive is KTD1 over the wire: no second
// authentication method exists, so neither can even be offered.
func TestRefusesPasswordAndKeyboardInteractive(t *testing.T) {
	h := newHarness(t, harnessSettings{})

	t.Run("password", func(t *testing.T) {
		client, err := dialWith(t, h.address, "jordan", gossh.Password("hunter2"))
		if err == nil {
			client.Close()
			t.Fatal("a password authenticated")
		}
	})

	t.Run("keyboard-interactive", func(t *testing.T) {
		answer := func(_ string, _ string, _ []string, _ []bool) ([]string, error) {
			return []string{"hunter2"}, nil
		}
		client, err := dialWith(t, h.address, "jordan", gossh.KeyboardInteractive(answer))
		if err == nil {
			client.Close()
			t.Fatal("keyboard-interactive authenticated")
		}
	})

	if h.bridge.calls() != 0 {
		t.Fatal("a refused method reached the bridge")
	}
}

// ---------------------------------------------------------------------------
// Session shape and forwarding refusals (R11)
// ---------------------------------------------------------------------------

// TestRefusesASessionWithNoPTY is R11's first clause, and it asserts the
// member-readable text rather than only the failure.
func TestRefusesASessionWithNoPTY(t *testing.T) {
	h := newHarness(t, harnessSettings{tune: withHelper("hold")})
	client := dialCert(t, h.address, h.authority, "jordan", nil)
	defer client.Close()

	session := openShell(t, client, false)
	defer session.close()

	output := session.collect()
	if !strings.Contains(output, string(ReasonNoPTY)) {
		t.Fatalf("output = %q, want it to name no_pty", output)
	}
	if !strings.Contains(output, "needs a terminal") {
		t.Fatalf("output = %q, want a member-readable sentence", output)
	}
	if h.bridge.calls() != 0 {
		t.Fatal("a session with no PTY reached the bridge")
	}
	if h.observer.saw("spawned") {
		t.Fatal("a client process was spawned for a session with no PTY")
	}
}

// TestRefusesAgentForwardingX11AndSubsystems is R11's request refusals over a
// real connection.
//
// Agent forwarding is the one that needs this host's own filter: the library's
// session loop answers it true with no option to turn it off, so a false reply
// is only possible because the request is refused before that loop sees it.
func TestRefusesAgentForwardingX11AndSubsystems(t *testing.T) {
	h := newHarness(t, harnessSettings{tune: withHelper("hold")})
	client := dialCert(t, h.address, h.authority, "jordan", nil)
	defer client.Close()

	session, err := client.NewSession()
	if err != nil {
		t.Fatalf("NewSession: %v", err)
	}
	defer session.Close() //nolint:errcheck // test

	t.Run("agent forwarding", func(t *testing.T) {
		accepted, err := session.SendRequest("auth-agent-req@openssh.com", true, nil)
		if err != nil {
			t.Fatalf("SendRequest: %v", err)
		}
		if accepted {
			t.Fatal("agent forwarding was accepted")
		}
	})

	t.Run("X11 forwarding", func(t *testing.T) {
		accepted, err := session.SendRequest("x11-req", true, []byte{0, 0, 0, 0, 0, 0, 0, 0, 0})
		if err != nil {
			t.Fatalf("SendRequest: %v", err)
		}
		if accepted {
			t.Fatal("X11 forwarding was accepted")
		}
	})

	t.Run("subsystem", func(t *testing.T) {
		if err := session.RequestSubsystem("sftp"); err == nil {
			t.Fatal("a subsystem request was accepted")
		}
	})

	t.Run("environment", func(t *testing.T) {
		if err := session.Setenv("CYTALE_ORIGIN", "https://attacker.invalid"); err == nil {
			t.Fatal("an environment request was accepted")
		}
	})
}

// TestRefusesPortForwarding covers both forwarding directions and both channel
// types.
func TestRefusesPortForwarding(t *testing.T) {
	h := newHarness(t, harnessSettings{tune: withHelper("hold")})
	client := dialCert(t, h.address, h.authority, "jordan", nil)
	defer client.Close()

	forwarded, err := client.Listen("tcp", "127.0.0.1:0")
	if err == nil {
		forwarded.Close() //nolint:errcheck // test
		t.Fatal("a remote port forward was accepted")
	}

	connection, err := client.Dial("tcp", "127.0.0.1:25")
	if err == nil {
		connection.Close() //nolint:errcheck // test
		t.Fatal("a direct-tcpip connection was accepted")
	}

	instance, err := client.Dial("tcp", targetUnreachable())
	if err == nil {
		instance.Close() //nolint:errcheck // test
		t.Fatal("a direct-tcpip connection was accepted")
	}
}

// targetUnreachable is an address that exists only to be refused as a forwarding
// target.
func targetUnreachable() string { return "127.0.0.1:9" }

// TestRefusesACommand proves a session that asks for a command is told, rather
// than silently handed the client with its request discarded.
func TestRefusesACommand(t *testing.T) {
	h := newHarness(t, harnessSettings{tune: withHelper("hold")})
	client := dialCert(t, h.address, h.authority, "jordan", nil)
	defer client.Close()

	session, err := client.NewSession()
	if err != nil {
		t.Fatalf("NewSession: %v", err)
	}
	defer session.Close() //nolint:errcheck // test

	if err := session.RequestPty("xterm-256color", 40, 120, gossh.TerminalModes{}); err != nil {
		t.Fatalf("RequestPty: %v", err)
	}
	raw, _ := session.CombinedOutput("ls -la")
	output := string(raw)
	if !strings.Contains(output, string(ReasonCommandNotSupported)) {
		t.Fatalf("output = %q, want it to name command_not_supported", output)
	}
}

// ---------------------------------------------------------------------------
// Bounds (R13, R13a, R13b, R19a)
// ---------------------------------------------------------------------------

// TestMaxSessionDurationEndsTheSession is R13's absolute bound.
func TestMaxSessionDurationEndsTheSession(t *testing.T) {
	h := newHarness(t, harnessSettings{
		tune: func(cfg *Config) {
			cfg.ClientArgs = helperArgs("hold")
			cfg.MaxSessionDuration = 500 * time.Millisecond
			cfg.IdleTimeout = time.Hour
		},
	})

	client := dialCert(t, h.address, h.authority, "jordan", nil)
	defer client.Close()
	session := openShell(t, client, true)
	defer session.close()

	if _, ok := session.waitFor("TOKEN", 5*time.Second); !ok {
		t.Fatal("the child never started")
	}

	started := time.Now()
	output := session.collect()
	if !strings.Contains(output, string(ReasonMaxDuration)) {
		t.Fatalf("output = %q, want it to name max_session_duration:\n%s", output, output)
	}
	if elapsed := time.Since(started); elapsed > 5*time.Second {
		t.Fatalf("the session took %v to hit a 500ms bound", elapsed)
	}
}

// TestIdleTimeoutEndsTheSession is R13's idle bound.
func TestIdleTimeoutEndsTheSession(t *testing.T) {
	h := newHarness(t, harnessSettings{
		tune: func(cfg *Config) {
			cfg.ClientArgs = helperArgs("hold")
			cfg.IdleTimeout = 300 * time.Millisecond
			cfg.IdlePollInterval = 20 * time.Millisecond
			cfg.MaxSessionDuration = time.Minute
		},
	})

	client := dialCert(t, h.address, h.authority, "jordan", nil)
	defer client.Close()
	session := openShell(t, client, true)
	defer session.close()

	if _, ok := session.waitFor("TOKEN", 5*time.Second); !ok {
		t.Fatal("the child never started")
	}

	output := session.collect()
	if !strings.Contains(output, string(ReasonIdleTimeout)) {
		t.Fatalf("output = %q, want it to name idle_timeout", output)
	}
}

// TestTheRunningClientReceivesTheReasonForEveryHostDecidedEnding is the
// integration half of the end frame, and the assertion R19a actually needs: for
// every ending the HOST decides while the client is still running, the reason
// arrives on the client's descriptor and the client READS it — not a bare
// end-of-stream that leaves the member to guess a cause.
//
// The reader is the fixture child in its "hold" mode, which watches descriptor 3
// after its first token and prints the reason it was told. The line can only
// reach the channel if the host wrote the frame while the child still held the
// read end, which is the ordering endAnnounced exists for.
func TestTheRunningClientReceivesTheReasonForEveryHostDecidedEnding(t *testing.T) {
	const reissue = "/#/settings/ssh"

	mintedOnce := func(call int, body map[string]any) (int, string) {
		principal, _ := body["principal"].(string)
		return http.StatusOK, `{"access_token":"` + tokenValue(principal, call) +
			`","token_type":"Bearer","expires_in":1,"username":"` + principal + `"}`
	}

	// refuseAfterFirst is a bridge that mints the first token and then refuses
	// the renewal, which is how the renewal-boundary endings happen.
	refuseAfterFirst := func(reason, message string) func(int, map[string]any) (int, string) {
		return func(call int, body map[string]any) (int, string) {
			if call == 1 {
				return mintedOnce(call, body)
			}
			return http.StatusForbidden, `{"error":{"key":"bridge_refused","reason":"` + reason +
				`","message":"` + message + `"}}`
		}
	}

	// renewalBound keeps the session's own bounds out of the way, so the ending
	// under test is the one the renewal produces.
	renewalBound := func(cfg *Config) {
		cfg.MaxSessionDuration = time.Minute
		cfg.IdleTimeout = time.Hour
	}

	cases := []struct {
		name    string
		want    ReasonCode
		respond func(int, map[string]any) (int, string)
		tune    func(*Config)
	}{
		{
			name: "the maximum duration bound",
			want: ReasonMaxDuration,
			tune: func(cfg *Config) {
				cfg.MaxSessionDuration = 500 * time.Millisecond
				cfg.IdleTimeout = time.Hour
			},
		},
		{
			name: "the idle bound",
			want: ReasonIdleTimeout,
			tune: func(cfg *Config) {
				cfg.IdleTimeout = 300 * time.Millisecond
				cfg.IdlePollInterval = 20 * time.Millisecond
				cfg.MaxSessionDuration = time.Minute
			},
		},
		{
			name: "a certificate that expires before its renewal",
			want: ReasonCertificateExpired,
			tune: func(cfg *Config) {
				// Two hours on, the certificate the client presented has expired,
				// so the renewal must not extend the session past it.
				cfg.Now = func() time.Time { return time.Now().Add(2 * time.Hour) }
				renewalBound(cfg)
			},
		},
		{
			name:    "a credential epoch that moved",
			want:    ReasonCredentialEpochMoved,
			respond: refuseAfterFirst("credential_epoch_moved", "This account's credentials were reset."),
			tune:    renewalBound,
		},
		{
			name:    "a refused assertion",
			want:    ReasonBridgeRefused,
			respond: refuseAfterFirst("unknown_serial", "This certificate was not issued by this server."),
			tune:    renewalBound,
		},
		{
			name: "a token path that outlasts its retry window",
			want: ReasonTokenPathFailed,
			respond: func(call int, body map[string]any) (int, string) {
				if call == 1 {
					return mintedOnce(call, body)
				}
				return http.StatusInternalServerError, ""
			},
			tune: func(cfg *Config) {
				renewalBound(cfg)
				cfg.RenewalRetryWindow = 200 * time.Millisecond
				cfg.RenewalRetryInterval = 20 * time.Millisecond
			},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			settings := harnessSettings{expiresIn: 1, respond: tc.respond}
			tune := tc.tune
			settings.tune = func(cfg *Config) {
				cfg.ClientArgs = helperArgs("hold")
				tune(cfg)
			}
			h := newHarness(t, settings)

			client := dialCert(t, h.address, h.authority, "jordan", nil)
			defer client.Close()
			session := openShell(t, client, true)
			defer session.close()

			line, ok := session.waitFor("END ", 10*time.Second)
			if !ok {
				t.Fatalf("the running client was never told why its session ended; it saw:\n%s", session.collect())
			}
			if got, want := strings.TrimSpace(line), "END "+string(tc.want); got != want {
				t.Fatalf("the client read %q off its descriptor, want %q", got, want)
			}

			// The channel block is still written, and still names the same
			// reason: the frame is an addition to the member's message, not a
			// replacement for it.
			output := session.collect()
			if !strings.Contains(output, "(reason: "+string(tc.want)) {
				t.Fatalf("the session-end block does not name %s:\n%s", tc.want, output)
			}
			if (EndReason{Code: tc.want}).Reissued() && !strings.Contains(output, reissue) {
				t.Fatalf("the session-end block omits the re-issue URL:\n%s", output)
			}
		})
	}
}

// TestRenewalRefusesToExtendPastTheCertificateWindow is R13's certificate clause:
// a renewal must not extend a session past the certificate's own window.
//
// The certificate is genuine and its window is real. What the test drives is the
// host's clock, so the renewal that would have extended the session is refused
// deterministically rather than after a real expiry — and the assertion is still
// that the session ends with a reason naming the certificate.
func TestRenewalRefusesToExtendPastTheCertificateWindow(t *testing.T) {
	h := newHarness(t, harnessSettings{
		expiresIn: 1,
		tune: func(cfg *Config) {
			cfg.ClientArgs = helperArgs("hold")
			cfg.MaxSessionDuration = 30 * time.Second
			cfg.IdleTimeout = time.Hour
			// Two hours on, the one-hour certificate the client presented has
			// expired; the session must not be renewed past it.
			cfg.Now = func() time.Time { return time.Now().Add(2 * time.Hour) }
		},
	})

	client := dialCert(t, h.address, h.authority, "jordan", nil)
	defer client.Close()
	session := openShell(t, client, true)
	defer session.close()

	started := time.Now()
	output := session.collect()
	if !strings.Contains(output, string(ReasonCertificateExpired)) {
		t.Fatalf("output = %q, want it to name certificate_expired", output)
	}
	if !strings.Contains(output, ReissueURL(h.host.Config().Origin)) {
		t.Fatalf("output = %q, want the re-issue URL", output)
	}
	if elapsed := time.Since(started); elapsed > 10*time.Second {
		t.Fatalf("the session outlived its certificate by %v", elapsed)
	}
}

// TestEpochChangeEndsTheSessionWithinOneTokenLifetime is R13a through the path
// the host actually has: the bridge refuses the renewal, so the session ends
// there rather than at its maximum duration.
func TestEpochChangeEndsTheSessionWithinOneTokenLifetime(t *testing.T) {
	h := newHarness(t, harnessSettings{
		expiresIn: 1,
		respond: func(call int, body map[string]any) (int, string) {
			if call == 1 {
				principal, _ := body["principal"].(string)
				return http.StatusOK, `{"access_token":"` + tokenValue(principal, call) +
					`","token_type":"Bearer","expires_in":1,"username":"` + principal + `"}`
			}
			return http.StatusForbidden, `{"error":{"key":"bridge_refused","reason":"credential_epoch_moved","message":"This account's credentials were reset. Sign in again to continue."}}`
		},
		tune: func(cfg *Config) {
			cfg.ClientArgs = helperArgs("hold")
			cfg.MaxSessionDuration = 30 * time.Second
			cfg.IdleTimeout = time.Hour
		},
	})

	client := dialCert(t, h.address, h.authority, "jordan", nil)
	defer client.Close()
	session := openShell(t, client, true)
	defer session.close()

	output := session.collect()
	if !strings.Contains(output, string(ReasonCredentialEpochMoved)) {
		t.Fatalf("output = %q, want it to name credential_epoch_moved", output)
	}
	if !strings.Contains(output, bridge.ReasonCredentialEpochMoved) {
		t.Fatalf("output = %q, want the bridge's own reason", output)
	}
	if !strings.Contains(output, ReissueURL(h.host.Config().Origin)) {
		t.Fatalf("output = %q, want the re-issue URL", output)
	}
}

// TestBridgeUnreachableAtStartupFailsClosed is the startup half of R19a: the
// member gets a reason and no client process at all.
func TestBridgeUnreachableAtStartupFailsClosed(t *testing.T) {
	h := newHarness(t, harnessSettings{tune: withHelper("hold"), noBridge: true})

	client := dialCert(t, h.address, h.authority, "jordan", nil)
	defer client.Close()
	session := openShell(t, client, true)
	defer session.close()

	output := session.collect()
	if !strings.Contains(output, string(ReasonBridgeUnreachable)) {
		t.Fatalf("output = %q, want it to name bridge_unreachable", output)
	}
	if h.observer.saw("spawned") {
		t.Fatal("a client process was started without a token")
	}
}

// TestBridgeUnreachableAtRenewalRetriesThenEndsWithAReason is the renewal half of
// R19a.
func TestBridgeUnreachableAtRenewalRetriesThenEndsWithAReason(t *testing.T) {
	h := newHarness(t, harnessSettings{
		expiresIn: 1,
		respond: func(call int, body map[string]any) (int, string) {
			if call == 1 {
				principal, _ := body["principal"].(string)
				return http.StatusOK, `{"access_token":"` + tokenValue(principal, call) +
					`","token_type":"Bearer","expires_in":1,"username":"` + principal + `"}`
			}
			return http.StatusInternalServerError, ""
		},
		tune: func(cfg *Config) {
			cfg.ClientArgs = helperArgs("hold")
			cfg.RenewalRetryWindow = 300 * time.Millisecond
			cfg.RenewalRetryInterval = 25 * time.Millisecond
			cfg.MaxSessionDuration = 30 * time.Second
			cfg.IdleTimeout = time.Hour
		},
	})

	client := dialCert(t, h.address, h.authority, "jordan", nil)
	defer client.Close()
	session := openShell(t, client, true)
	defer session.close()

	output := session.collect()
	if !strings.Contains(output, string(ReasonTokenPathFailed)) {
		t.Fatalf("output = %q, want it to name token_path_failed", output)
	}
	if !strings.Contains(output, ReissueURL(h.host.Config().Origin)) {
		t.Fatalf("output = %q, want the re-issue URL", output)
	}
	if h.bridge.calls() < 3 {
		t.Fatalf("the bridge saw %d requests, want the renewal retried inside its window", h.bridge.calls())
	}
}

// TestSessionCapsRefuseASecondSessionForOneAccount is the per-account cap over a
// real connection: one member cannot occupy the host.
func TestSessionCapsRefuseASecondSessionForOneAccount(t *testing.T) {
	h := newHarness(t, harnessSettings{
		tune: func(cfg *Config) {
			cfg.ClientArgs = helperArgs("hold")
			cfg.MaxSessionsPerAccount = 1
		},
	})

	first := dialCert(t, h.address, h.authority, "jordan", nil)
	defer first.Close()
	firstSession := openShell(t, first, true)
	defer firstSession.close()
	if _, ok := firstSession.waitFor("TOKEN", 5*time.Second); !ok {
		t.Fatalf("the first session never started:\n%s", firstSession.collect())
	}

	second := dialCert(t, h.address, h.authority, "jordan", nil)
	defer second.Close()
	secondSession := openShell(t, second, true)
	defer secondSession.close()

	output := secondSession.collect()
	if !strings.Contains(output, string(ReasonSessionLimit)) {
		t.Fatalf("output = %q, want it to name session_limit", output)
	}

	// A different account is unaffected by the first account's cap.
	other := dialCert(t, h.address, h.authority, "someone-else", nil)
	defer other.Close()
	otherSession := openShell(t, other, true)
	defer otherSession.close()
	if _, ok := otherSession.waitFor("TOKEN", 5*time.Second); !ok {
		t.Fatalf("the per-account cap refused a different account:\n%s", otherSession.collect())
	}
}

// TestPreAuthenticationConnectionCapRefusesAFlood is R13b's connection cap: over
// the cap the connection is closed before the handshake.
func TestPreAuthenticationConnectionCapRefusesAFlood(t *testing.T) {
	h := newHarness(t, harnessSettings{
		tune: func(cfg *Config) {
			cfg.ClientArgs = helperArgs("hold")
			cfg.MaxPreAuthConnections = 1
		},
	})

	// One connection that never authenticates holds the only pre-auth slot.
	raw, err := net.Dial("tcp", h.address)
	if err != nil {
		t.Fatalf("dial raw: %v", err)
	}
	defer raw.Close() //nolint:errcheck // test

	// Wait until the host has actually ADMITTED that connection. The dial
	// returns once the kernel has queued it, but admission runs in the
	// server's per-connection goroutine, so without this wait the real client
	// below can win the race to the slot and the raw connection is the one
	// refused — a cap working correctly, read as a failure (CI run 3021, and 1
	// full-suite run in 20 on a go-base sandbox).
	admitted := time.Now().Add(5 * time.Second)
	for h.host.Supervisor().Pending() < 1 {
		if time.Now().After(admitted) {
			t.Fatal("the host never admitted the raw connection into the pre-auth slot")
		}
		time.Sleep(5 * time.Millisecond)
	}

	// A real client offered while the slot is taken is turned away before its
	// handshake, so the dial fails rather than hanging.
	if client, err := dialCertRaw(t, h.address, h.authority, "jordan"); err == nil {
		client.Close()
		t.Fatal("a connection was admitted over the pre-auth cap")
	}
	if h.host.Supervisor().Refused() == 0 {
		t.Fatal("no connection was recorded as refused")
	}

	// Freeing the slot admits the next connection.
	_ = raw.Close()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		client, err := dialCertRaw(t, h.address, h.authority, "jordan")
		if err == nil {
			client.Close()
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("the pre-auth slot was never released")
}

// dialCertRaw is dialCert without the fatal, so a test can assert a refusal.
func dialCertRaw(t *testing.T, address string, authority testAuthority, principal string) (*gossh.Client, error) {
	t.Helper()
	subject, _ := newTestKeyPair(t)
	certificate := signedCert(t, authority, principal, subject, nil)
	certSigner, err := gossh.NewCertSigner(certificate, subject)
	if err != nil {
		t.Fatalf("NewCertSigner: %v", err)
	}
	return gossh.Dial("tcp", address, &gossh.ClientConfig{
		User:            principal,
		Auth:            []gossh.AuthMethod{gossh.PublicKeys(certSigner)},
		HostKeyCallback: gossh.InsecureIgnoreHostKey(),
		Timeout:         2 * time.Second,
	})
}

// TestHandshakeDeadlineClosesAnUnauthenticatedConnection is R13b's other bound.
func TestHandshakeDeadlineClosesAnUnauthenticatedConnection(t *testing.T) {
	h := newHarness(t, harnessSettings{
		tune: func(cfg *Config) {
			cfg.HandshakeTimeout = 200 * time.Millisecond
		},
	})

	raw, err := net.Dial("tcp", h.address)
	if err != nil {
		t.Fatalf("dial raw: %v", err)
	}
	defer raw.Close() //nolint:errcheck // test

	if err := raw.SetReadDeadline(time.Now().Add(5 * time.Second)); err != nil {
		t.Fatalf("set deadline: %v", err)
	}

	started := time.Now()
	buffer := make([]byte, 512)
	for {
		_, err := raw.Read(buffer)
		if err != nil {
			break
		}
		if time.Since(started) > 5*time.Second {
			t.Fatal("the handshake deadline never fired")
		}
	}
	if elapsed := time.Since(started); elapsed > 3*time.Second {
		t.Fatalf("the connection was held open for %v past a 200ms handshake deadline", elapsed)
	}
}

// ---------------------------------------------------------------------------
// The child helper
// ---------------------------------------------------------------------------

// TestSessionChildHelper is the client the host spawns: this test binary,
// re-executed with a mode in its host-configured argv. It reads the token
// descriptor from the environment the host built, which is itself the point —
// the child has no other channel to learn where its token is.
//
// Every mode prints one line per fact and then exits, or blocks on stdin when
// the test needs the session to stay open.
func TestSessionChildHelper(t *testing.T) {
	mode := helperMode()
	if mode == "" {
		t.Skip("not the child process")
	}

	fd := 3
	if value := os.Getenv(TokenFDEnv); value != "" {
		parsed, err := strconv.Atoi(value)
		if err != nil {
			fmt.Printf("BADFD %v\n", err)
			os.Exit(2)
		}
		fd = parsed
	}

	fmt.Printf("PID %d\n", os.Getpid())

	switch mode {
	case "hold":
		printFirstToken(fd)
		fmt.Printf("FD %d\n", fd)
		// From here the descriptor is the client's renewal-and-ending channel.
		// The reader reports the host's session-end reason and then leaves, which
		// is what a real client does with the end frame — and it is why this
		// fixture proves delivery rather than merely a write.
		go watchForEndFrame(fd)
		blockOnStdin()

	case "two":
		printFirstToken(fd)
		token, err := readTokenLine(fd, false)
		if err != nil {
			fmt.Printf("TOKEN2-ERR %v\n", err)
			os.Exit(6)
		}
		fmt.Printf("TOKEN2 %s\n", token)

	case "exit7":
		os.Exit(7)

	case "isolation":
		paths := helperPaths()
		if len(paths) != 2 {
			fmt.Println("NOPATHS")
			os.Exit(4)
		}
		printEnvironment()
		printDescriptors()
		for _, path := range paths {
			fmt.Printf("OPEN %s %s\n", path, openResult(path))
		}
		printFirstToken(fd)

	default:
		fmt.Printf("UNKNOWNMODE %s\n", mode)
		os.Exit(5)
	}

	os.Exit(0)
}

// helperMode reads the mode out of the host-configured argv.
func helperMode() string {
	args := helperArgsFromProcess()
	if len(args) == 0 {
		return ""
	}
	return args[0]
}

// helperPaths reads the two paths the isolation assertions try to open.
func helperPaths() []string { return helperArgsFromProcess()[1:] }

// helperArgsFromProcess returns the positional arguments after the `--` in this
// process's argv, which is where the host put the helper's mode.
func helperArgsFromProcess() []string {
	args := os.Args
	for i, arg := range args {
		if arg == "--" {
			return args[i+1:]
		}
	}
	return nil
}

// printFirstToken prints the first token, and it is the ordering assertion.
//
// The read is NON-BLOCKING: if the token were not already buffered in the
// descriptor when the child started, the read returns EAGAIN and this prints
// TOKEN-NOTBUFFERED. That makes "the first token arrives before the child can
// issue a request" a deterministic fact rather than a timing measurement.
func printFirstToken(fd int) {
	token, err := readTokenLine(fd, true)
	if err != nil {
		fmt.Printf("TOKEN-NOTBUFFERED %v\n", err)
		os.Exit(7)
	}
	fmt.Printf("TOKEN %s\n", token)
}

// errTokenNotBuffered is the child's report that nothing was waiting on its
// token descriptor.
var errTokenNotBuffered = errors.New("nothing was buffered on the token descriptor")

// readTokenLine reads one JSON token line off a raw descriptor.
//
// It uses syscalls rather than os.File so the child's read is exactly the read
// the design describes — one read on the inherited descriptor, with no buffer in
// between that could hide an empty pipe behind a partial fill.
func readTokenLine(fd int, nonblocking bool) (string, error) {
	if err := syscall.SetNonblock(fd, nonblocking); err != nil {
		return "", err
	}

	var buffered []byte
	chunk := make([]byte, 4096)
	deadline := time.Now().Add(10 * time.Second)

	for {
		n, err := syscall.Read(fd, chunk)
		if n > 0 {
			buffered = append(buffered, chunk[:n]...)
			if index := bytes.IndexByte(buffered, '\n'); index >= 0 {
				return decodeTokenLine(buffered[:index])
			}
		}

		switch {
		case err == nil:
			// A short read; keep reading.
		case errors.Is(err, syscall.EAGAIN), errors.Is(err, syscall.EWOULDBLOCK):
			if nonblocking {
				return "", errTokenNotBuffered
			}
		case errors.Is(err, syscall.EINTR):
			// Retry.
		default:
			return "", err
		}

		if time.Now().After(deadline) {
			return "", errors.New("timed out reading the token descriptor")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func decodeTokenLine(line []byte) (string, error) {
	var token struct {
		AccessToken string `json:"access_token"`
	}
	if err := json.Unmarshal(bytes.TrimSpace(line), &token); err != nil {
		return "", err
	}
	if token.AccessToken == "" {
		return "", errors.New("token line carried no access_token")
	}
	return token.AccessToken, nil
}

// watchForEndFrame is the client's descriptor reader in miniature: it reads the
// frames that follow the first token and, when the host sends an end frame,
// reports the reason and exits — the client's own reaction to the frame.
//
// It is what makes the frame's DELIVERY a fact rather than an inference. The
// reason can only be printed if the host wrote it while this process still held
// the read end, which is the property the host's announced-ending path exists
// for: a frame written after the child is stopped reaches nobody.
func watchForEndFrame(fd int) {
	for {
		line, err := readFrameLine(fd)
		if err != nil {
			return
		}
		var frame struct {
			End string `json:"end"`
		}
		if err := json.Unmarshal([]byte(line), &frame); err != nil || frame.End == "" {
			// A renewal, or a line that is not a frame. Keep reading.
			continue
		}
		fmt.Printf("END %s\n", frame.End)
		os.Exit(0)
	}
}

// readFrameLine reads one newline-terminated line off the descriptor, blocking.
//
// It uses a raw syscall for the same reason readTokenLine does: no buffering may
// sit between this reader and the descriptor, or a frame could be swallowed by a
// buffer whose owner never returns.
func readFrameLine(fd int) (string, error) {
	if err := syscall.SetNonblock(fd, false); err != nil {
		return "", err
	}

	var buffered []byte
	chunk := make([]byte, 4096)
	deadline := time.Now().Add(30 * time.Second)

	for {
		n, err := syscall.Read(fd, chunk)
		if n > 0 {
			buffered = append(buffered, chunk[:n]...)
			if index := bytes.IndexByte(buffered, '\n'); index >= 0 {
				return string(buffered[:index]), nil
			}
		}

		switch {
		case errors.Is(err, syscall.EINTR):
			// Retry.
		case err != nil:
			return "", err
		case n == 0:
			// End-of-stream: the host closed the write end.
			return "", io.EOF
		}

		if time.Now().After(deadline) {
			return "", errors.New("timed out reading the descriptor")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// printEnvironment writes each variable of the child's environment, which is how
// the isolation assertion checks both what is present and what is absent.
func printEnvironment() {
	for _, entry := range os.Environ() {
		fmt.Printf("ENV %s\n", entry)
	}
}

// printDescriptors writes the child's descriptor table with each entry's kind.
//
// The kind is what carries the assertion, not the raw count: a Go child's
// runtime opens its own poller descriptors after exec, so "exactly 0,1,2,3"
// cannot be true for any Go process. What can be true, and is what matters, is
// that the standard streams are the PTY, the token descriptor is a pipe, and no
// descriptor is a regular file — which is the shape a leaked credential or host
// key would have if one were left open.
func printDescriptors() {
	dir := "/proc/self/fd"
	if _, err := os.Stat(dir); err != nil {
		dir = "/dev/fd"
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		fmt.Printf("FDS-ERR %v\n", err)
		return
	}
	for _, entry := range entries {
		fd, err := strconv.Atoi(entry.Name())
		if err != nil {
			continue
		}
		fmt.Printf("FDENTRY %d %s\n", fd, descriptorKind(fd))
		// The target, so a failure names WHAT the child holds, not just its
		// kind (Linux /proc only; /dev/fd entries are not links).
		if target, err := os.Readlink(dir + "/" + entry.Name()); err == nil {
			fmt.Printf("FDPATH %d %s\n", fd, target)
		}
	}
}

func descriptorKind(fd int) string {
	var stat syscall.Stat_t
	if err := syscall.Fstat(fd, &stat); err != nil {
		return "unstatable"
	}
	switch uint32(stat.Mode) & syscall.S_IFMT {
	case syscall.S_IFIFO:
		return "fifo"
	case syscall.S_IFCHR:
		return "chardev"
	case syscall.S_IFREG:
		// The one regular-file shape that is benign by construction: a kernel
		// cgroup pseudo-file, which the Go runtime opens for itself (see
		// onCgroupFilesystem). Classified by the descriptor's filesystem, not
		// its path, so a secret named like a cgroup file still reads "regular".
		if onCgroupFilesystem(fd) {
			return "cgroupfile"
		}
		return "regular"
	case syscall.S_IFDIR:
		return "directory"
	case syscall.S_IFSOCK:
		return "socket"
	default:
		return "other"
	}
}

// openResult reports what happened when the child tried to open a path that the
// host was supposed to have removed.
func openResult(path string) string {
	file, err := os.Open(path)
	if err == nil {
		file.Close() //nolint:errcheck // test
		return "OPENED"
	}
	if errors.Is(err, os.ErrNotExist) {
		return "no-such-file"
	}
	return "error:" + err.Error()
}

// blockOnStdin keeps the child alive until the session ends.
func blockOnStdin() {
	buffer := make([]byte, 256)
	for {
		if _, err := os.Stdin.Read(buffer); err != nil {
			return
		}
	}
}

// envLines extracts the ENV lines the isolation helper printed.
func envLines(output string) []string {
	var entries []string
	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimSpace(line)
		if after, ok := strings.CutPrefix(line, "ENV "); ok {
			entries = append(entries, strings.TrimSpace(after))
		}
	}
	return entries
}

// fdKinds extracts the descriptor table the helper reported.
// fdPaths reads the child's FDPATH lines: descriptor -> link target. It is
// diagnostic only; the assertion is made on the kinds.
func fdPaths(output string) map[int]string {
	paths := map[int]string{}
	for _, line := range strings.Split(output, "\n") {
		fields := strings.SplitN(strings.TrimSpace(line), " ", 3)
		if len(fields) != 3 || fields[0] != "FDPATH" {
			continue
		}
		fd, err := strconv.Atoi(fields[1])
		if err != nil {
			continue
		}
		paths[fd] = fields[2]
	}
	return paths
}

func fdKinds(output string) map[int]string {
	kinds := map[int]string{}
	for _, line := range strings.Split(output, "\n") {
		fields := strings.Fields(strings.TrimSpace(line))
		if len(fields) != 3 || fields[0] != "FDENTRY" {
			continue
		}
		fd, err := strconv.Atoi(fields[1])
		if err != nil {
			continue
		}
		kinds[fd] = fields[2]
	}
	return kinds
}

// TestTheHostPassesExactlyOneDescriptor is the host-side half of the descriptor
// assertion: whatever a child's runtime opens for itself, the host contributed
// exactly one descriptor beyond the standard streams.
func TestTheHostPassesExactlyOneDescriptor(t *testing.T) {
	host, _ := newTestHost(t, testHostSettings{authority: newTestAuthority(t)})

	pipe := newPipeForTest(t)
	sess := newFakeSession(newFakeContext("jordan", map[string]string{}))
	sess.hasPTY = true

	command := host.clientCommand(sess, pipe)
	if got := len(command.ExtraFiles); got != 1 {
		t.Fatalf("the client command inherits %d descriptors, want exactly 1", got)
	}
	if command.ExtraFiles[0] != pipe.ChildFile() {
		t.Fatal("the inherited descriptor is not the token pipe's read end")
	}
	if pipe.ChildFD() != 3 {
		t.Fatalf("the token descriptor is fd %d, want 3", pipe.ChildFD())
	}
	if command.Dir != host.Config().ClientDir {
		t.Errorf("the child's working directory = %q, want %q", command.Dir, host.Config().ClientDir)
	}
	if len(command.Env) != 4 {
		t.Errorf("the child's environment has %d entries, want 4: %v", len(command.Env), command.Env)
	}
}

// panickingObserver fails the way an integration observer could: it panics on
// the first lifecycle event it sees.
type panickingObserver struct{}

func (panickingObserver) FirstTokenWritten(string, time.Time) {
	panic("observer panic in FirstTokenWritten")
}
func (panickingObserver) ChildSpawned(string, time.Time) { panic("observer panic in ChildSpawned") }
func (panickingObserver) TokenRenewed(string, time.Time) { panic("observer panic in TokenRenewed") }
func (panickingObserver) SessionEnded(string, EndReason, time.Time) {
	panic("observer panic in SessionEnded")
}

// TestAPanicCostsOneSessionNotTheServer is the recovery middleware's assertion.
//
// A session runs on the connection's own goroutine and Go has no process-wide
// panic handler, so an unrecovered panic anywhere in the handoff would take the
// whole host down — every other member's session with it. Three sessions are run
// through the assembled handler; if the middleware were missing, this test binary
// would die on the first.
func TestAPanicCostsOneSessionNotTheServer(t *testing.T) {
	// The middleware logs the recovered panic and its stack to charm's standard
	// logger; the assertion is the recovery, not the log, so the log is silenced.
	// Nothing else in this package writes through it.
	log.SetOutput(io.Discard)

	host, _ := newTestHost(t, testHostSettings{
		authority: newTestAuthority(t),
		observer:  panickingObserver{},
	})

	handler := host.Server().Handler
	if handler == nil {
		t.Fatal("the assembled server has no handler")
	}

	for i := 0; i < 3; i++ {
		sess := newFakeSession(newFakeContext("jordan", identityExtensionsFor(t, "jordan", 42)))
		sess.hasPTY = false

		// A panic escaping here fails the test by crashing it, which is the
		// failure mode being asserted against.
		handler(sess)
	}
}
