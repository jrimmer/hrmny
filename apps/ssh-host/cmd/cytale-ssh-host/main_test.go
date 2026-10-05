package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/pem"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	gossh "golang.org/x/crypto/ssh"

	"github.com/jrimmer/hrmny/apps/ssh-host/internal/session"
)

// completeEnv is the minimum a boot needs.
func completeEnv() map[string]string {
	return map[string]string{
		envCAPublicKey:      "/etc/cytale/ca.pub",
		envHostKey:          "/etc/cytale/ssh_host_ed25519_key",
		envBridgeURL:        "http://127.0.0.1:4100",
		envBridgeCredential: "/run/secrets/bridge-credential",
		envClientCommand:    "/opt/cytale/tui/bin/cytale-tui",
		envOrigin:           "https://chat.example.com",
	}
}

func lookupFrom(env map[string]string) func(string) string {
	return func(name string) string { return env[name] }
}

func TestLoadSettingsRequiresEverySecretAndTheTrustSet(t *testing.T) {
	required := []string{
		envCAPublicKey,
		envHostKey,
		envBridgeURL,
		envBridgeCredential,
		envClientCommand,
		envOrigin,
	}

	for _, name := range required {
		t.Run(name, func(t *testing.T) {
			env := completeEnv()
			delete(env, name)

			_, err := LoadSettings(lookupFrom(env))
			if err == nil {
				t.Fatalf("a boot without %s was accepted", name)
			}
			// The failure names the variable and never a value, so a boot log is
			// safe to paste.
			if !strings.Contains(err.Error(), name) {
				t.Fatalf("err = %v, want it to name %s", err, name)
			}
		})
	}

	// A blank value is a missing value.
	env := completeEnv()
	env[envBridgeURL] = "   "
	if _, err := LoadSettings(lookupFrom(env)); err == nil {
		t.Fatal("a blank required value was accepted")
	}
}

// TestLoadSettingsHoldsPathsNotSecrets is the custody rule as a property of the
// type: there is no field a credential value could be read into, so no
// environment value can leak into a child's environment or into a log line.
func TestLoadSettingsHoldsPathsNotSecrets(t *testing.T) {
	env := completeEnv()
	env[envBridgeCredential] = "/run/secrets/bridge-credential"
	env[envHostKey] = "/etc/cytale/ssh_host_ed25519_key"

	settings, err := LoadSettings(lookupFrom(env))
	if err != nil {
		t.Fatalf("LoadSettings: %v", err)
	}
	if settings.BridgeCredentialPath != "/run/secrets/bridge-credential" {
		t.Errorf("BridgeCredentialPath = %q, want the path", settings.BridgeCredentialPath)
	}
	if settings.HostKeyPath != "/etc/cytale/ssh_host_ed25519_key" {
		t.Errorf("HostKeyPath = %q, want the path", settings.HostKeyPath)
	}

	// Every STRING field whose name mentions a secret must name a path, because a
	// string field holding a secret is a field that can be logged, or read out of
	// a child's environment after boot.
	kind := reflect.TypeOf(settings)
	for i := 0; i < kind.NumField(); i++ {
		field := kind.Field(i)
		if field.Type.Kind() != reflect.String {
			continue
		}
		name := strings.ToLower(field.Name)
		if !strings.Contains(name, "credential") && !strings.Contains(name, "secret") &&
			!strings.Contains(name, "token") && !strings.Contains(name, "key") {
			continue
		}
		if !strings.HasSuffix(name, "path") {
			t.Errorf("Settings.%s is a string that is not a path; it could hold a secret value", field.Name)
		}
	}
}

