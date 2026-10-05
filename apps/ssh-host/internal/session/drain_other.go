//go:build !unix

package session

import (
	"time"

	"charm.land/ssh"
)

// drainClientOutput is a no-op where the PTY is not a unix master/slave pair.
func drainClientOutput(ssh.Pty, time.Duration) {}
