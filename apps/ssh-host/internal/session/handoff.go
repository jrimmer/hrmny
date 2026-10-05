// Package session is the SSH host's session layer: it takes an authenticated
// connection, exchanges the verified certificate identity for an access token,
// spawns exactly one client process per connection, keeps the token path alive
// for the life of the session, and owns the message a member reads when the
// session ends.
//
// # The pieces, and the requirement each answers
//
//   - Handoff.Run — one client process per connection (R12), the PTY as its
//     standard input and output, the token pipe as an inherited descriptor
//     (R12a, R27);
//   - the renewal loop — a fresh token written to that descriptor before the
//     previous one expires, with the certificate's remaining validity re-checked
//     before every renewal (R13), and the credential epoch enforced by the
//     mint the bridge performs (R13a);
//   - ReasonCode / EndReason — the session-end vocabulary, delivered two ways:
//     as an end frame on the client's token descriptor while the client is still
//     running, and as a block on the SSH channel AFTER the child process exits so
//     it never contends with the client's own drawing on the same PTY (R19a);
//   - Limiter — sessions per connection, in aggregate, and per account;
//   - ConnSupervisor — the pre-authentication connection cap and the transport
//     activity clock the idle timeout reads (R13b).
//
// # What this package deliberately does not do
//
// It never reads a member-supplied value into the child's environment. The
// session cannot redirect a freshly minted token at a server of its choosing
// (R14) because the child's environment is constructed from host configuration
// only: PATH, TERM, the configured origin, and the descriptor number. Environment
// requests from the client are refused rather than stored, and nothing here ever
// consults Session.Environ().
package session

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"charm.land/ssh"
	"charm.land/wish/v2/recover"
	gossh "golang.org/x/crypto/ssh"

	"github.com/jrimmer/hrmny/apps/ssh-host/internal/auth"
	"github.com/jrimmer/hrmny/apps/ssh-host/internal/bridge"
	"github.com/jrimmer/hrmny/apps/ssh-host/internal/tokens"
)

// Environment variable names the child is started with. They are the only
// channel the host uses to tell the client what it needs to know, and all four
// are host-configured.
const (
	// OriginEnv carries the Cytale server origin. The client resolves its REST
	// and gateway URLs from it, and the session cannot override it (R14).
	OriginEnv = "CYTALE_ORIGIN"

	// TokenFDEnv carries the descriptor number the client reads tokens from.
	TokenFDEnv = "CYTALE_TOKEN_FD"
)

// The settings page a member re-issues a certificate from (U3's surface).
const reissuePath = "/#/settings/ssh"

// ---------------------------------------------------------------------------
// The session-end vocabulary (R19a)
// ---------------------------------------------------------------------------

// ReasonCode is the stable, machine-readable cause of a session ending. It is
// what U5 renders and what U17's end-to-end script asserts on, so it changes
// only when a new cause appears.
type ReasonCode string

// The vocabulary, one code per way a session ends.
const (
	// ReasonClientExited is a clean exit: the member quit the client. Nothing is
	// printed, because the client already owns the terminal's last word.
	ReasonClientExited ReasonCode = "client_exited"

	// ReasonClientFailed is the client exiting non-zero.
	ReasonClientFailed ReasonCode = "client_failed"

	// ReasonClientStartFailed is the child process failing to start at all.
	ReasonClientStartFailed ReasonCode = "client_start_failed"

	// ReasonNoPTY is a session request with no PTY (R11).
	ReasonNoPTY ReasonCode = "no_pty"

	// ReasonCommandNotSupported is an exec request carrying a command. This host
	// runs one client and takes no command.
	ReasonCommandNotSupported ReasonCode = "command_not_supported"

	// ReasonIdentityMissing is a session arriving without a verified certificate
	// identity, which means it is running outside the verifier.
	ReasonIdentityMissing ReasonCode = "identity_missing"

	// ReasonSessionLimit is one of the three session caps refusing this session.
	ReasonSessionLimit ReasonCode = "session_limit"

	// ReasonBridgeUnreachable is the startup mint failing at the transport.
	// Fail closed: no token, no client process.
	ReasonBridgeUnreachable ReasonCode = "bridge_unreachable"

	// ReasonBridgeRefused is the startup mint being refused by the bridge.
	ReasonBridgeRefused ReasonCode = "bridge_refused"

	// ReasonCertificateExpired is the certificate's window closing before a
	// renewal: the session must not outlive it (R13).
	ReasonCertificateExpired ReasonCode = "certificate_expired"

	// ReasonCredentialEpochMoved is the bridge refusing a renewal because the
	// account's credential epoch moved — the bound R13a claims, reached through
	// the mint the bridge owns.
	ReasonCredentialEpochMoved ReasonCode = "credential_epoch_moved"

	// ReasonTokenPathFailed is the token path failing: the bridge unreachable
	// through the whole retry window, or the descriptor closed.
	ReasonTokenPathFailed ReasonCode = "token_path_failed"

	// ReasonMaxDuration is the session's absolute maximum duration.
	ReasonMaxDuration ReasonCode = "max_session_duration"

	// ReasonIdleTimeout is the session's idle timeout.
	ReasonIdleTimeout ReasonCode = "idle_timeout"

	// ReasonConnectionLost is the SSH connection disappearing. There is nothing
	// to print on; the code exists for the log.
	ReasonConnectionLost ReasonCode = "connection_lost"
)

// EndReason is why a session ended: a code, the bridge's own reason when the
// bridge is what refused, and the member-facing sentence the bridge wrote.
type EndReason struct {
	Code ReasonCode

	// BridgeReason is the bridge's machine-readable reason, verbatim. Present
	// only when the bridge refused.
	BridgeReason string

	// Detail is the bridge's member-facing message, or a short host sentence.
	// It is SERVER-supplied in the bridge case and is rendered inert.
	Detail string
}

// Reissued reports whether the remedy for this reason is re-issuing a
// certificate, which is what decides whether the message carries the URL.
func (r EndReason) Reissued() bool {
	switch r.Code {
	case ReasonCertificateExpired, ReasonCredentialEpochMoved, ReasonBridgeRefused:
		return true
	case ReasonTokenPathFailed:
		return true
	default:
		return false
	}
}

// ReissueURL is the page a member re-issues a certificate from.
func ReissueURL(origin string) string {
	return strings.TrimSuffix(strings.TrimSpace(origin), "/") + reissuePath
}