func TestLoadSettingsAppliesStatedDefaults(t *testing.T) {
	settings, err := LoadSettings(lookupFrom(completeEnv()))
	if err != nil {
		t.Fatalf("LoadSettings: %v", err)
	}

	if settings.Address != session.DefaultListenAddress {
		t.Errorf("Address = %q, want %q", settings.Address, session.DefaultListenAddress)
	}
	if settings.ClientPath != session.DefaultChildPath {
		t.Errorf("ClientPath = %q", settings.ClientPath)
	}
	if settings.MaxSessionDuration != session.DefaultMaxSessionDuration {
		t.Errorf("MaxSessionDuration = %v, want %v", settings.MaxSessionDuration, session.DefaultMaxSessionDuration)
	}
	if settings.IdleTimeout != session.DefaultIdleTimeout {
		t.Errorf("IdleTimeout = %v, want %v", settings.IdleTimeout, session.DefaultIdleTimeout)
	}
	if settings.HandshakeTimeout != session.DefaultHandshakeTimeout {
		t.Errorf("HandshakeTimeout = %v", settings.HandshakeTimeout)
	}
	if settings.MaxAuthTries != session.DefaultMaxAuthTries {
		t.Errorf("MaxAuthTries = %d", settings.MaxAuthTries)
	}
	if settings.MaxPreAuthConnections != session.DefaultMaxPreAuthConnections {
		t.Errorf("MaxPreAuthConnections = %d", settings.MaxPreAuthConnections)
	}
	if settings.MaxSessionsPerAccount != session.DefaultMaxSessionsPerAccount {
		t.Errorf("MaxSessionsPerAccount = %d", settings.MaxSessionsPerAccount)
	}
	if settings.RetainSecrets {
		t.Error("RetainSecrets defaults to true; the default posture is read-once-and-unlink")
	}

	// The working directory defaults to the client's own directory, and it is
	// always set explicitly so the child never inherits this process's.
	if settings.ClientDir != filepath.Dir(settings.ClientCommand) {
		t.Errorf("ClientDir = %q, want the client command's directory", settings.ClientDir)
	}
}

func TestLoadSettingsParsesOverrides(t *testing.T) {
	env := completeEnv()
	env[envAddr] = "0.0.0.0:2222"
	env[envMaxSessionDuration] = "45m"
	env[envIdleTimeout] = "10m"
	env[envHandshakeTimeout] = "5s"
	env[envMaxAuthTries] = "2"
	env[envMaxPreAuth] = "16"
	env[envMaxSessionsTotal] = "9"
	env[envMaxSessionsAccount] = "2"
	env[envMaxSessionsConn] = "1"
	env[envRetainSecrets] = "true"
	env[envClientArgs] = "--no-color --workspace=demo"
	env[envClientDir] = "/opt/cytale"

	settings, err := LoadSettings(lookupFrom(env))
	if err != nil {
		t.Fatalf("LoadSettings: %v", err)
	}

	if settings.Address != "0.0.0.0:2222" {
		t.Errorf("Address = %q", settings.Address)
	}
	if settings.MaxSessionDuration != 45*time.Minute {
		t.Errorf("MaxSessionDuration = %v", settings.MaxSessionDuration)
	}
	if settings.IdleTimeout != 10*time.Minute {
		t.Errorf("IdleTimeout = %v", settings.IdleTimeout)
	}
	if settings.HandshakeTimeout != 5*time.Second {
		t.Errorf("HandshakeTimeout = %v", settings.HandshakeTimeout)
	}
	if settings.MaxAuthTries != 2 || settings.MaxPreAuthConnections != 16 {
		t.Errorf("auth bounds = %d / %d", settings.MaxAuthTries, settings.MaxPreAuthConnections)
	}
	if settings.MaxSessionsTotal != 9 || settings.MaxSessionsPerAccount != 2 || settings.MaxSessionsPerConnection != 1 {
		t.Errorf("session bounds = %d / %d / %d",
			settings.MaxSessionsTotal, settings.MaxSessionsPerAccount, settings.MaxSessionsPerConnection)
	}
	if !settings.RetainSecrets {
		t.Error("RetainSecrets was not honoured")
	}
	if len(settings.ClientArgs) != 2 {
		t.Errorf("ClientArgs = %v", settings.ClientArgs)
	}
	if settings.ClientDir != "/opt/cytale" {
		t.Errorf("ClientDir = %q", settings.ClientDir)
	}
}

