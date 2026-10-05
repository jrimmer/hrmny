// Command cytale-ssh-host is the Cytale SSH host: the process that terminates
// SSH, verifies a member's certificate, and hands the connection to the terminal
// client as a client process with a live token path.
//
// It is the product's authentication boundary, so this file is deliberately thin
// and every piece of behaviour lives in a package that can be tested without a
// terminal: `internal/auth` verifies certificates, `internal/bridge` mints
// tokens, `internal/tokens` carries them, and `internal/session` owns the
// session. What is left here is configuration, secret custody, and the ordering
// of boot.
//
// # Secrets
//
// Two things this process reads are secret: the bridge credential and the host
// private key. Both are read ONCE at boot and then unlinked (R12a), so a client
// process running under the same uid as this one cannot open them. The CA public
// key is not secret and stays on disk.
//
// Nothing secret arrives in the environment: the credential and the host key are
// PATHS. An environment value would stay readable to a same-uid child through
// this process's /proc, and read-once-and-unlink cannot apply to a value.
//
// # The host's environment
//
// Every variable is prefixed CYTALE_SSH_HOST_. The required set fails the boot
// loudly and names the variable rather than dying at the first connection:
//
//	CYTALE_SSH_HOST_CA_PUBLIC_KEY          path — the CA public key(s), one or
//	                                       more lines in authorized_keys form
//	CYTALE_SSH_HOST_KEY                    path — the host private key
//	CYTALE_SSH_HOST_BRIDGE_URL             the bridge listener's base URL
//	CYTALE_SSH_HOST_BRIDGE_CREDENTIAL      path — the bridge credential
//	CYTALE_SSH_HOST_CLIENT_COMMAND         absolute path — the terminal client
//	CYTALE_SSH_HOST_ORIGIN                 the Cytale server the client reaches
//
// The optional set, with the defaults stated in internal/session:
//
//	CYTALE_SSH_HOST_ADDR                            (":2222")
//	CYTALE_SSH_HOST_CLIENT_ARGS                     host-configured arguments
//	CYTALE_SSH_HOST_CLIENT_DIR                      (the client's directory)
//	CYTALE_SSH_HOST_CLIENT_PATH                     ("/usr/local/bin:/usr/bin:/bin")
//	CYTALE_SSH_HOST_RETAIN_SECRETS                  (false; the distinct-uid posture)
//	CYTALE_SSH_HOST_MAX_SESSION_DURATION            (12h)
//	CYTALE_SSH_HOST_IDLE_TIMEOUT                    (30m)
//	CYTALE_SSH_HOST_HANDSHAKE_TIMEOUT               (30s)
//	CYTALE_SSH_HOST_MAX_AUTH_TRIES                  (3)
//	CYTALE_SSH_HOST_MAX_PREAUTH_CONNECTIONS         (64)
//	CYTALE_SSH_HOST_MAX_SESSIONS_TOTAL              (128)
//	CYTALE_SSH_HOST_MAX_SESSIONS_PER_ACCOUNT        (4)
//	CYTALE_SSH_HOST_MAX_SESSIONS_PER_CONNECTION     (2)
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"charm.land/ssh"
	gossh "golang.org/x/crypto/ssh"

	"github.com/jrimmer/hrmny/apps/ssh-host/internal/auth"
	"github.com/jrimmer/hrmny/apps/ssh-host/internal/bridge"
	"github.com/jrimmer/hrmny/apps/ssh-host/internal/session"
)

// The environment variables this process reads. Paths are paths: the credential
// and the host key are never environment VALUES.
const (
	envCAPublicKey        = "CYTALE_SSH_HOST_CA_PUBLIC_KEY"
	envHostKey            = "CYTALE_SSH_HOST_KEY"
	envBridgeURL          = "CYTALE_SSH_HOST_BRIDGE_URL"
	envBridgeCredential   = "CYTALE_SSH_HOST_BRIDGE_CREDENTIAL"
	envClientCommand      = "CYTALE_SSH_HOST_CLIENT_COMMAND"
	envClientArgs         = "CYTALE_SSH_HOST_CLIENT_ARGS"
	envClientDir          = "CYTALE_SSH_HOST_CLIENT_DIR"
	envClientPath         = "CYTALE_SSH_HOST_CLIENT_PATH"
	envOrigin             = "CYTALE_SSH_HOST_ORIGIN"
	envRetainSecrets      = "CYTALE_SSH_HOST_RETAIN_SECRETS"
	envAddr               = "CYTALE_SSH_HOST_ADDR"
	envMaxSessionDuration = "CYTALE_SSH_HOST_MAX_SESSION_DURATION"
	envIdleTimeout        = "CYTALE_SSH_HOST_IDLE_TIMEOUT"
	envHandshakeTimeout   = "CYTALE_SSH_HOST_HANDSHAKE_TIMEOUT"
	envMaxAuthTries       = "CYTALE_SSH_HOST_MAX_AUTH_TRIES"
	envMaxPreAuth         = "CYTALE_SSH_HOST_MAX_PREAUTH_CONNECTIONS"
	envMaxSessionsTotal   = "CYTALE_SSH_HOST_MAX_SESSIONS_TOTAL"
	envMaxSessionsAccount = "CYTALE_SSH_HOST_MAX_SESSIONS_PER_ACCOUNT"
	envMaxSessionsConn    = "CYTALE_SSH_HOST_MAX_SESSIONS_PER_CONNECTION"
)

