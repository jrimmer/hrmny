defmodule Cytale.Accounts.MailerTest do
  @moduledoc """
  The mailer seam's contract: `deliver/1` NEVER raises and never returns
  anything but `:ok | {:error, term()}`.

  Regression origin (live box, 2026-09-10): with `CYTALE_MAILER=dev` on a
  container whose rootfs is read-only, the Dev adapter's `File.write!` raised
  on `/app/tmp/dev_mailbox.jsonl`. The exception escaped through
  `POST /api/v1/auth/register`, which had ALREADY created the user row — the
  client saw a 500 for a registration that had succeeded, and the
  verification token died with the write (the file is its only sink).
  Both halves are pinned here: the seam reports instead of raising, and the
  token stays out of the log (P0-3) even on the failure path.
  """

  use ExUnit.Case, async: false

  # Reaches the database directly (no ScyllaCase) — excluded from a no-DB run.
  @moduletag :scylla

  import ExUnit.CaptureLog

  alias Cytale.Accounts.Mailer
  alias Cytale.Accounts.MailerTest.{ExitingAdapter, JunkAdapter, RaisingAdapter}

  @message %{
    kind: :verify_email,
    to: "mailer-test@example.com",
    username: "mailer_test",
    token: "token-that-must-never-be-logged"
  }

  describe "Dev adapter" do
    test "an unwritable mailbox is reported, never raised" do
      # A path UNDER a regular file: the same class of sink failure as the
      # read-only rootfs that broke register. `File.mkdir_p/1` reports it as
      # EEXIST (the parent "exists" — as a file) where a raw mkdir(2) would
      # say ENOTDIR; which errno surfaces depends on which call trips first.
      blocker = Path.join(tmp_dir(), "blocker")
      File.write!(blocker, "")
      mailbox = Path.join(blocker, "dev_mailbox.jsonl")

      with_mailbox(mailbox, fn ->
        log =
          capture_log(fn ->
            assert {:error, {:mailbox_unwritable, ^mailbox, reason}} = Mailer.Dev.deliver(@message)
            assert reason in [:eexist, :enotdir, :eacces, :erofs, :enoent]
          end)

        refute log =~ @message.token,
               "the token must never ride the log, not even on the delivery-failure path"
      end)
    end

    test "deliver/1 surfaces the sink failure as an error tuple" do
      blocker = Path.join(tmp_dir(), "blocker")
      File.write!(blocker, "")

      with_mailbox(Path.join(blocker, "dev_mailbox.jsonl"), fn ->
        log = capture_log(fn -> assert {:error, {:mailbox_unwritable, _, _}} = Mailer.deliver(@message) end)

        assert log =~ "delivery FAILED"
        refute log =~ @message.token
      end)
    end

    test "a writable mailbox still delivers and reports success" do
      mailbox = Path.join(tmp_dir(), "dev_mailbox.jsonl")

      with_mailbox(mailbox, fn ->
        events = telemetry_events(fn -> assert :ok = Mailer.deliver(@message) end)

        assert [{[:cytale, :accounts, :verification_email_delivery], %{success: 1}, %{kind: :verify_email}}] = events

        entry = mailbox |> File.read!() |> String.split("\n", trim: true) |> List.last() |> Jason.decode!()
        assert entry["token"] == @message.token
        assert entry["to"] == @message.to
      end)
    end
  end

  describe "deliver/1 with a misbehaving adapter" do
    test "an adapter that raises is reported, not leaked" do
      with_adapter(RaisingAdapter, fn ->
        log =
          capture_log(fn ->
            assert {:error, {:adapter_raised, message}} = Mailer.deliver(@message)
            assert message =~ "smtp is on fire"
          end)

        assert log =~ "delivery FAILED"
      end)
    end

    test "an adapter that exits is reported, not leaked" do
      with_adapter(ExitingAdapter, fn ->
        capture_log(fn -> assert {:error, {:adapter_exited, :kaboom}} = Mailer.deliver(@message) end)
      end)
    end

    test "a non-conforming return is reported, not passed through" do
      with_adapter(JunkAdapter, fn ->
        capture_log(fn ->
          assert {:error, {:unexpected_adapter_return, :no_idea}} = Mailer.deliver(@message)
        end)
      end)
    end

    test "the delivery telemetry records the failure (the operator's signal)" do
      with_adapter(RaisingAdapter, fn ->
        capture_log(fn ->
          events = telemetry_events(fn -> assert {:error, _} = Mailer.deliver(@message) end)

          assert [{[:cytale, :accounts, :verification_email_delivery], %{success: 0}, %{kind: :verify_email}}] = events
        end)
      end)
    end
  end

  # -- helpers -----------------------------------------------------------------

  defp tmp_dir do
    dir = Path.join(System.tmp_dir!(), "cytale-mailer-#{System.unique_integer([:positive])}")
    File.mkdir_p!(dir)
    on_exit(fn -> File.rm_rf(dir) end)
    dir
  end

  defp with_mailbox(path, fun) do
    previous = System.get_env("CYTALE_DEV_MAILBOX")
    System.put_env("CYTALE_DEV_MAILBOX", path)

    on_exit(fn ->
      if previous, do: System.put_env("CYTALE_DEV_MAILBOX", previous), else: System.delete_env("CYTALE_DEV_MAILBOX")
    end)

    fun.()
  end

  defp with_adapter(module, fun) do
    previous = Application.get_env(:cytale, Mailer)

    Application.put_env(:cytale, Mailer, Keyword.put(previous || [], :adapter, module))

    on_exit(fn ->
      if previous, do: Application.put_env(:cytale, Mailer, previous), else: Application.delete_env(:cytale, Mailer)
    end)

    fun.()
  end

  # Collects the delivery telemetry emitted while `fun` ran.
  defp telemetry_events(fun) do
    handler = {__MODULE__, make_ref()}

    :telemetry.attach(
      handler,
      [:cytale, :accounts, :verification_email_delivery],
      &__MODULE__.handle_telemetry/4,
      self()
    )

    on_exit(fn -> :telemetry.detach(handler) end)

    fun.()

    drain([])
  end

  @doc false
  def handle_telemetry(event, measurements, metadata, pid) do
    send(pid, {:telemetry, event, measurements, metadata})
  end

  defp drain(acc) do
    receive do
      {:telemetry, event, measurements, metadata} ->
        drain([{event, measurements, metadata} | acc])
    after
      0 -> Enum.reverse(acc)
    end
  end
end

# The configured adapter + the mailbox path are global (app env / OS env), so
# the suite above is async: false and restores both on exit. A named module
# (not a capture) keeps `:telemetry.attach/4` on the fast path.
defmodule Cytale.Accounts.MailerTest.RaisingAdapter do
  @behaviour Cytale.Accounts.Mailer

  @impl true
  def deliver(_message), do: raise("smtp is on fire")
end

defmodule Cytale.Accounts.MailerTest.ExitingAdapter do
  @behaviour Cytale.Accounts.Mailer

  @impl true
  def deliver(_message), do: exit(:kaboom)
end

defmodule Cytale.Accounts.MailerTest.JunkAdapter do
  @behaviour Cytale.Accounts.Mailer

  @impl true
  def deliver(_message), do: :no_idea
end