func TestLoadSettingsRejectsMalformedValues(t *testing.T) {
	cases := map[string]map[string]string{
		"unparseable duration":  {envMaxSessionDuration: "twelve hours"},
		"zero duration":         {envIdleTimeout: "0s"},
		"negative duration":     {envHandshakeTimeout: "-5s"},
		"duration without unit": {envMaxSessionDuration: "300"},
		"unparseable count":     {envMaxAuthTries: "three"},
		"zero count":            {envMaxPreAuth: "0"},
		"unparseable boolean":   {envRetainSecrets: "yes please"},
	}

	for name, overrides := range cases {
		t.Run(name, func(t *testing.T) {
			env := completeEnv()
			for key, value := range overrides {
				env[key] = value
			}
			_, err := LoadSettings(lookupFrom(env))
			if err == nil {
				t.Fatalf("%s was accepted", name)
			}
			for key := range overrides {
				if !strings.Contains(err.Error(), key) {
					t.Errorf("err = %v, want it to name %s", err, key)
				}
			}
		})
	}
}

// TestSessionConfigPassesOnlyHostConfigurationWorthThrough keeps the session
// layer's configuration from acquiring a session-supplied value by accident.
func TestSessionConfigPassesOnlyHostConfigurationWorthThrough(t *testing.T) {
	env := completeEnv()
	env[envClientArgs] = "--workspace=demo"
	settings, err := LoadSettings(lookupFrom(env))
	if err != nil {
		t.Fatalf("LoadSettings: %v", err)
	}

	cfg := settings.SessionConfig(nil)
	if cfg.Origin != settings.Origin {
		t.Errorf("Origin = %q", cfg.Origin)
	}
	if cfg.ClientDir != settings.ClientDir {
		t.Errorf("ClientDir = %q", cfg.ClientDir)
	}
	if len(cfg.ClientArgs) != 1 || cfg.ClientArgs[0] != "--workspace=demo" {
		t.Errorf("ClientArgs = %v", cfg.ClientArgs)
	}
	if cfg.ChildPath != settings.ClientPath {
		t.Errorf("ChildPath = %q", cfg.ChildPath)
	}
	if cfg.IdleTimeout != settings.IdleTimeout || cfg.MaxSessionDuration != settings.MaxSessionDuration {
		t.Error("the session bounds were not passed through")
	}
}