// MemberMessage is the sentence the member reads (R19a).
//
// Every value folded into it is either a host constant or a server-supplied
// string that sanitizeTerminalText has made inert, because a message written to
// a terminal is exactly where an escape sequence would do damage (R26a).
func (r EndReason) MemberMessage(origin string) string {
	detail := sanitizeTerminalText(r.Detail)
	reissue := ReissueURL(origin)

	switch r.Code {
	case ReasonClientExited:
		return ""
	case ReasonClientFailed:
		return "The terminal client exited unexpectedly. Reconnect to continue."
	case ReasonClientStartFailed:
		return "The terminal client could not be started on this host. An operator needs to check the deployment."
	case ReasonNoPTY:
		return "This host runs an interactive client, so it needs a terminal. Reconnect without -T."
	case ReasonCommandNotSupported:
		return "This host runs one client and accepts no command. Reconnect without a command."
	case ReasonIdentityMissing:
		return "This connection carried no verified certificate identity, so no session could start. Reconnect with your certificate."
	case ReasonSessionLimit:
		if detail != "" {
			return "This session was refused: " + detail
		}
		return "This host is at its session limit. Close another terminal session and reconnect."
	case ReasonBridgeUnreachable:
		return "The Hrmny server could not be reached to start your session. Try again in a moment."
	case ReasonBridgeRefused:
		return "This session was refused by the server: " + detail + " Issue a new certificate at " + reissue + " and reconnect."
	case ReasonCertificateExpired:
		return "Your certificate expired while this session was open. Issue a new one at " + reissue + " and reconnect."
	case ReasonCredentialEpochMoved:
		return "This account's credentials were reset, so the session ended. Sign in again and issue a new certificate at " + reissue + "."
	case ReasonTokenPathFailed:
		sentence := "This session's token could not be renewed"
		if detail != "" {
			sentence += ": " + detail
		}
		return sentence + ". Reconnect to continue, and issue a new certificate at " + reissue + " if it happens again."
	case ReasonMaxDuration:
		return "This session reached its maximum duration and has ended. Reconnect to continue."
	case ReasonIdleTimeout:
		return "This session was idle for too long and has ended. Reconnect to continue."
	case ReasonConnectionLost:
		return "The connection was lost."
	default:
		return "This session ended. Reconnect to continue."
	}
}

// Rendering is the block written to the SSH channel after the child process
// exits. It always names the code so a member (and U17's script) can tell which
// bound was hit, and it is plain text: the host owns the vocabulary, the client
// owns the drawing.
func (r EndReason) Rendering(origin string) string {
	message := r.MemberMessage(origin)
	if message == "" {
		return ""
	}

	var b strings.Builder
	b.WriteString("\r\n\r\n── session ended ──\r\n")
	b.WriteString(message)
	b.WriteString("\r\n")
	b.WriteString("(reason: ")
	b.WriteString(string(r.Code))
	if r.BridgeReason != "" {
		b.WriteString(", bridge: ")
		b.WriteString(sanitizeTerminalText(r.BridgeReason))
	}
	b.WriteString(")\r\n")
	return b.String()
}

// String is the log spelling. It carries the code and the bridge reason and
// never a token or a credential.
func (r EndReason) String() string {
	if r.BridgeReason == "" {
		return string(r.Code)
	}
	return string(r.Code) + "(" + r.BridgeReason + ")"
}

// ExitCode is the status the session reports to the client.
func (r EndReason) ExitCode() int {
	if r.Code == ReasonClientExited {
		return 0
	}
	return 1
}

// ---------------------------------------------------------------------------
// The end frame: the reason on the client's own descriptor (R19a, KTD8)
// ---------------------------------------------------------------------------

// endFrameCode reports whether an ending carries an end frame to the client, and
// the code it spells.
//
// THE RULE, stated so it cannot drift: the host pushes an end frame when the
// HOST decided to end a session whose client is still running. That client holds
// the descriptor's read end, its reader is live, and the frame is what turns the
// cause into the message the client renders — without it the client sees a bare
// end-of-stream and has to invent a cause, which is the one thing R19a says it
// must not do.
//
// Two categories deliberately carry NO frame, and for the same reason — there is
// nobody left to read it:
//
//   - the ending is the child's own exit (client_exited, client_failed) or the
//     child never started (client_start_failed, and every refusal that happens
//     before the pipe exists at all: no_pty, command_not_supported,
//     identity_missing, session_limit, bridge_unreachable, and the startup
//     bridge_refused). Telling a process that has already exited why it is
//     stopping is meaningless, and for the pre-spawn refusals no descriptor has
//     been created yet, so the SSH channel block written by end() is the only
//     channel there is;
//   - the connection is gone (connection_lost). The member's terminal went with
//     it, so a frame has nobody to reach; that code exists for the log.
//
// Everything else is a live client the host is stopping, and gets the frame.
func endFrameCode(code ReasonCode) (string, bool) {
	switch code {
	case ReasonMaxDuration,
		ReasonIdleTimeout,
		ReasonCertificateExpired,
		ReasonCredentialEpochMoved,
		ReasonBridgeRefused,
		ReasonTokenPathFailed:
		return string(code), true
	default:
		return "", false
	}
}

// announceEnd writes the session-end frame to the client's descriptor.
//
// It must be called while the child still holds the read end and before
// CloseWrite: the frame travels on the write end, so a frame written after the
// child is stopped, or after the write end is closed, is a frame that reaches
// nobody. A failure is not fatal — the SSH channel block end() writes after the
// child exits is still the member's authoritative message — so it is logged and
// the ending proceeds.
func (h *Host) announceEnd(pipe *tokens.Pipe, code string) {
	if err := pipe.SendEnd(code); err != nil {
		h.cfg.Logger.Debug("could not deliver the session-end frame to the client", "reason", code, "error", err)
	}
}

// endAnnounced ends a session the HOST decided to end: the client is told why on
// its descriptor, the write end is closed behind the frame, and the child is
// given the teardown window to leave on its own before it is killed.
//
// The frame is the whole point, and it is worth nothing if the child is killed
// before it can act on it: a reason sitting in a pipe whose reader is already
// dead is the same bare end-of-stream this frame replaces. So the kill comes
// second — bounded by KillGrace, which is why a client that ignores the frame
// still cannot outlive its session.
func (h *Host) endAnnounced(pipe *tokens.Pipe, command *exec.Cmd, done <-chan error, reason EndReason) EndReason {
	code, announced := endFrameCode(reason.Code)
	if !announced {
		// Not a live client: nothing to announce, and no reason to wait.
		h.stop(command, done)
		return reason
	}

	h.announceEnd(pipe, code)

	// CloseWrite, not Close: the client's reader finds end-of-stream immediately
	// behind the frame, so it ends now rather than waiting for a renewal that
	// will not come. Nothing after this point can carry a frame.
	_ = pipe.CloseWrite()

	select {
	case <-done:
		// The client honoured the frame and exited.
	case <-time.After(h.cfg.KillGrace):
		h.stop(command, done)
	}
	return reason
}

// ---------------------------------------------------------------------------
// The child's environment
// ---------------------------------------------------------------------------

