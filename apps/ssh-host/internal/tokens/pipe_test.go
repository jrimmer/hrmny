package tokens_test

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/jrimmer/hrmny/apps/ssh-host/internal/tokens"
)

func sample(renewal bool) tokens.Token {
	return tokens.Token{
		AccessToken: "tok-" + strings.Repeat("x", 16),
		TokenType:   "Bearer",
		ExpiresIn:   900,
		Username:    "jordan",
		Serial:      4242,
		IssuedAt:    time.Unix(1757800000, 0).UTC(),
		Renewal:     renewal,
	}
}

// TestSendRoundTripsOneJSONLine pins the framing: one complete JSON object per
// line, so a client can read the descriptor one line at a time.
func TestSendRoundTripsOneJSONLine(t *testing.T) {
	p, err := tokens.New()
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer p.Close()

	sent := sample(false)
	if err := p.Send(sent); err != nil {
		t.Fatalf("Send: %v", err)
	}

	// Read the raw bytes so the framing itself is asserted, not just the
	// decoded value: extra whitespace, a missing newline, or two objects on one
	// line would all still decode.
	buf := make([]byte, 4096)
	n, err := p.ChildFile().Read(buf)
	if err != nil {
		t.Fatalf("read child end: %v", err)
	}
	line := string(buf[:n])
	if !strings.HasSuffix(line, "\n") {
		t.Fatalf("token line is not newline-terminated: %q", line)
	}
	if strings.Count(line, "\n") != 1 {
		t.Fatalf("Send wrote %d lines, want exactly 1: %q", strings.Count(line, "\n"), line)
	}

	var decoded tokens.Token
	if err := json.Unmarshal([]byte(strings.TrimSuffix(line, "\n")), &decoded); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if decoded.AccessToken != sent.AccessToken {
		t.Errorf("access_token = %q, want %q", decoded.AccessToken, sent.AccessToken)
	}
	if decoded.ExpiresIn != 900 {
		t.Errorf("expires_in = %d, want 900", decoded.ExpiresIn)
	}
	if !decoded.IssuedAt.Equal(sent.IssuedAt) {
		t.Errorf("issued_at = %v, want %v", decoded.IssuedAt, sent.IssuedAt)
	}
	// expires_in is a lifetime, not a deadline: a client computes the deadline
	// from issued_at and its own clock, which is why both fields travel.
	if deadline := decoded.IssuedAt.Add(time.Duration(decoded.ExpiresIn) * time.Second); !deadline.Equal(sent.IssuedAt.Add(900 * time.Second)) {
		t.Errorf("the token's deadline = %v, want %v", deadline, sent.IssuedAt.Add(900*time.Second))
	}
}

// TestRenewalIsASecondLine is the renewal shape: a fresh token arrives on the
// same descriptor, framed the same way, distinguished by the renewal flag.
func TestRenewalIsASecondLine(t *testing.T) {
	p, err := tokens.New()
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer p.Close()

	first := sample(false)
	second := sample(true)
	second.AccessToken = "tok-renewed"

	if err := p.Send(first); err != nil {
		t.Fatalf("Send first: %v", err)
	}
	if err := p.Send(second); err != nil {
		t.Fatalf("Send second: %v", err)
	}

	// ONE reader across both tokens: a second bufio.Reader over the same
	// descriptor would sit behind the bytes the first one has already buffered.
	reader := bufio.NewReader(p.ChildFile())
	got1 := readToken(t, reader)
	got2 := readToken(t, reader)
	if got1.Renewal {
		t.Error("first token was flagged as a renewal")
	}
	if !got2.Renewal {
		t.Error("second token was not flagged as a renewal")
	}
	if got1.Serial != got2.Serial {
		t.Errorf("serial changed across a renewal: %d -> %d; the serial is the session's, the nonce is what is fresh per mint",
			got1.Serial, got2.Serial)
	}
	if got2.AccessToken != "tok-renewed" {
		t.Errorf("second token = %q, want the renewed value", got2.AccessToken)
	}
}

