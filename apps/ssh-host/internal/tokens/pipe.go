// Package tokens carries the access tokens the SSH host mints for a session to
// the client process that uses them (R7, R9, R27, KTD8).
//
// # Why a descriptor and not a file, an environment value, or argv
//
// The access token lives 15 minutes, so a long session needs renewals without a
// refresh token. The bridge issues access tokens only (R9). The host therefore
// mints a fresh token proactively and writes it to a pipe it hands the client
// at spawn; the client's descriptor reader pushes each token into the live
// request path (U11's seam). The same descriptor is the *only* channel a token
// travels on, which is what keeps it out of argv, out of the environment, and
// out of every member-readable file (R12a, R27).
//
// # The framing, stated
//
// One JSON object per line, newline-terminated (NDJSON). The plan defers the
// framing to implementation ("The framing on the token descriptor ... is
// deferred to implementation") and this is the choice: it is
// self-describing, it is trivially incremental on both sides (the client reads
// one line at a time and never needs a length prefix it could mis-parse), and
// a truncated final line is discardable rather than corrupting the stream.
//
// Field names mirror the bridge's own response body exactly (see
// CytaleWeb.SessionBridgeController), with three host-added fields the client
// uses to reason about freshness rather than trusting its own clock:
//
//	{"access_token":"…","token_type":"Bearer","expires_in":900,
//	 "username":"…","serial":1234,"issued_at":"2026-09-13T12:00:00Z"}
//
// There is no refresh-token field and there never will be (R9).
//
// # The second frame kind: the session end, and why it is on this descriptor
//
// A token frame alone cannot say why a session stopped. A client that reads only
// tokens learns of a host-initiated ending as a bare end-of-stream, and has to
// guess a cause — which is exactly what R19a forbids, because the member is then
// told "the token path failed" for an idle timeout or a certificate expiry. So
// the descriptor carries a second frame:
//
//	{"end":"max_session_duration"}
//
// The reason string is the session package's ReasonCode, spelled exactly as that
// package names it, so one name means one thing on both sides of the wire. The
// host writes this frame BEFORE it closes the write end, because a frame written
// after the close has nothing left to carry it (see Pipe.SendEnd).
//
// # Ordering
//
// The host writes the first token BEFORE it starts the child process, so the
// first token is already buffered in the pipe by the time the client can issue
// its first request. That ordering is asserted in the host's tests and is the
// reason Pipe.Send is safe to call before the child exists: a pipe holds its
// buffer until a reader drains it.
//
// At the other end, the order is: the end frame, then the close. The session
// package sends the frame and closes the write end while the child still holds
// the read end, so the client's reader drains the reason and reaches
// end-of-stream in the same pass, instead of waiting for a renewal that will
// never arrive.
package tokens

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"
)

// DefaultFD is the descriptor number the client reads tokens from.
//
// os/exec places ExtraFiles[0] at fd 3 in the child (the standard streams take
// 0, 1 and 2), and the host passes this number to the child in its environment
// so the client never has to guess.
const DefaultFD = 3

// Token is one minted access token as it travels over the descriptor.
type Token struct {
	// AccessToken is the Cytale access token. Never log this value.
	AccessToken string `json:"access_token"`

	// TokenType mirrors the bridge's response; always "Bearer".
	TokenType string `json:"token_type"`

	// ExpiresIn is the token's lifetime in seconds, as the bridge stated it.
	ExpiresIn int `json:"expires_in"`

	// Username is the principal the bridge resolved the mint to, handed back so
	// the client starts knowing who it is.
	Username string `json:"username,omitempty"`

	// Serial is the certificate serial this token was minted against. It is
	// stable across a session's renewals; the nonce is what changes per mint.
	Serial uint64 `json:"serial"`

	// IssuedAt is the host's clock at the moment the mint returned. The plan's
	// renewal loop re-checks freshness in process; the client gets this only so
	// a stale buffer is recognisable rather than a surprise.
	IssuedAt time.Time `json:"issued_at"`

	// Renewal is set on every token after the first. The client treats a
	// renewal as a replacement for the live token, not as a second identity.
	Renewal bool `json:"renewal,omitempty"`
}

// String redacts the token body. Token implements no fmt.Formatter, so any
// accidental %v of a Token prints no secret.
func (t Token) String() string {
	return fmt.Sprintf("tokens.Token{user=%q serial=%d expires_in=%d renewal=%t access_token=[redacted]}",
		t.Username, t.Serial, t.ExpiresIn, t.Renewal)
}

// ErrClosed is returned by Send or SendEnd after the pipe is closed.
var ErrClosed = errors.New("tokens: pipe is closed")

