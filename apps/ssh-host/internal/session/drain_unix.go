//go:build unix

package session

import (
	"time"

	"charm.land/ssh"
	"golang.org/x/sys/unix"
)

// drainClientOutput waits for the client's last output to leave the PTY
// before the session closes.
//
// The ssh library copies the PTY master to the channel on its own goroutine,
// and closing the channel (sess.Exit) does not wait for that copy. A client
// that prints and exits at once, such as a TUI restoring the terminal on the
// way out, could have those final bytes still sitting in the master when the
// channel closed, and the member never received them. The e2e fixture's
// "BYE" line was lost this way in 3 of 300 runs on a test VM.
//
// The master's pending-input count (TIOCINQ) reaches zero once the copier has
// read everything. It has to stay zero for a few polls in a row: the kernel
// moves the slave's writes to the master on a work queue, so one zero reading
// straight after the child exits proves little, and the copier still needs a
// moment to hand the bytes it read to the channel. The drain is bounded, so a
// wedged copier costs at most `limit`, never the session.
func drainClientOutput(pty ssh.Pty, limit time.Duration) {
	if pty.Master == nil {
		return
	}
	conn, err := pty.Master.SyscallConn()
	if err != nil {
		return
	}

	const (
		poll        = 5 * time.Millisecond
		quietNeeded = 4 // consecutive empty polls, about 20ms
	)
	deadline := time.Now().Add(limit)
	quiet := 0
	for quiet < quietNeeded && time.Now().Before(deadline) {
		pending := 0
		var ioctlErr error
		if err := conn.Control(func(fd uintptr) {
			pending, ioctlErr = unix.IoctlGetInt(int(fd), unix.TIOCINQ)
		}); err != nil || ioctlErr != nil {
			return
		}
		if pending == 0 {
			quiet++
		} else {
			quiet = 0
		}
		time.Sleep(poll)
	}
}