// TestEndOfStreamIsTheEndOfTheSession is the descriptor's end-of-session signal:
// once the write end closes, the client's read reaches EOF rather than blocking,
// so a client waiting for a renewal learns the session is over.
func TestEndOfStreamIsTheEndOfTheSession(t *testing.T) {
	p, err := tokens.New()
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if err := p.CloseWrite(); err != nil {
		t.Fatalf("CloseWrite: %v", err)
	}

	reader := bufio.NewReader(p.ChildFile())
	if _, err := reader.ReadString('\n'); !errors.Is(err, io.EOF) {
		t.Fatalf("read after CloseWrite err = %v, want io.EOF", err)
	}
}

// TestSendEndRoundTripsOneEndFrame pins the end frame's framing the same way
// TestSendRoundTripsOneJSONLine pins the token's: the exact bytes on the wire,
// one newline-terminated JSON object, with the reason as the value of "end".
//
// The reason is asserted on the wire, not merely "a write happened", because the
// string on the wire is the whole contract with the client: a frame that named a
// near-synonym would end the session and name the wrong cause.
func TestSendEndRoundTripsOneEndFrame(t *testing.T) {
	p, err := tokens.New()
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer p.Close()

	if err := p.SendEnd("max_session_duration"); err != nil {
		t.Fatalf("SendEnd: %v", err)
	}

	buf := make([]byte, 4096)
	n, err := p.ChildFile().Read(buf)
	if err != nil {
		t.Fatalf("read child end: %v", err)
	}
	line := string(buf[:n])

	const want = "{\"end\":\"max_session_duration\"}\n"
	if line != want {
		t.Fatalf("the end frame on the wire = %q, want %q", line, want)
	}
	if strings.Count(line, "\n") != 1 {
		t.Fatalf("SendEnd wrote %d lines, want exactly 1: %q", strings.Count(line, "\n"), line)
	}

	var decoded tokens.End
	if err := json.Unmarshal([]byte(strings.TrimSuffix(line, "\n")), &decoded); err != nil {
		t.Fatalf("decode end frame: %v", err)
	}
	if decoded.Reason != "max_session_duration" {
		t.Errorf("decoded reason = %q, want the reason verbatim", decoded.Reason)
	}

	// An end frame is not a token: a client that looks for access_token must not
	// find one here, or a session end would be adopted as a credential.
	var asToken struct {
		AccessToken string `json:"access_token"`
	}
	if err := json.Unmarshal([]byte(strings.TrimSuffix(line, "\n")), &asToken); err != nil {
		t.Fatalf("an end frame is not valid JSON: %v", err)
	}
	if asToken.AccessToken != "" {
		t.Errorf("the end frame carried an access_token (%q); the frame kinds must not be confusable", asToken.AccessToken)
	}
}

// TestEndFrameFollowsTheLastTokenOnTheSameDescriptor is the ordering the client
// reads: tokens first, then the ending, in one line-oriented stream. A reader
// that gets both, in that order, needs no second channel — which is the reason
// the reason rides this descriptor at all (KTD8).
func TestEndFrameFollowsTheLastTokenOnTheSameDescriptor(t *testing.T) {
	p, err := tokens.New()
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer p.Close()

	if err := p.Send(sample(true)); err != nil {
		t.Fatalf("Send: %v", err)
	}
	if err := p.SendEnd("idle_timeout"); err != nil {
		t.Fatalf("SendEnd: %v", err)
	}

	// ONE reader across both frames: a second bufio.Reader over the same
	// descriptor would sit behind the bytes the first one has already buffered.
	reader := bufio.NewReader(p.ChildFile())
	renewal := readToken(t, reader)
	if !renewal.Renewal || renewal.AccessToken == "" {
		t.Fatalf("the token frame did not round-trip: %+v", renewal)
	}

	line, err := reader.ReadString('\n')
	if err != nil {
		t.Fatalf("read the end frame: %v", err)
	}
	var end tokens.End
	if err := json.Unmarshal([]byte(strings.TrimSpace(line)), &end); err != nil {
		t.Fatalf("decode the end frame: %v", err)
	}
	if end.Reason != "idle_timeout" {
		t.Fatalf("the end frame's reason = %q, want idle_timeout", end.Reason)
	}

	// And the stream ends after it: the frame is the last thing on the wire.
	if err := p.CloseWrite(); err != nil {
		t.Fatalf("CloseWrite: %v", err)
	}
	if _, err := reader.ReadString('\n'); !errors.Is(err, io.EOF) {
		t.Fatalf("read after the end frame err = %v, want io.EOF", err)
	}
}