// ChildEnv is the child's ENTIRE environment, built from host configuration.
//
// This is the R14 property and it is worth stating precisely: the host sets the
// origin, so the session cannot override it, and the child has no argv or
// environment channel through which a member could redirect a freshly minted
// token at a server of their choosing. Nothing here reads Session.Environ():
// environment requests are refused at the request level, and ignoring them here
// as well means a client that finds a way to have one accepted still cannot
// reach the child.
func ChildEnv(cfg Config, term string, fd int) []string {
	return []string{
		"PATH=" + cfg.ChildPath,
		"TERM=" + terminalName(term),
		OriginEnv + "=" + cfg.Origin,
		TokenFDEnv + "=" + strconv.Itoa(fd),
	}
}

// terminalName sanitizes the PTY's terminal type.
//
// TERM is member-supplied: the SSH client sends whatever its own environment
// says. It cannot be used to inject another variable, but it is still an
// unvalidated string on its way into a child's environment, so it is filtered to
// the characters a terminal name can legitimately contain.
func terminalName(term string) string {
	var b strings.Builder
	for _, r := range term {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
			b.WriteRune(r)
		case r == '-' || r == '_' || r == '.' || r == '+':
			b.WriteRune(r)
		}
		if b.Len() >= 64 {
			break
		}
	}
	if b.Len() == 0 {
		return "xterm-256color"
	}
	return b.String()
}

// sanitizeTerminalText strips every C0/C1 control character from
// server-supplied text before the host writes it to a member's terminal (R26a).
//
// The bridge's message is written by Cytale's own code today, but it is a
// server-supplied string on its way to a terminal, which is the category R26a
// covers, and this host must not be the place that depends on the server being
// careful.
func sanitizeTerminalText(value string) string {
	var b strings.Builder
	for _, r := range value {
		if r == '\n' || r == '\t' {
			b.WriteRune(r)
			continue
		}
		if r < 0x20 || r == 0x7f || (r >= 0x80 && r <= 0x9f) {
			continue
		}
		b.WriteRune(r)
	}
	return b.String()
}

// ---------------------------------------------------------------------------
// The session caps
// ---------------------------------------------------------------------------

// Limiter bounds concurrent sessions three ways: in aggregate, per SSH
// connection, and per account.
//
// The per-account bound is the one that matters for fairness: without it one
// member opening connections in a loop occupies the aggregate cap and no other
// member can reach the host at all.
type Limiter struct {
	mu sync.Mutex

	maxTotal, maxPerAccount, maxPerConnection int

	total      int
	perAccount map[string]int
	perConn    map[string]int
}

// NewLimiter builds a limiter. A bound of zero or less is unlimited for that
// dimension, which is how a test isolates one cap from the others.
func NewLimiter(maxTotal, maxPerAccount, maxPerConnection int) *Limiter {
	return &Limiter{
		maxTotal:         maxTotal,
		maxPerAccount:    maxPerAccount,
		maxPerConnection: maxPerConnection,
		perAccount:       map[string]int{},
		perConn:          map[string]int{},
	}
}

// Acquire reserves a session slot. The returned release function is idempotent.
func (l *Limiter) Acquire(account, connection string) (func(), EndReason, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()

	if l.maxTotal > 0 && l.total >= l.maxTotal {
		return func() {}, EndReason{
			Code:   ReasonSessionLimit,
			Detail: "this host is at its limit of concurrent terminal sessions.",
		}, false
	}
	if l.maxPerAccount > 0 && l.perAccount[account] >= l.maxPerAccount {
		return func() {}, EndReason{
			Code:   ReasonSessionLimit,
			Detail: "this account already has as many terminal sessions open as it may.",
		}, false
	}
	if l.maxPerConnection > 0 && l.perConn[connection] >= l.maxPerConnection {
		return func() {}, EndReason{
			Code:   ReasonSessionLimit,
			Detail: "this connection already has as many terminal sessions open as it may.",
		}, false
	}

	l.total++
	l.perAccount[account]++
	l.perConn[connection]++

	var once sync.Once
	return func() {
		once.Do(func() {
			l.mu.Lock()
			defer l.mu.Unlock()
			l.total--
			if l.perAccount[account] <= 1 {
				delete(l.perAccount, account)
			} else {
				l.perAccount[account]--
			}
			if l.perConn[connection] <= 1 {
				delete(l.perConn, connection)
			} else {
				l.perConn[connection]--
			}
		})
	}, EndReason{}, true
}

// Counts reports the live totals, for tests and for a boot log line.
func (l *Limiter) Counts() (total int, accounts int, connections int) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.total, len(l.perAccount), len(l.perConn)
}

// ---------------------------------------------------------------------------
// Pre-auth admission and activity
// ---------------------------------------------------------------------------

// ActivityTracker records the last moment bytes moved on one connection.
//
// It is deliberately at the transport rather than at the session: the idle
// timeout is about a session that is not doing anything, and the transport is
// the only place the host can see everything a session does — input, the
// client's own redraws, its keepalives, and the gateway traffic the client
// relays.
type ActivityTracker struct {
	last atomic.Int64
}

// Touch records activity now.
func (t *ActivityTracker) Touch() {
	t.last.Store(time.Now().UnixNano())
}

// IdleFor is how long the connection has been silent. A tracker that has never
// been touched reports its whole age, which is the right answer for a connection
// that has not moved a byte.
func (t *ActivityTracker) IdleFor(now time.Time) time.Duration {
	return now.Sub(time.Unix(0, t.last.Load()))
}

type connStateKeyType struct{}

var connStateKey = connStateKeyType{}

type connState struct {
	activity *ActivityTracker
}

// ConnSupervisor admits connections before authentication and reports how many
// it refused.
//
// The cap is enforced where the transport allows a hard refusal: the connection
// callback runs before the handshake, and returning nil there makes the server
// close the connection. It is released when the connection closes, or as soon as
// the connection authenticates — a connection that has authenticated is no
// longer pre-auth work, and its session is bounded by the session caps instead.
type ConnSupervisor struct {
	max int

	mu      sync.Mutex
	pending map[string]struct{}
	refused atomic.Int64
}

// NewConnSupervisor builds a supervisor. A cap of zero or less disables it.
func NewConnSupervisor(max int) *ConnSupervisor {
	return &ConnSupervisor{max: max, pending: map[string]struct{}{}}
}

// Refused is how many connections were turned away for being over the cap.
func (s *ConnSupervisor) Refused() int64 { return s.refused.Load() }

// Pending is how many connections are presently pre-auth.
func (s *ConnSupervisor) Pending() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.pending)
}