// Settings is the host's configuration as read from the environment.
//
// Every secret here is a PATH. There is no field that can hold a credential or a
// key, which is what makes "never in argv, never in the environment" a property
// of the type rather than a rule someone has to remember.
type Settings struct {
	CAPublicKeyPath      string
	HostKeyPath          string
	BridgeURL            string
	BridgeCredentialPath string
	ClientCommand        string
	ClientArgs           []string
	ClientDir            string
	ClientPath           string
	Origin               string
	Address              string
	RetainSecrets        bool

	MaxSessionDuration       time.Duration
	IdleTimeout              time.Duration
	HandshakeTimeout         time.Duration
	MaxAuthTries             int
	MaxPreAuthConnections    int
	MaxSessionsTotal         int
	MaxSessionsPerAccount    int
	MaxSessionsPerConnection int
}

// LoadSettings reads the environment, failing on anything missing or malformed.
//
// Fail-fast is the point: a host that starts without its credential or its trust
// set can only refuse every member, and a host that starts without an origin
// would hand the client a session it cannot use.
func LoadSettings(lookup func(string) string) (Settings, error) {
	if lookup == nil {
		lookup = os.Getenv
	}

	var missing []string
	required := func(name string) string {
		value := strings.TrimSpace(lookup(name))
		if value == "" {
			missing = append(missing, name)
		}
		return value
	}

	settings := Settings{
		CAPublicKeyPath:      required(envCAPublicKey),
		HostKeyPath:          required(envHostKey),
		BridgeURL:            required(envBridgeURL),
		BridgeCredentialPath: required(envBridgeCredential),
		ClientCommand:        required(envClientCommand),
		Origin:               required(envOrigin),
	}

	if len(missing) > 0 {
		return Settings{}, fmt.Errorf("missing required configuration: %s", strings.Join(missing, ", "))
	}

	settings.Address = valueOr(lookup, envAddr, session.DefaultListenAddress)
	settings.ClientPath = valueOr(lookup, envClientPath, session.DefaultChildPath)
	settings.ClientArgs = strings.Fields(lookup(envClientArgs))

	settings.ClientDir = strings.TrimSpace(lookup(envClientDir))
	if settings.ClientDir == "" {
		// The client's own directory is the only sensible default, and it is set
		// explicitly so the child never inherits this process's working
		// directory.
		settings.ClientDir = filepath.Dir(settings.ClientCommand)
	}

	var err error
	if settings.RetainSecrets, err = boolValue(lookup, envRetainSecrets, false); err != nil {
		return Settings{}, err
	}
	if settings.MaxSessionDuration, err = durationValue(lookup, envMaxSessionDuration, session.DefaultMaxSessionDuration); err != nil {
		return Settings{}, err
	}
	if settings.IdleTimeout, err = durationValue(lookup, envIdleTimeout, session.DefaultIdleTimeout); err != nil {
		return Settings{}, err
	}
	if settings.HandshakeTimeout, err = durationValue(lookup, envHandshakeTimeout, session.DefaultHandshakeTimeout); err != nil {
		return Settings{}, err
	}
	if settings.MaxAuthTries, err = intValue(lookup, envMaxAuthTries, session.DefaultMaxAuthTries); err != nil {
		return Settings{}, err
	}
	if settings.MaxPreAuthConnections, err = intValue(lookup, envMaxPreAuth, session.DefaultMaxPreAuthConnections); err != nil {
		return Settings{}, err
	}
	if settings.MaxSessionsTotal, err = intValue(lookup, envMaxSessionsTotal, session.DefaultMaxSessionsTotal); err != nil {
		return Settings{}, err
	}
	if settings.MaxSessionsPerAccount, err = intValue(lookup, envMaxSessionsAccount, session.DefaultMaxSessionsPerAccount); err != nil {
		return Settings{}, err
	}
	if settings.MaxSessionsPerConnection, err = intValue(lookup, envMaxSessionsConn, session.DefaultMaxSessionsPerConnection); err != nil {
		return Settings{}, err
	}

	return settings, nil
}

// SessionConfig builds the session layer's configuration.
func (s Settings) SessionConfig(logger *slog.Logger) session.Config {
	return session.Config{
		ListenAddress:            s.Address,
		ClientCommand:            []string{s.ClientCommand},
		ClientArgs:               s.ClientArgs,
		ClientDir:                s.ClientDir,
		Origin:                   s.Origin,
		ChildPath:                s.ClientPath,
		MaxSessionDuration:       s.MaxSessionDuration,
		IdleTimeout:              s.IdleTimeout,
		HandshakeTimeout:         s.HandshakeTimeout,
		MaxAuthTries:             s.MaxAuthTries,
		MaxPreAuthConnections:    s.MaxPreAuthConnections,
		MaxSessionsTotal:         s.MaxSessionsTotal,
		MaxSessionsPerAccount:    s.MaxSessionsPerAccount,
		MaxSessionsPerConnection: s.MaxSessionsPerConnection,
		Logger:                   logger,
	}
}

