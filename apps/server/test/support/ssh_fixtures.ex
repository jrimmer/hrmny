defmodule Cytale.SSHFixtures do
  @moduledoc """
  Test-only OpenSSH fixtures (U1): a throwaway CA, a client keypair, and a real
  `sshd` bound to an ephemeral loopback port with `TrustedUserCAKeys` pointed at
  the fixture CA.

  Two rules this module exists to keep:

    * **The deployment CA key is never written by a test.** Nothing here reads
      `Cytale.Config.ssh_ca_key_path/0`; a test seals its own key under an
      owner-only (0700) temporary directory that the fixtures remove on exit.
    * **A missing OpenSSH binary fails the gate.** The binary paths resolve
      through `Cytale.Config.openssh_{keygen,sshd,ssh}_bin/0`, and the resolver
      RAISES naming the path and the override variable. Skipping instead would
      let the only real proof of the certificate format evaporate silently
      (the plan's stop condition for U1).

  `sshd` runs as `-D -e` rather than `-d`: it accepts more than one connection
  and writes its log to stderr, which is also how readiness is detected — by
  the "Server listening on" line, never by a TCP probe (a probe would consume a
  `-d` server's single connection budget).
  """

  alias Cytale.SSH.CA

  @type sshd :: %{port: pos_integer(), port_ref: port(), os_pid: pos_integer(), started: String.t()}

  # name → {Cytale.Config accessor, program name, env override}
  @bins %{
    keygen: {:openssh_keygen_bin, "ssh-keygen", "CYTALE_OPENSSH_KEYGEN_BIN"},
    sshd: {:openssh_sshd_bin, "sshd", "CYTALE_OPENSSH_SSHD_BIN"},
    ssh: {:openssh_ssh_bin, "ssh", "CYTALE_OPENSSH_SSH_BIN"}
  }

  @doc """
  Create an owner-only scratch directory for one test and remove it on exit.

  Must be called from a test process (the cleanup is an `ExUnit` `on_exit`).
  """
  @spec tmp_dir!(String.t()) :: Path.t()
  def tmp_dir!(prefix) do
    dir = Path.join(System.tmp_dir!(), "#{prefix}-#{System.unique_integer([:positive])}")
    File.mkdir_p!(dir)
    File.chmod!(dir, 0o700)
    ExUnit.Callbacks.on_exit(fn -> File.rm_rf(dir) end)
    dir
  end

  @doc """
  A test-only CA keypair under `dir`, loaded through `Cytale.SSH.CA.load!/1`.

  Generated with the real `ssh-keygen` and then loaded: that the loader accepts
  a key file OpenSSH actually wrote (rather than one assembled to suit it) is
  part of what the interop gate proves.
  """
  @spec ca!(Path.t(), String.t()) :: %{path: Path.t(), ca: CA.t()}
  def ca!(dir, name \\ "ca") do
    path = Path.join(dir, name)
    keygen(["-t", "ed25519", "-N", "", "-C", "cytale-test-ca", "-f", path])
    %{path: path, ca: CA.load!(path)}
  end

  @doc """
  A client keypair: the private key path (chmod 600 by ssh-keygen) and the
  public key LINE a member would paste into the web UI.
  """
  @spec client_key!(Path.t(), String.t()) :: %{
          private_path: Path.t(),
          public_path: Path.t(),
          public_line: String.t()
        }
  def client_key!(dir, name \\ "id_ed25519") do
    path = Path.join(dir, name)
    keygen(["-t", "ed25519", "-N", "", "-C", "cytale-test-client", "-f", path])
    %{private_path: path, public_path: path <> ".pub", public_line: File.read!(path <> ".pub")}
  end

  @doc """
  Start a real `sshd` in `dir` trusting `ca`, and return its ephemeral port.

  The configuration is validated with `sshd -t` first, so a broken config fails
  with sshd's own message instead of a timeout; the process is killed and the
  port closed on test exit.
  """
  @spec start_sshd!(Path.t(), CA.t()) :: sshd()
  def start_sshd!(dir, %CA{} = ca) do
    sshd_bin = bin!(:sshd)

    host_key = Path.join(dir, "hostkey")
    keygen(["-t", "ed25519", "-N", "", "-C", "cytale-test-host", "-f", host_key])

    # The trust anchor is written from the LOADED CA, so the certificate's
    # embedded CA key and sshd's trusted key are provably the same key.
    trusted_ca_keys = Path.join(dir, "trusted_user_ca_keys")
    File.write!(trusted_ca_keys, CA.public_line(ca, "cytale-test-ca"))

    port = free_port()
    config = Path.join(dir, "sshd_config")
    File.write!(config, sshd_config(port, host_key, trusted_ca_keys, dir))

    run!(sshd_bin, ["-t", "-f", config], "sshd -t")

    port_ref =
      Port.open({:spawn_executable, sshd_bin}, [
        :binary,
        :exit_status,
        :stderr_to_stdout,
        {:args, ["-f", config, "-D", "-e"]}
      ])

    # The OS pid is captured HERE, in the test process, and the cleanup kills by
    # pid rather than by port: a port whose owning process has exited is closed,
    # so `Port.info(ref, :os_pid)` reads nil from the on_exit process — while
    # the orphaned sshd keeps listening (verified). Killing by a pid taken at
    # start is what actually leaves no sshd behind.
    {:os_pid, os_pid} = Port.info(port_ref, :os_pid)
    ExUnit.Callbacks.on_exit(fn -> stop_sshd(os_pid) end)

    %{
      port: port,
      port_ref: port_ref,
      os_pid: os_pid,
      started: await_listening!(port_ref, deadline(15_000), "")
    }
  end

  @doc """
  Drain sshd's log accumulated since the last drain — post-connection evidence
  such as its `Accepted publickey … ED25519-CERT … ID <key-id>` line.
  """
  @spec sshd_log(sshd(), timeout()) :: String.t()
  def sshd_log(%{port_ref: port_ref}, timeout \\ 1_000), do: drain(port_ref, timeout)

  @doc """
  The absolute path of an OpenSSH binary, or a raise naming what was looked for.

  This is the interop gate's refusal to degrade: a missing `sshd` must fail the
  test with a reason, not turn it into a skip.
  """
  @spec bin!(:keygen | :sshd | :ssh) :: Path.t()
  def bin!(name) do
    {config_fun, program, env_var} = Map.fetch!(@bins, name)
    path = apply(Cytale.Config, config_fun, [])

    if is_binary(path) and File.exists?(path) do
      path
    else
      raise """
      OpenSSH interop gate: #{program} not found at #{inspect(path)}.

      Set #{env_var} to the binary's absolute path. This test FAILS rather than
      skipping: it authenticates a certificate this server issued against a real
      sshd, which is the only proof the hand-rolled OpenSSH format is correct.
      """
    end
  end

  @doc """
  Run an OpenSSH command by fixture name; returns `{output, status}` and never
  raises on a non-zero exit (the caller asserts on the status and shows the
  output).
  """
  @spec run(:keygen | :sshd | :ssh, [String.t()]) :: {String.t(), non_neg_integer()}
  def run(bin_name, args), do: System.cmd(bin!(bin_name), args, stderr_to_stdout: true)

  @doc "An unused ephemeral loopback port (bound once, then released)."
  @spec free_port() :: pos_integer()
  def free_port do
    {:ok, socket} = :gen_tcp.listen(0, [:binary, ip: {127, 0, 0, 1}, reuseaddr: true])
    {:ok, port} = :inet.port(socket)
    :gen_tcp.close(socket)
    port
  end

  @doc """
  The login name a certificate's principal must equal on this host — the local
  account the interop gate's `sshd` authenticates as.
  """
  @spec local_login!() :: String.t()
  def local_login! do
    case System.get_env("USER") || System.get_env("LOGNAME") do
      login when is_binary(login) and login != "" ->
        login

      _other ->
        raise "OpenSSH interop gate: neither USER nor LOGNAME is set, so no local login name is available"
    end
  end

  # ---------------------------------------------------------------------------
  # internals
  # ---------------------------------------------------------------------------

  defp keygen(args), do: run!(bin!(:keygen), args, "ssh-keygen")

  defp run!(bin, args, label) do
    {output, status} = System.cmd(bin, args, stderr_to_stdout: true)

    if status == 0 do
      output
    else
      raise "#{label} #{Enum.join(args, " ")} exited #{status}:\n#{output}"
    end
  rescue
    e in ErlangError ->
      raise "#{label} could not be executed (#{Exception.message(e)})"
  end

  # The gate authenticates AS the local login (`local_login!/0`). Where the
  # suite runs as root — CI and many VM sandboxes do — `PermitRootLogin no`
  # makes sshd refuse before the certificate is ever checked ("ROOT LOGIN
  # REFUSED"), failing the gate for a reason that has nothing to do with the
  # certificate. `prohibit-password` admits root by public key only; with
  # password/keyboard auth off and `AuthorizedKeysFile none`, that still means
  # a certificate from the test CA or nothing (the control test pins it).
  # Any other login keeps the stricter `no`.
  defp permit_root_login do
    if local_login!() == "root", do: "prohibit-password", else: "no"
  end

  defp sshd_config(port, host_key, trusted_ca_keys, dir) do
    """
    # Cytale U1 interop fixture: a throwaway sshd trusting ONLY the test CA.
    Port #{port}
    ListenAddress 127.0.0.1
    HostKey #{host_key}
    PidFile #{Path.join(dir, "sshd.pid")}
    TrustedUserCAKeys #{trusted_ca_keys}
    PubkeyAuthentication yes
    PasswordAuthentication no
    KbdInteractiveAuthentication no
    AuthorizedKeysFile none
    PermitRootLogin #{permit_root_login()}
    UsePAM no
    StrictModes no
    LogLevel INFO
    """
  end

  # Readiness is the listening line, not a connect: a bare probe would count as
  # a connection to a single-shot sshd. Data is accumulated so a failure can
  # show what sshd said before it gave up.
  defp await_listening!(port_ref, deadline, acc) do
    receive do
      {^port_ref, {:data, data}} ->
        acc = acc <> data

        if acc =~ "Server listening on" do
          acc
        else
          await_listening!(port_ref, deadline, acc)
        end

      {^port_ref, {:exit_status, status}} ->
        raise "sshd exited (status #{status}) before listening:\n#{acc}"
    after
      remaining(deadline) ->
        raise "sshd did not report a listening socket within the deadline:\n#{acc}"
    end
  end

  defp drain(port_ref, timeout) do
    receive do
      {^port_ref, {:data, data}} -> data <> drain(port_ref, timeout)
      {^port_ref, {:exit_status, _status}} -> drain(port_ref, timeout)
    after
      timeout -> ""
    end
  end

  defp stop_sshd(os_pid) do
    # SIGTERM, then SIGKILL as a backstop (the second kill reports "No such
    # process" when the first worked — harmless). No `Port.close/1`: the port
    # belongs to the test process, which has already exited by the time this
    # runs, so only the OS process needs ending.
    System.cmd("kill", ["-TERM", Integer.to_string(os_pid)], stderr_to_stdout: true)
    Process.sleep(100)
    System.cmd("kill", ["-KILL", Integer.to_string(os_pid)], stderr_to_stdout: true)
    :ok
  end

  defp deadline(ms), do: System.monotonic_time(:millisecond) + ms

  defp remaining(deadline) do
    max(deadline - System.monotonic_time(:millisecond), 0)
  end
end