// End is the session-end frame: the host is ending the session, and this names
// why.
//
// It exists so the client never has to infer a cause from a bare end-of-stream.
// When the host stops a session it decided to stop, it writes this frame while
// the client is still running and before the write end is closed (R19a).
type End struct {
	// Reason is the host's session-end code, spelled exactly as the session
	// package names it. It is deliberately not re-mapped here: this package is
	// the writer, the session package owns the vocabulary.
	Reason string `json:"end"`
}

// Pipe is the write end of a one-way descriptor handed to a client process.
//
// The zero value is not usable; call New. A Pipe is safe for concurrent use.
type Pipe struct {
	mu sync.Mutex

	// read is this process's copy of the read end. It exists only so the child
	// can inherit a descriptor of the right number; the host never reads from
	// it, and ReleaseChildEnd closes it once the child has its own copy.
	read *os.File

	write  *os.File
	closed bool
}

// New creates the token pipe.
//
// The read end is the descriptor the child inherits; it is deliberately never
// returned to the caller, so no code path in the host can read a token back out
// of the pipe it wrote.
func New() (*Pipe, error) {
	r, w, err := os.Pipe()
	if err != nil {
		return nil, fmt.Errorf("tokens: create pipe: %w", err)
	}
	return &Pipe{read: r, write: w}, nil
}

// ChildFile is the read end, to be placed in the child command's ExtraFiles.
func (p *Pipe) ChildFile() *os.File {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.read
}

// ChildFD is the descriptor number the child sees the read end at.
func (p *Pipe) ChildFD() int { return DefaultFD }

// ReleaseChildEnd closes this process's copy of the read end.
//
// Called after the child is started. Until then the child's inherited
// descriptor does not exist, so closing early would leave the child without a
// token source; leaving it open afterwards would be one more readable
// descriptor in the host than the design requires.
func (p *Pipe) ReleaseChildEnd() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.read == nil {
		return nil
	}
	err := p.read.Close()
	p.read = nil
	if err != nil {
		return fmt.Errorf("tokens: release child end: %w", err)
	}
	return nil
}

// Send writes one token as a single NDJSON line.
//
// A single Write of one complete line is what keeps two concurrent renewals
// from interleaving mid-object: the mutex serialises callers, and os.File.Write
// on a pipe is a single write(2) when the buffer is under PIPE_BUF, which a
// token line always is.
func (p *Pipe) Send(t Token) error {
	return p.writeLine(t, "token")
}

// SendEnd writes the session-end frame as a single NDJSON line.
//
// Call it BEFORE CloseWrite: the frame travels on the write end this method
// writes to, so a frame sent after the close is a frame nobody can read, and the
// client is left with the bare end-of-stream this frame exists to replace. It is
// also what makes the frame reachable at all — the child must still hold the
// read end when the host writes, which is why the session package sends this
// before it stops the child rather than after.
//
// An empty reason is refused rather than sent: an end frame that names nothing
// is worse than no frame, because the client would render a blank cause.
func (p *Pipe) SendEnd(reason string) error {
	if strings.TrimSpace(reason) == "" {
		return errors.New("tokens: an end frame must name a reason")
	}
	return p.writeLine(End{Reason: reason}, "end frame")
}

// writeLine frames one frame as a single newline-terminated JSON line.
//
// Both frame kinds go through here so there is exactly one framing discipline on
// this descriptor: one Marshal, one append of the terminator, one Write under
// the mutex. A second framing path would be a second place to get the newline,
// the buffering, or the close check wrong.
func (p *Pipe) writeLine(frame any, what string) error {
	line, err := json.Marshal(frame)
	if err != nil {
		return fmt.Errorf("tokens: marshal %s: %w", what, err)
	}
	line = append(line, '\n')

	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed || p.write == nil {
		return ErrClosed
	}
	if _, err := p.write.Write(line); err != nil {
		return fmt.Errorf("tokens: write %s: %w", what, err)
	}
	return nil
}

// CloseWrite closes the write end, which the client reads as end-of-stream: no
// further token is coming, so a renewal can no longer succeed.
//
// When the host is the one ending the session, SendEnd has already written the
// reason by the time this is called: end-of-stream says "nothing more", the end
// frame says "and here is why", and the client needs both.
func (p *Pipe) CloseWrite() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.closed = true
	if p.write == nil {
		return nil
	}
	err := p.write.Close()
	p.write = nil
	if err != nil {
		return fmt.Errorf("tokens: close write end: %w", err)
	}
	return nil
}

// Close closes both ends: the write end (end-of-stream for the client) and this
// process's copy of the read end.
func (p *Pipe) Close() error {
	var errs []error
	if err := p.CloseWrite(); err != nil {
		errs = append(errs, err)
	}
	if err := p.ReleaseChildEnd(); err != nil {
		errs = append(errs, err)
	}
	return errors.Join(errs...)
}