// TestSendEndAfterCloseFails is the ordering guard on this side: a frame written
// after CloseWrite cannot reach the client, so it must not look like it did.
func TestSendEndAfterCloseFails(t *testing.T) {
	p, err := tokens.New()
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer p.Close()

	if err := p.CloseWrite(); err != nil {
		t.Fatalf("CloseWrite: %v", err)
	}
	if err := p.SendEnd("certificate_expired"); !errors.Is(err, tokens.ErrClosed) {
		t.Fatalf("SendEnd after CloseWrite err = %v, want tokens.ErrClosed", err)
	}
}

// TestSendEndRequiresAReason keeps a blank frame off the wire: the client would
// have nothing to render, which is worse than the bare end-of-stream the frame
// exists to replace.
func TestSendEndRequiresAReason(t *testing.T) {
	p, err := tokens.New()
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer p.Close()

	for _, reason := range []string{"", "   ", "\n"} {
		if err := p.SendEnd(reason); err == nil {
			t.Fatalf("SendEnd(%q) was accepted", reason)
		}
	}

	// Nothing was written, and the descriptor still carries frames.
	if err := p.Send(sample(false)); err != nil {
		t.Fatalf("Send after a refused end frame: %v", err)
	}
	line, err := bufio.NewReader(p.ChildFile()).ReadString('\n')
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if !strings.Contains(line, "access_token") {
		t.Fatalf("the first line on the descriptor = %q, want the token", line)
	}
}

// TestMalformedTokenLineIsRejected proves a line with no access_token is not
// silently accepted as an empty token a client would have to defend against.
func TestMalformedTokenLineIsRejected(t *testing.T) {
	if _, err := decodeTokenLine([]byte(`{"token_type":"Bearer","expires_in":900}`)); err == nil {
		t.Fatal("a token line with no access_token was accepted")
	}
	if _, err := decodeTokenLine([]byte("not json at all")); err == nil {
		t.Fatal("a non-JSON line was accepted")
	}
}

// readToken reads one token off the descriptor, which is exactly what the client
// does.
func readToken(t *testing.T, reader *bufio.Reader) tokens.Token {
	t.Helper()
	line, err := reader.ReadString('\n')
	if err != nil {
		t.Fatalf("read token line: %v", err)
	}
	body, err := decodeTokenLine([]byte(line))
	if err != nil {
		t.Fatalf("decode token line: %v", err)
	}
	var token tokens.Token
	if err := json.Unmarshal(body, &token); err != nil {
		t.Fatalf("unmarshal token: %v", err)
	}
	return token
}

// decodeTokenLine is the client's decoding step, spelled out so the framing
// assertion does not rely on the package under test to decode itself.
func decodeTokenLine(line []byte) ([]byte, error) {
	var envelope struct {
		AccessToken string `json:"access_token"`
	}
	if err := json.Unmarshal(bytes.TrimSpace(line), &envelope); err != nil {
		return nil, err
	}
	if envelope.AccessToken == "" {
		return nil, errors.New("token line carried no access_token")
	}
	return bytes.TrimSpace(line), nil
}