// wrap admits the connection and returns a connection that releases its slot
// when it closes. A nil return tells the server to close the connection.
func (s *ConnSupervisor) wrap(conn net.Conn) net.Conn {
	key := connKey(conn)

	s.mu.Lock()
	if s.max > 0 && len(s.pending) >= s.max {
		s.mu.Unlock()
		s.refused.Add(1)
		return nil
	}
	s.pending[key] = struct{}{}
	s.mu.Unlock()

	return &supervisedConn{Conn: conn, release: func() { s.release(key) }}
}

func (s *ConnSupervisor) release(key string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.pending, key)
}

// authenticated releases the pre-auth slot for a connection that has logged in.
func (s *ConnSupervisor) authenticated(conn gossh.ConnMetadata) {
	if conn == nil {
		return
	}
	addr := conn.RemoteAddr()
	if addr == nil {
		return
	}
	s.release(addr.String())
}

// connKey identifies a connection by its remote address, which is unique per
// live TCP connection because the source port is part of it. It is the only
// handle the pre-auth callback and the auth callback share: ConnMetadata has no
// connection id at the point the callback runs.
func connKey(conn net.Conn) string {
	if conn == nil || conn.RemoteAddr() == nil {
		return "unknown"
	}
	return conn.RemoteAddr().String()
}

// supervisedConn releases a pre-auth slot when the connection closes.
type supervisedConn struct {
	net.Conn
	once    sync.Once
	release func()
}

func (c *supervisedConn) Close() error {
	c.once.Do(c.release)
	return c.Conn.Close()
}

// ActivityConn touches the tracker on every read and write.
type ActivityConn struct {
	net.Conn
	tracker *ActivityTracker
}

func (c *ActivityConn) Read(p []byte) (int, error) {
	n, err := c.Conn.Read(p)
	if n > 0 {
		c.tracker.Touch()
	}
	return n, err
}

func (c *ActivityConn) Write(p []byte) (int, error) {
	n, err := c.Conn.Write(p)
	if n > 0 {
		c.tracker.Touch()
	}
	return n, err
}

// ActivityFromContext returns the connection's activity tracker, or nil.
func ActivityFromContext(ctx ssh.Context) *ActivityTracker {
	if ctx == nil {
		return nil
	}
	state, ok := ctx.Value(connStateKey).(*connState)
	if !ok {
		return nil
	}
	return state.activity
}

// ---------------------------------------------------------------------------
// Request policy
// ---------------------------------------------------------------------------

// refusedSessionRequests are the session-channel request types this host
// refuses (R11), plus environment requests.
//
// Three of them need this filter even though the underlying library would also
// refuse them, because the refusal must be the host's stated policy rather than
// a library default: agent forwarding in particular is ACCEPTED by the charm
// fork's session loop with no option to turn it off, so without this the
// request would be answered true and the member's agent would be advertised as
// forwarded.
//
// Environment requests are the addition beyond R11's list: the fork stores them
// and answers true, and this host's child environment is built from host
// configuration alone, so accepting one and ignoring it would be a lie to the
// client. Refusing is both honest and strictly safer.
var refusedSessionRequests = map[string]string{
	"auth-agent-req@openssh.com": "agent forwarding",
	"x11-req":                    "X11 forwarding",
	"subsystem":                  "subsystem requests",
	"env":                        "environment requests",
}

// policyChannel filters a session channel's requests before the library's
// session loop sees them.
//
// It exists because gossh.NewChannel is an interface: accepting the channel in
// a wrapper and handing the library a filtered request stream is the only way
// to refuse a request at the protocol level while keeping the library's
// session handling (PTY allocation, resize, signals) intact.
type policyChannel struct {
	gossh.NewChannel
	log *slog.Logger
}

func (c *policyChannel) Accept() (gossh.Channel, <-chan *gossh.Request, error) {
	channel, requests, err := c.NewChannel.Accept()
	if err != nil {
		return nil, nil, err
	}

	filtered := make(chan *gossh.Request)
	go func() {
		defer close(filtered)
		for req := range requests {
			if role, refused := refusedSessionRequests[req.Type]; refused {
				c.log.Warn("refused an unsupported SSH session request",
					"request", req.Type, "means", role)
				_ = req.Reply(false, nil)
				continue
			}
			filtered <- req
		}
	}()

	return channel, filtered, nil
}

// refusePortForwardRequest answers a global tcpip-forward request with a
// refusal. Answering is the point: a registered handler that says no is a stated
// policy, where an unregistered one is an absence.
func refusePortForwardRequest(_ ssh.Context, _ *ssh.Server, _ *gossh.Request) (bool, []byte) {
	return false, nil
}

// refuseForwardChannel rejects a channel-open of a forwarding type.
func refuseForwardChannel(_ *ssh.Server, _ *gossh.ServerConn, newChan gossh.NewChannel, _ ssh.Context) {
	_ = newChan.Reject(gossh.Prohibited, "port forwarding is not available on this host")
}

// ---------------------------------------------------------------------------
// The host
// ---------------------------------------------------------------------------

// Minter exchanges a verified identity for an access token. The production
// implementation is *bridge.Client.
type Minter interface {
	Mint(ctx context.Context, req bridge.MintRequest) (bridge.Minted, error)
}

// Observer receives session lifecycle events. It exists for tests and for an
// integration harness that needs to see the ordering the design guarantees (the
// first token is written before the child starts). Production passes nil.
//
// Implementations are called from each session's own goroutine and must be safe
// for concurrent use.
type Observer interface {
	FirstTokenWritten(sessionID string, at time.Time)
	ChildSpawned(sessionID string, at time.Time)
	TokenRenewed(sessionID string, at time.Time)
	SessionEnded(sessionID string, reason EndReason, at time.Time)
}