func main() {
	if err := run(context.Background(), os.Getenv, os.Stdout); err != nil {
		fmt.Fprintf(os.Stderr, "cytale-ssh-host: %v\n", err)
		os.Exit(1)
	}
}

// run boots the host and serves until the context is cancelled or a termination
// signal arrives. The context is a parameter so a test can stop the host without
// signalling the whole test process.
func run(ctx context.Context, lookup func(string) string, out anyWriter) error {
	logger := slog.New(slog.NewTextHandler(out, &slog.HandlerOptions{Level: slog.LevelInfo}))

	settings, err := LoadSettings(lookup)
	if err != nil {
		return err
	}

	// The trust set first: it is public, and a bad path should fail before any
	// secret is read.
	authorities, err := auth.LoadCAPublicKeys(settings.CAPublicKeyPath)
	if err != nil {
		return err
	}
	verifier, err := auth.NewVerifier(authorities)
	if err != nil {
		return err
	}

	// The secrets: read once, then unlink, so the window in which a same-uid
	// process could read them is as short as this function.
	credential, err := bridge.LoadCredential(settings.BridgeCredentialPath, settings.RetainSecrets)
	if err != nil {
		return err
	}
	hostKey, err := auth.LoadHostKey(settings.HostKeyPath, settings.RetainSecrets)
	if err != nil {
		return err
	}
	minter, err := bridge.New(settings.BridgeURL, credential)
	if err != nil {
		return err
	}

	host, err := session.NewHost(settings.SessionConfig(logger), verifier, minter, hostKey)
	if err != nil {
		return err
	}

	listener, err := net.Listen("tcp", settings.Address)
	if err != nil {
		return fmt.Errorf("listen on %s: %w", settings.Address, err)
	}

	// A boot line an operator can use to pin the host key and confirm the CA,
	// carrying no secret.
	logger.Info("ssh host listening",
		"address", listener.Addr().String(),
		"origin", settings.Origin,
		"host_key", gossh.FingerprintSHA256(hostKey.PublicKey()),
		"authorities", strings.Join(fingerprints(authorities), ","),
		"max_session_duration", settings.MaxSessionDuration.String(),
		"idle_timeout", settings.IdleTimeout.String(),
	)

	// A termination signal or a cancelled context stops the listener; the
	// process then exits, which is what makes "no client process survives its
	// connection" true of the deployment as well as of the session.
	signalCtx, stop := signal.NotifyContext(ctx, syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	go func() {
		<-signalCtx.Done()
		logger.Info("shutting down")
		_ = host.Close()
	}()

	// A closed listener is how a shutdown ends, not a failure.
	if err := host.Serve(listener); err != nil && !errors.Is(err, net.ErrClosed) && !errors.Is(err, ssh.ErrServerClosed) {
		return err
	}
	return nil
}

// anyWriter is io.Writer without importing io for one name.
type anyWriter interface {
	Write(p []byte) (int, error)
}

func fingerprints(keys []gossh.PublicKey) []string {
	values := make([]string, 0, len(keys))
	for _, key := range keys {
		values = append(values, gossh.FingerprintSHA256(key))
	}
	return values
}

func valueOr(lookup func(string) string, name, fallback string) string {
	if value := strings.TrimSpace(lookup(name)); value != "" {
		return value
	}
	return fallback
}

func durationValue(lookup func(string) string, name string, fallback time.Duration) (time.Duration, error) {
	raw := strings.TrimSpace(lookup(name))
	if raw == "" {
		return fallback, nil
	}
	parsed, err := time.ParseDuration(raw)
	if err != nil {
		return 0, fmt.Errorf("%s: %q is not a duration (for example 12h or 30m)", name, raw)
	}
	if parsed <= 0 {
		return 0, fmt.Errorf("%s: %s must be positive", name, parsed)
	}
	return parsed, nil
}

func intValue(lookup func(string) string, name string, fallback int) (int, error) {
	raw := strings.TrimSpace(lookup(name))
	if raw == "" {
		return fallback, nil
	}
	parsed, err := strconv.Atoi(raw)
	if err != nil {
		return 0, fmt.Errorf("%s: %q is not a whole number", name, raw)
	}
	if parsed <= 0 {
		return 0, fmt.Errorf("%s: %d must be positive", name, parsed)
	}
	return parsed, nil
}

func boolValue(lookup func(string) string, name string, fallback bool) (bool, error) {
	raw := strings.TrimSpace(lookup(name))
	if raw == "" {
		return fallback, nil
	}
	parsed, err := strconv.ParseBool(raw)
	if err != nil {
		return false, fmt.Errorf("%s: %q is not a boolean", name, raw)
	}
	return parsed, nil
}