// TestSendAfterCloseFails keeps a renewal that races session teardown from
// silently looking successful.
func TestSendAfterCloseFails(t *testing.T) {
	p, err := tokens.New()
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if err := p.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if err := p.Send(sample(false)); !errors.Is(err, tokens.ErrClosed) {
		t.Fatalf("Send after Close err = %v, want tokens.ErrClosed", err)
	}
}

// TestChildInheritsTheReadEndAtFD3 is the descriptor contract the client is
// written against: the token arrives at fd 3 in the child, and the child reads
// it as its first action.
//
// The helper is this test binary re-executed, so no external tool is required
// and the assertion holds on every platform the host builds for.
func TestChildInheritsTheReadEndAtFD3(t *testing.T) {
	if os.Getenv("CYTALE_TEST_TOKEN_READER") == "1" {
		readAndPrintFD3ForTest()
		return
	}

	p, err := tokens.New()
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer p.Close()

	want := sample(false)
	if err := p.Send(want); err != nil {
		t.Fatalf("Send: %v", err)
	}

	cmd := exec.Command(os.Args[0], "-test.run=^TestChildInheritsTheReadEndAtFD3$")
	cmd.Env = []string{"CYTALE_TEST_TOKEN_READER=1", "CYTALE_TEST_TOKEN_FD=3"}
	cmd.ExtraFiles = []*os.File{p.ChildFile()}

	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("child: %v (output %q)", err, out)
	}
	if err := p.ReleaseChildEnd(); err != nil {
		t.Fatalf("ReleaseChildEnd: %v", err)
	}

	var got tokens.Token
	if err := json.Unmarshal(out, &got); err != nil {
		t.Fatalf("child printed %q, want a token object: %v", out, err)
	}
	if got.AccessToken != want.AccessToken {
		t.Errorf("child read %q, want %q", got.AccessToken, want.AccessToken)
	}
}

// TestChildFDAndDefaultFDMatch states the number the host and the client agree
// on in one place.
func TestChildFDAndDefaultFDMatch(t *testing.T) {
	p, err := tokens.New()
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer p.Close()
	if p.ChildFD() != 3 || tokens.DefaultFD != 3 {
		t.Fatalf("token fd = %d / DefaultFD = %d, want 3 and 3", p.ChildFD(), tokens.DefaultFD)
	}
}

// TestTokenStringRedacts is the logging guard: a Token formatted with %v must
// not print its access token.
func TestTokenStringRedacts(t *testing.T) {
	tok := sample(false)
	tok.AccessToken = "super-secret-token-value"
	rendered := tok.String()
	if strings.Contains(rendered, "super-secret-token-value") {
		t.Fatalf("Token.String leaked the access token: %q", rendered)
	}
}

// readLineAndEcho reads one line off the descriptor and returns it, which is all
// the child side of these tests needs to do.
func readLineAndEcho(file *os.File) ([]byte, error) {
	line, err := bufio.NewReader(file).ReadString('\n')
	if err != nil {
		return nil, err
	}
	if _, err := decodeTokenLine([]byte(line)); err != nil {
		return nil, err
	}
	return []byte(strings.TrimSpace(line)), nil
}

// readAndPrintFD3ForTest is the child side of TestChildInheritsTheReadEndAtFD3.
func readAndPrintFD3ForTest() {
	fd := 3
	if v := os.Getenv("CYTALE_TEST_TOKEN_FD"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil {
			os.Stderr.WriteString("bad fd: " + err.Error())
			os.Exit(2)
		}
		fd = n
	}
	f := os.NewFile(uintptr(fd), "token")
	if f == nil {
		os.Stderr.WriteString("no token descriptor")
		os.Exit(3)
	}
	body, err := readLineAndEcho(f)
	if err != nil {
		os.Stderr.WriteString("read token: " + err.Error())
		os.Exit(4)
	}
	if err != nil {
		os.Stderr.WriteString("marshal: " + err.Error())
		os.Exit(5)
	}
	os.Stdout.Write(body)
	// Exit before the test framework prints its own summary line, so stdout
	// carries the token object and nothing else.
	os.Exit(0)
}