// Config is the host's configuration. Every value comes from the environment at
// boot (see the command package) or from the deployment's secret material.
type Config struct {
	// ListenAddress is the published SSH port.
	ListenAddress string

	// ClientCommand is the client process's argv, host-configured. argv[0] must
	// be an absolute path.
	ClientCommand []string

	// ClientArgs are host-configured arguments appended to ClientCommand. They
	// are NOT a session channel: nothing a member sends reaches this slice.
	ClientArgs []string

	// ClientDir is the child's working directory. It is set explicitly so the
	// child never inherits a directory from the host process.
	ClientDir string

	// Origin is the Cytale server origin the client talks to.
	Origin string

	// ChildPath is the PATH the child runs with.
	ChildPath string

	// MaxSessionDuration is the absolute session bound (R13).
	MaxSessionDuration time.Duration

	// IdleTimeout ends a session whose connection has seen no traffic for this
	// long (R13).
	IdleTimeout time.Duration

	// IdlePollInterval is how often the idle bound is evaluated. It bounds the
	// granularity of the timeout, not the timeout itself.
	IdlePollInterval time.Duration

	// RenewBefore is how long before expiry a renewal is attempted. Zero means a
	// third of the token's lifetime.
	RenewBefore time.Duration

	// RenewalRetryWindow bounds how long a renewal keeps retrying an unreachable
	// bridge before the session ends (R19a).
	RenewalRetryWindow time.Duration

	// RenewalRetryInterval is the pause between those retries.
	RenewalRetryInterval time.Duration

	// KillGrace is the teardown window. A client the host stops is given this
	// long to exit after its ending has been announced on the descriptor (a
	// client that honours the end frame leaves immediately), and then this long
	// again to be reaped once it is killed.
	KillGrace time.Duration

	// HandshakeTimeout bounds an unauthenticated connection (R13b).
	HandshakeTimeout time.Duration

	// MaxAuthTries caps authentication attempts per connection (R13b).
	MaxAuthTries int

	// MaxPreAuthConnections caps concurrent unauthenticated connections (R13b).
	MaxPreAuthConnections int

	// MaxSessionsTotal, MaxSessionsPerAccount and MaxSessionsPerConnection cap
	// concurrent sessions. The per-account cap is what stops one member
	// occupying the aggregate cap.
	MaxSessionsTotal         int
	MaxSessionsPerAccount    int
	MaxSessionsPerConnection int

	// ConnectionGrace is added to MaxSessionDuration for the transport's own
	// absolute connection timeout, so the session bound is what a member
	// experiences and the transport bound is a backstop.
	ConnectionGrace time.Duration

	// Now is the clock the certificate-validity comparison reads. Nil means
	// time.Now. It is a seam rather than a setting: a test proves that a renewal
	// refuses to extend a session past the certificate's window by moving the
	// clock, rather than by waiting for a real certificate to expire.
	Now func() time.Time

	// Observer is optional; see Observer.
	Observer Observer

	// Logger is optional; a discard logger is used when nil.
	Logger *slog.Logger
}

// Defaults, stated so a deployment's behaviour is never implied. They are
// applied by applyDefaults and documented in the README.
const (
	DefaultListenAddress            = ":2222"
	DefaultOrigin                   = "http://127.0.0.1:4000"
	DefaultChildPath                = "/usr/local/bin:/usr/bin:/bin"
	DefaultMaxSessionDuration       = 12 * time.Hour
	DefaultIdleTimeout              = 30 * time.Minute
	DefaultRenewalRetryWindow       = 60 * time.Second
	DefaultRenewalRetryInterval     = 5 * time.Second
	DefaultKillGrace                = 5 * time.Second
	DefaultHandshakeTimeout         = 30 * time.Second
	DefaultMaxAuthTries             = 3
	DefaultMaxPreAuthConnections    = 64
	DefaultMaxSessionsTotal         = 128
	DefaultMaxSessionsPerAccount    = 4
	DefaultMaxSessionsPerConnection = 2
	DefaultConnectionGrace          = 2 * time.Minute

	// DefaultIdlePollInterval is how often the idle bound is evaluated. It
	// bounds the granularity of the timeout, not the timeout itself.
	DefaultIdlePollInterval = time.Second
)