// TestRunFailsFastBeforeReadingAnySecret proves the ordering: a missing trust set
// fails before the process touches the credential or the host key, so a
// misconfigured boot never has a window in which it has read a secret it cannot
// use.
func TestRunFailsFastBeforeReadingAnySecret(t *testing.T) {
	dir := t.TempDir()
	credentialPath := filepath.Join(dir, "credential")
	hostKeyPath := filepath.Join(dir, "host-key")
	if err := os.WriteFile(credentialPath, []byte("credential\n"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	if err := os.WriteFile(hostKeyPath, []byte("not a key\n"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}

	env := completeEnv()
	env[envCAPublicKey] = filepath.Join(dir, "absent-ca.pub")
	env[envBridgeCredential] = credentialPath
	env[envHostKey] = hostKeyPath

	var out bytes.Buffer
	if err := run(context.Background(), lookupFrom(env), &out); err == nil {
		t.Fatal("a boot with no trust set succeeded")
	}

	// Both secrets are still on disk: the boot failed before it read them, so the
	// unlink never ran and nothing was left half-configured.
	for _, path := range []string{credentialPath, hostKeyPath} {
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("%s was read or removed before the trust set was validated: %v", path, err)
		}
	}
}

// TestRunUnlinksTheSecretsAtBoot is R12a at the process level: by the time the
// host is listening, neither secret path exists.
func TestRunUnlinksTheSecretsAtBoot(t *testing.T) {
	dir := t.TempDir()

	authorityPEM, hostKeyPEM, _ := testKeyMaterial(t)
	caPath := filepath.Join(dir, "ca.pub")
	credentialPath := filepath.Join(dir, "credential")
	hostKeyPath := filepath.Join(dir, "host-key")
	if err := os.WriteFile(caPath, authorityPEM, 0o644); err != nil {
		t.Fatalf("write CA: %v", err)
	}
	if err := os.WriteFile(credentialPath, []byte("credential\n"), 0o600); err != nil {
		t.Fatalf("write credential: %v", err)
	}
	if err := os.WriteFile(hostKeyPath, hostKeyPEM, 0o600); err != nil {
		t.Fatalf("write host key: %v", err)
	}

	// The client command must exist: point it at this test binary, which is a
	// real executable on disk.
	env := map[string]string{
		envCAPublicKey:      caPath,
		envHostKey:          hostKeyPath,
		envBridgeURL:        "http://127.0.0.1:4100",
		envBridgeCredential: credentialPath,
		envClientCommand:    os.Args[0],
		envClientDir:        dir,
		envOrigin:           "https://chat.example.com",
		envAddr:             "127.0.0.1:0",
	}

	// run blocks in Serve until its context is cancelled or a termination signal
	// arrives, so the test starts it and cancels it afterwards.
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	serving := make(chan error, 1)
	go func() { serving <- run(ctx, lookupFrom(env), &bytes.Buffer{}) }()

	// Wait until the host is serving before asserting: an unlinked secret proves
	// nothing if the boot never reached it, and a listener that is up is the
	// observable end of boot.
	listening := waitForListener(t, hostKeyPath)

	// The assertion is about the state at boot, so it is made while the host is
	// serving rather than after it stops.
	for _, path := range []string{credentialPath, hostKeyPath} {
		file, err := os.Open(path)
		if err == nil {
			file.Close() //nolint:errcheck // test
			t.Fatalf("%s is still openable after boot; a same-uid client could read it (R12a)", path)
		}
		if !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("open %s: %v, want os.ErrNotExist", path, err)
		}
	}

	// The CA public key is not a secret and stays where the operator put it.
	if _, err := os.Stat(caPath); err != nil {
		t.Fatalf("the CA public key was removed: %v", err)
	}
	if !listening {
		select {
		case err := <-serving:
			t.Fatalf("the host never served: %v", err)
		default:
			t.Fatal("the host never served")
		}
	}

	cancel()
	select {
	case err := <-serving:
		if err != nil {
			t.Fatalf("the host did not shut down cleanly: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the host did not shut down when its context was cancelled")
	}
}

// waitForListener waits until the host key has been unlinked and the boot has
// had a moment to reach Serve, which is the observable end of a successful boot.
func waitForListener(t *testing.T, hostKeyPath string) bool {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(hostKeyPath); err != nil {
			time.Sleep(100 * time.Millisecond)
			return true
		}
		time.Sleep(10 * time.Millisecond)
	}
	return false
}

// testKeyMaterial builds a throwaway CA public key line and a host private key,
// both PEM text, for a boot that never leaves this process.
func testKeyMaterial(t *testing.T) (authorityLine, hostKeyPEM []byte, _ struct{}) {
	t.Helper()

	_, caPrivate, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate CA: %v", err)
	}
	caSigner, err := gossh.NewSignerFromKey(caPrivate)
	if err != nil {
		t.Fatalf("CA signer: %v", err)
	}

	_, hostPrivate, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate host key: %v", err)
	}
	block, err := gossh.MarshalPrivateKey(hostPrivate, "")
	if err != nil {
		t.Fatalf("marshal host key: %v", err)
	}

	return gossh.MarshalAuthorizedKey(caSigner.PublicKey()), pem.EncodeToMemory(block), struct{}{}
}
