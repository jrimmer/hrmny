module github.com/jrimmer/hrmny/apps/ssh-host

go 1.27

// Go 1.27.2 fixes eight standard-library advisories this host reaches
// (crypto/tls, net/http, http2: GO-2026-6603, -6605, -6607 among them).
// The go-base runner image still carries 1.27.1, so the toolchain line makes
// `go` fetch 1.27.2 there; Dockerfile.ssh-host builds on the same version.
toolchain go1.27.2

require (
	charm.land/ssh v0.4.3
	charm.land/wish/v2 v2.0.4
	golang.org/x/crypto v0.57.0
	golang.org/x/sys v0.48.0
)

require (
	charm.land/bubbletea/v2 v2.0.9 // indirect
	charm.land/lipgloss/v2 v2.0.6 // indirect
	charm.land/log/v2 v2.0.1 // indirect
	github.com/anmitsu/go-shlex v0.0.0-20200514113438-38f4b401e2be // indirect
	github.com/charmbracelet/colorprofile v0.4.3 // indirect
	github.com/charmbracelet/keygen v0.5.4 // indirect
	github.com/charmbracelet/ultraviolet v0.0.0-20260906173415-0277a179edd9 // indirect
	github.com/charmbracelet/x/ansi v0.11.8 // indirect
	github.com/charmbracelet/x/conpty v0.2.0 // indirect
	github.com/charmbracelet/x/term v0.2.2 // indirect
	github.com/charmbracelet/x/termios v0.1.1 // indirect
	github.com/charmbracelet/x/windows v0.2.2 // indirect
	github.com/charmbracelet/x/xpty v0.1.4 // indirect
	github.com/clipperhouse/displaywidth v0.11.0 // indirect
	github.com/clipperhouse/uax29/v2 v2.7.0 // indirect
	github.com/creack/pty v1.1.24 // indirect
	github.com/go-logfmt/logfmt v0.6.1 // indirect
	github.com/lucasb-eyer/go-colorful v1.4.1 // indirect
	github.com/mattn/go-runewidth v0.0.30 // indirect
	github.com/muesli/cancelreader v0.2.2 // indirect
	github.com/pires/go-proxyproto v0.15.0 // indirect
	github.com/rivo/uniseg v0.4.7 // indirect
	github.com/xo/terminfo v1.0.0 // indirect
	golang.org/x/exp v0.0.0-20260908205506-85c1c2202aba // indirect
	golang.org/x/sync v0.23.0 // indirect
)