func (c *Config) applyDefaults() {
	if c.ListenAddress == "" {
		c.ListenAddress = DefaultListenAddress
	}
	if c.Origin == "" {
		c.Origin = DefaultOrigin
	}
	if c.ChildPath == "" {
		c.ChildPath = DefaultChildPath
	}
	if c.MaxSessionDuration <= 0 {
		c.MaxSessionDuration = DefaultMaxSessionDuration
	}
	if c.IdleTimeout <= 0 {
		c.IdleTimeout = DefaultIdleTimeout
	}
	if c.IdlePollInterval <= 0 {
		c.IdlePollInterval = DefaultIdlePollInterval
	}
	if c.RenewalRetryWindow <= 0 {
		c.RenewalRetryWindow = DefaultRenewalRetryWindow
	}
	if c.RenewalRetryInterval <= 0 {
		c.RenewalRetryInterval = DefaultRenewalRetryInterval
	}
	if c.KillGrace <= 0 {
		c.KillGrace = DefaultKillGrace
	}
	if c.HandshakeTimeout <= 0 {
		c.HandshakeTimeout = DefaultHandshakeTimeout
	}
	if c.MaxAuthTries <= 0 {
		c.MaxAuthTries = DefaultMaxAuthTries
	}
	if c.MaxPreAuthConnections <= 0 {
		c.MaxPreAuthConnections = DefaultMaxPreAuthConnections
	}
	if c.MaxSessionsTotal <= 0 {
		c.MaxSessionsTotal = DefaultMaxSessionsTotal
	}
	if c.MaxSessionsPerAccount <= 0 {
		c.MaxSessionsPerAccount = DefaultMaxSessionsPerAccount
	}
	if c.MaxSessionsPerConnection <= 0 {
		c.MaxSessionsPerConnection = DefaultMaxSessionsPerConnection
	}
	if c.ConnectionGrace <= 0 {
		c.ConnectionGrace = DefaultConnectionGrace
	}
	if c.Logger == nil {
		c.Logger = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
}

func (c Config) validate() error {
	if len(c.ClientCommand) == 0 || strings.TrimSpace(c.ClientCommand[0]) == "" {
		return errors.New("session: the client command is required")
	}
	if !strings.HasPrefix(c.ClientCommand[0], "/") {
		return fmt.Errorf("session: the client command must be an absolute path, got %q", c.ClientCommand[0])
	}
	if strings.TrimSpace(c.ClientDir) == "" {
		return errors.New("session: the client working directory is required")
	}
	info, err := os.Stat(c.ClientDir)
	if err != nil {
		return fmt.Errorf("session: client working directory: %w", err)
	}
	if !info.IsDir() {
		return fmt.Errorf("session: client working directory %s is not a directory", c.ClientDir)
	}
	if _, err := os.Stat(c.ClientCommand[0]); err != nil {
		return fmt.Errorf("session: client command: %w", err)
	}
	origin := strings.TrimSpace(c.Origin)
	if !strings.HasPrefix(origin, "http://") && !strings.HasPrefix(origin, "https://") {
		return fmt.Errorf("session: origin %q must be an http or https URL", origin)
	}
	return nil
}

// Host is the assembled SSH host: a server, its seams, and the assertions that
// the seams are actually wired.
type Host struct {
	cfg        Config
	verifier   *auth.Verifier
	minter     Minter
	hostKey    gossh.Signer
	limiter    *Limiter
	supervisor *ConnSupervisor
	server     *ssh.Server
}

// NewHost assembles the server and runs the boot assertions.
//
// The assertions are not ceremony: the charm fork enables NoClientAuth — a
// silent fail-open that accepts every connection — when every handler and
// callback is nil, and assigning Server.PublicKeyHandler makes the fork replace
// the verifier callback. Both are checked here, at boot, rather than trusted.
func NewHost(cfg Config, verifier *auth.Verifier, minter Minter, hostKey gossh.Signer) (*Host, error) {
	cfg.applyDefaults()
	if err := cfg.validate(); err != nil {
		return nil, err
	}
	if verifier == nil {
		return nil, errors.New("session: a certificate verifier is required")
	}
	if minter == nil {
		return nil, errors.New("session: a bridge minter is required")
	}
	if hostKey == nil {
		return nil, errors.New("session: a host key is required")
	}

	h := &Host{
		cfg:        cfg,
		verifier:   verifier,
		minter:     minter,
		hostKey:    hostKey,
		limiter:    NewLimiter(cfg.MaxSessionsTotal, cfg.MaxSessionsPerAccount, cfg.MaxSessionsPerConnection),
		supervisor: NewConnSupervisor(cfg.MaxPreAuthConnections),
	}

	// The handler chain: panic containment per session first, so a panic in the
	// handoff — or in a middleware above it — costs one session, not the whole
	// server process.
	handler := recover.Middleware()(h.handle)

	server := &ssh.Server{
		Addr:        cfg.ListenAddress,
		Handler:     handler,
		HostSigners: []ssh.Signer{hostKey},
		Version:     "Hrmny-SSH-Host",

		// The unauthenticated-work bounds (R13b). MaxTimeout is a backstop above
		// the session's own bound: a member experiences MaxSessionDuration, and
		// the transport bound only fires if the session layer somehow did not.
		HandshakeTimeout: cfg.HandshakeTimeout,
		MaxTimeout:       cfg.MaxSessionDuration + cfg.ConnectionGrace,

		// Deliberately nil. Set, they would make the fork REPLACE the verifier
		// callback; the boot assertion below refuses that state.
		PasswordHandler:            nil,
		PublicKeyHandler:           nil,
		KeyboardInteractiveHandler: nil,

		ServerConfigCallback: func(ssh.Context) *gossh.ServerConfig { return h.serverConfig() },
		ConnCallback:         h.connCallback,

		// Only the session channel type, plus explicit refusals for the
		// forwarding types. An empty map would leave the library's defaults in
		// place, which is exactly the kind of implied policy this unit avoids.
		ChannelHandlers: map[string]ssh.ChannelHandler{
			"session":         h.sessionChannelHandler,
			"direct-tcpip":    refuseForwardChannel,
			"forwarded-tcpip": refuseForwardChannel,
		},

		// No global request handlers except the explicit refusals, so
		// tcpip-forward is answered rather than silently dropped.
		RequestHandlers: map[string]ssh.RequestHandler{
			"tcpip-forward":        refusePortForwardRequest,
			"cancel-tcpip-forward": refusePortForwardRequest,
		},

		// No subsystems: sftp and friends are not offered.
		SubsystemHandlers: map[string]ssh.SubsystemHandler{},
	}

	// Real PTY allocation, so the child gets a PTY slave as its standard input
	// and output and the client's window size is honoured.
	if err := server.SetOption(ssh.AllocatePty()); err != nil {
		return nil, fmt.Errorf("session: allocate PTY option: %w", err)
	}

	// The boot assertion (R11's test scenario). Evaluated against the same
	// ServerConfig object the transport will build, so it cannot pass while the
	// live path differs.
	if err := auth.AssertVerifierWired(server, h.serverConfig()); err != nil {
		return nil, fmt.Errorf("session: %w", err)
	}

	h.server = server
	return h, nil
}

// Server is the assembled SSH server.
func (h *Host) Server() *ssh.Server { return h.server }

// Config is the host's effective configuration, defaults applied.
func (h *Host) Config() Config { return h.cfg }

// Limiter is the session limiter, exposed so a test can observe the caps.
func (h *Host) Limiter() *Limiter { return h.limiter }

// Supervisor is the pre-auth supervisor, exposed so a test can observe refusals.
func (h *Host) Supervisor() *ConnSupervisor { return h.supervisor }

// Serve runs the host on the given listener.
func (h *Host) Serve(listener net.Listener) error { return h.server.Serve(listener) }

// ListenAndServe runs the host on its configured address.
func (h *Host) ListenAndServe() error {
	return h.server.ListenAndServe()
}

// Close stops the host.
func (h *Host) Close() error { return h.server.Close() }

// serverConfig builds the transport's configuration.
//
// The verifier is assigned DIRECTLY to PublicKeyCallback. That is the seam the
// plan requires: going through the fork's PublicKeyHandler would run the
// returned permissions through a wrapper and would let the fork discard them,
// and the certificate's critical options would never reach the transport.
func (h *Host) serverConfig() *gossh.ServerConfig {
	return &gossh.ServerConfig{
		PublicKeyCallback: h.verifier.Authenticate,

		// Pinned to the CA's algorithm family rather than left to the defaults,
		// which would advertise algorithms this host cannot verify.
		PublicKeyAuthAlgorithms: h.verifier.PublicKeyAuthAlgorithms(),

		MaxAuthTries: h.cfg.MaxAuthTries,

		// The pre-auth admission decision is made in ConnCallback; this only
		// records successes so an authenticated connection stops counting
		// against the pre-auth cap.
		AuthLogCallback: func(conn gossh.ConnMetadata, method string, err error) {
			if err == nil {
				h.supervisor.authenticated(conn)
			}
		},
	}
}

// connCallback admits the connection and installs its activity clock.
func (h *Host) connCallback(ctx ssh.Context, conn net.Conn) net.Conn {
	state := &connState{activity: &ActivityTracker{}}
	state.activity.Touch()
	ctx.SetValue(connStateKey, state)

	supervised := h.supervisor.wrap(conn)
	if supervised == nil {
		h.cfg.Logger.Warn("refused a pre-authentication connection: at the configured cap",
			"cap", h.cfg.MaxPreAuthConnections)
		// A nil return makes the server close the connection before the
		// handshake, which is the hard refusal this cap needs.
		return nil
	}
	return &ActivityConn{Conn: supervised, tracker: state.activity}
}

// sessionChannelHandler installs the request policy and hands the channel to the
// library's session loop.
func (h *Host) sessionChannelHandler(srv *ssh.Server, conn *gossh.ServerConn, newChan gossh.NewChannel, ctx ssh.Context) {
	ssh.DefaultSessionHandler(srv, conn, &policyChannel{NewChannel: newChan, log: h.cfg.Logger}, ctx)
}

// ---------------------------------------------------------------------------
// The handoff
// ---------------------------------------------------------------------------

// handle is one session: verify identity, mint, spawn, supervise, and end with
// a reason.
func (h *Host) handle(sess ssh.Session) {
	started := time.Now()
	ctx := sess.Context()
	sessionID := ctx.SessionID()

	identity, err := auth.IdentityFromSession(sess)
	if err != nil {
		h.end(sess, EndReason{Code: ReasonIdentityMissing, Detail: err.Error()})
		return
	}

	logger := h.cfg.Logger.With(
		"session", sessionID,
		"principal", identity.Principal,
		"serial", identity.Serial,
	)
	logger.Info("session starting")

	// R11: no PTY, no session. The check is here rather than in a middleware so
	// the vocabulary a member reads is this host's (R19a).
	if _, _, active := sess.Pty(); !active {
		h.end(sess, EndReason{Code: ReasonNoPTY})
		return
	}

	// A command is an exec request. This host runs one client, which takes no
	// command, so the honest answer is a stated refusal rather than starting the
	// client and quietly discarding what the member asked for.
	if command := strings.TrimSpace(sess.RawCommand()); command != "" {
		h.end(sess, EndReason{Code: ReasonCommandNotSupported})
		return
	}

	release, reason, ok := h.limiter.Acquire(identity.Principal, sessionID)
	if !ok {
		h.end(sess, reason)
		return
	}
	defer release()

	// The startup mint. Fail closed: no first token means no client process at
	// all, so a member never gets a shell that cannot do anything.
	minted, err := h.minter.Mint(ctx, bridge.MintRequest{
		Serial:      identity.Serial,
		Principal:   identity.Principal,
		Fingerprint: identity.Fingerprint,
	})
	if err != nil {
		reason := reasonForMintFailure(err)
		logger.Warn("session could not be started: the bridge did not mint", "reason", reason.String())
		h.end(sess, reason)
		return
	}

	pipe, err := tokens.New()
	if err != nil {
		h.end(sess, EndReason{Code: ReasonClientStartFailed, Detail: sanitizeTerminalText(err.Error())})
		return
	}
	defer pipe.Close() //nolint:errcheck // best effort at teardown

	// The first token goes to the pipe BEFORE the child exists, so it is already
	// buffered when the client can first ask for it. This ordering is the
	// observable guarantee; see Observer and the tests.
	if err := pipe.Send(tokenFor(minted, identity, false)); err != nil {
		h.end(sess, EndReason{Code: ReasonClientStartFailed, Detail: sanitizeTerminalText(err.Error())})
		return
	}
	h.observe(func(o Observer) { o.FirstTokenWritten(sessionID, time.Now()) })

	pty, _, _ := sess.Pty()
	command := h.clientCommand(sess, pipe)

	// Job control puts the child in its own session with the PTY slave as its
	// controlling terminal, which is what lets a kill reach the whole process
	// tree and what makes interactive clients behave.
	if err := pty.Start(command, ssh.WithJobControl()); err != nil {
		h.end(sess, EndReason{Code: ReasonClientStartFailed, Detail: sanitizeTerminalText(err.Error())})
		return
	}
	// The child has its own copy of the read end now.
	if err := pipe.ReleaseChildEnd(); err != nil {
		logger.Warn("could not release the token descriptor's read end", "error", err)
	}
	h.observe(func(o Observer) { o.ChildSpawned(sessionID, time.Now()) })
	logger.Info("client process started", "pid", command.Process.Pid)

	reason = h.supervise(ctx, command, pipe, identity, minted, started)
	// The child is dead; let what it printed last reach the member before the
	// channel closes. A lost connection has nobody left to read it.
	if reason.Code != ReasonConnectionLost {
		drainClientOutput(pty, 500*time.Millisecond)
	}
	logger.Info("session ending", "reason", reason.String(), "elapsed", time.Since(started).Truncate(time.Millisecond).String())

	// The session-end channel. Written AFTER the child process exits (R19a), so
	// it never contends with the client's own drawing on the same PTY, and only
	// when the connection is still there to carry it. A host-decided ending has
	// already pushed its reason down the client's descriptor (see endAnnounced);
	// this block is the member's authoritative copy, and for the endings that
	// happen before a child exists it is the only one.
	h.end(sess, reason)
}

// supervise runs the session's bounds and the renewal loop until something ends
// the session, and guarantees the child is dead before it returns.
func (h *Host) supervise(
	ctx ssh.Context,
	command *exec.Cmd,
	pipe *tokens.Pipe,
	identity auth.Identity,
	minted bridge.Minted,
	started time.Time,
) EndReason {
	sessionID := ctx.SessionID()
	activity := ActivityFromContext(ctx)

	childDone := make(chan error, 1)
	go func() { childDone <- command.Wait() }()

	renew := time.NewTimer(h.renewLead(minted.ExpiresIn))
	defer renew.Stop()

	maxDuration := time.NewTimer(h.cfg.MaxSessionDuration - time.Since(started))
	defer maxDuration.Stop()

	idle := time.NewTicker(h.cfg.IdlePollInterval)
	defer idle.Stop()

	for {
		select {
		case <-ctx.Done():
			// The connection is gone; there is nothing to print on, so this is
			// the one reason that exists for the log alone.
			h.stop(command, childDone)
			return EndReason{Code: ReasonConnectionLost}

		case err := <-childDone:
			_ = pipe.CloseWrite()
			return clientExitReason(err)

		case <-maxDuration.C:
			return h.endAnnounced(pipe, command, childDone, EndReason{Code: ReasonMaxDuration})

		case <-idle.C:
			if activity == nil || h.cfg.IdleTimeout <= 0 {
				continue
			}
			if idleFor := activity.IdleFor(time.Now()); idleFor >= h.cfg.IdleTimeout {
				return h.endAnnounced(pipe, command, childDone, EndReason{Code: ReasonIdleTimeout})
			}

		case <-renew.C:
			next, reason, terminal := h.renewToken(ctx, pipe, identity, sessionID)
			if terminal {
				return h.endAnnounced(pipe, command, childDone, reason)
			}
			renew.Reset(next)
		}
	}
}

// renewToken mints and writes the next token, re-checking the certificate's
// remaining validity first, retrying a transport failure inside its window, and
// treating a bridge refusal as terminal.
//
// The credential epoch needs no separate check here, and that is worth stating
// because it looks like a missing one: the epoch lives on the server, is carried
// as a token claim, and is compared by the bridge against the epoch recorded at
// issuance. The renewal IS the epoch check — a moved epoch comes back as a
// `credential_epoch_moved` refusal, which ends the session at the next renewal
// and therefore within one access-token lifetime (R13a).
func (h *Host) renewToken(
	ctx ssh.Context,
	pipe *tokens.Pipe,
	identity auth.Identity,
	sessionID string,
) (time.Duration, EndReason, bool) {
	// A renewal for a connection that is already gone is wasted work and a
	// token nobody can use.
	if ctx.Err() != nil {
		return 0, EndReason{Code: ReasonConnectionLost}, true
	}

	// R13: a renewal must not extend a session past the certificate's own
	// window, so the certificate is re-checked before every mint.
	if !identity.ValidBefore.IsZero() && !h.now().Before(identity.ValidBefore) {
		return 0, EndReason{Code: ReasonCertificateExpired}, true
	}

	deadline := time.Now().Add(h.cfg.RenewalRetryWindow)

	for {
		minted, err := h.minter.Mint(ctx, bridge.MintRequest{
			Serial:      identity.Serial,
			Principal:   identity.Principal,
			Fingerprint: identity.Fingerprint,
		})

		switch {
		case err == nil:
			if sendErr := pipe.Send(tokenFor(minted, identity, true)); sendErr != nil {
				return 0, EndReason{
					Code:   ReasonTokenPathFailed,
					Detail: "the token descriptor is closed",
				}, true
			}
			h.observe(func(o Observer) { o.TokenRenewed(sessionID, time.Now()) })
			return h.renewLead(minted.ExpiresIn), EndReason{}, false

		case isRefusal(err):
			// Terminal. The bridge understood the assertion and declined it, so
			// retrying would fail the same way more slowly.
			return 0, reasonForMintFailure(err), true

		default:
			// A transport failure inside the renewal window is retried; one that
			// outlasts the window ends the session with a reason a member can act
			// on (R19a).
			if ctx.Err() != nil {
				return 0, EndReason{Code: ReasonConnectionLost}, true
			}
			if !time.Now().Before(deadline) {
				return 0, EndReason{
					Code:   ReasonTokenPathFailed,
					Detail: "the Hrmny server could not be reached",
				}, true
			}
			select {
			case <-ctx.Done():
				return 0, EndReason{Code: ReasonConnectionLost}, true
			case <-time.After(h.cfg.RenewalRetryInterval):
			}
		}
	}
}

// stop kills the child and everything it started, and waits for the reaping.
func (h *Host) stop(command *exec.Cmd, done <-chan error) {
	if command.Process == nil {
		return
	}
	// Job control put the child in its own process group, so a negative pid
	// reaches the whole tree — a shell's children die with it. The plain Kill
	// covers the case where the group signal did not apply.
	_ = syscall.Kill(-command.Process.Pid, syscall.SIGKILL)
	_ = command.Process.Kill()

	select {
	case <-done:
	case <-time.After(h.cfg.KillGrace):
		h.cfg.Logger.Warn("client process did not exit after a kill", "pid", command.Process.Pid)
	}
}

// end writes the reason to the SSH channel and ends the session.
func (h *Host) end(sess ssh.Session, reason EndReason) {
	if rendering := reason.Rendering(h.cfg.Origin); rendering != "" {
		// Only when the connection can still carry it. A lost connection has
		// nobody left to tell.
		if sess.Context().Err() == nil {
			if _, err := io.WriteString(sess, rendering); err != nil {
				h.cfg.Logger.Debug("could not write the session-end reason", "error", err)
			}
		}
	}
	h.observe(func(o Observer) { o.SessionEnded(sess.Context().SessionID(), reason, time.Now()) })
	if err := sess.Exit(reason.ExitCode()); err != nil {
		h.cfg.Logger.Debug("could not set the session exit status", "error", err)
	}
}

// clientCommand builds the child command: the host's argv, the host's
// environment, the host's working directory, and the token descriptor.
func (h *Host) clientCommand(sess ssh.Session, pipe *tokens.Pipe) *exec.Cmd {
	argv := append([]string(nil), h.cfg.ClientCommand...)
	argv = append(argv, h.cfg.ClientArgs...)

	command := exec.Command(argv[0], argv[1:]...) //nolint:gosec // host-configured argv
	pty, _, _ := sess.Pty()
	command.Env = ChildEnv(h.cfg, pty.Term, pipe.ChildFD())
	command.Dir = h.cfg.ClientDir
	command.ExtraFiles = []*os.File{pipe.ChildFile()}
	return command
}

// tokenFor converts a mint into the descriptor's spelling.
func tokenFor(minted bridge.Minted, identity auth.Identity, renewal bool) tokens.Token {
	return tokens.Token{
		AccessToken: minted.AccessToken,
		TokenType:   minted.TokenType,
		ExpiresIn:   minted.ExpiresIn,
		Username:    minted.Username,
		Serial:      identity.Serial,
		IssuedAt:    time.Now().UTC(),
		Renewal:     renewal,
	}
}

// now is the clock the renewal's certificate check reads.
func (h *Host) now() time.Time {
	if h.cfg.Now != nil {
		return h.cfg.Now()
	}
	return time.Now()
}

// renewLead is how long after a mint the next renewal is attempted.
func (h *Host) renewLead(expiresIn int) time.Duration {
	lifetime := time.Duration(expiresIn) * time.Second
	if lifetime <= 0 {
		lifetime = time.Duration(DefaultRenewalRetryWindow)
	}

	lead := h.cfg.RenewBefore
	if lead <= 0 {
		lead = lifetime / 3
	}
	if lead >= lifetime {
		// A lead as long as the lifetime would renew immediately and forever.
		lead = lifetime / 2
	}
	if lead <= 0 {
		lead = time.Second
	}
	return lifetime - lead
}

// clientExitReason maps the child's exit to a reason.
func clientExitReason(err error) EndReason {
	if err == nil {
		return EndReason{Code: ReasonClientExited}
	}
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		if exit.ExitCode() == 0 {
			return EndReason{Code: ReasonClientExited}
		}
		return EndReason{
			Code:   ReasonClientFailed,
			Detail: fmt.Sprintf("exit status %d", exit.ExitCode()),
		}
	}
	return EndReason{Code: ReasonClientFailed, Detail: sanitizeTerminalText(err.Error())}
}

// reasonForMintFailure maps a bridge error to the member-facing reason.
func reasonForMintFailure(err error) EndReason {
	if err == nil {
		return EndReason{}
	}
	if refusal, ok := bridge.IsRefusal(err); ok {
		reason := EndReason{
			Code:         ReasonBridgeRefused,
			BridgeReason: refusal.Reason,
			Detail:       refusal.Message,
		}
		// Two refusals have a specific meaning for the session, and naming it
		// makes the reason say what happened rather than only who refused.
		switch refusal.Reason {
		case bridge.ReasonCertificateExpired:
			reason.Code = ReasonCertificateExpired
		case bridge.ReasonCredentialEpochMoved:
			reason.Code = ReasonCredentialEpochMoved
		}
		return reason
	}
	return EndReason{Code: ReasonBridgeUnreachable}
}

// isRefusal reports whether a mint error is a bridge refusal rather than a
// transport failure.
func isRefusal(err error) bool {
	_, ok := bridge.IsRefusal(err)
	return ok
}

func (h *Host) observe(fn func(Observer)) {
	if h.cfg.Observer == nil {
		return
	}
	fn(h.cfg.Observer)
}
