defmodule Mix.Tasks.Protocol.ManifestTest do
  @moduledoc """
  Drift test for hardening plan 6.6: the committed
  `packages/protocol/manifest.json` must be exactly what the server sources
  produce, and the extractor must see the real emission sites.

  This is the in-suite half of the gate — `pnpm protocol:check` runs the mix
  task with `--check` in CI, and this test fails the server suite the moment a
  server-side event or payload change lands without regenerating the manifest.
  """

  use ExUnit.Case, async: true

  alias Mix.Tasks.Protocol.Manifest

  # apps/server/test/mix/tasks -> repo root
  @root Path.expand("../../../../..", __DIR__)
  @manifest Path.join(@root, "packages/protocol/manifest.json")

  test "the committed manifest is exactly what the server sources produce" do
    assert Manifest.encode(Manifest.manifest(@root)) == File.read!(@manifest)
  end

  test "opcodes reflect the server's compiled table, never a transcription" do
    manifest = Manifest.manifest(@root)
    assert map_size(manifest.opcodes) == 14

    for {name, code} <- manifest.opcodes do
      assert {:ok, opcode} = Cytale.Gateway.Opcode.from_code(code)
      assert Atom.to_string(opcode) == name
    end
  end

  test "emission sites yield event names with their top-level payload fields" do
    events = Manifest.manifest(@root).events

    assert events["MessageCreate"] == [
             "attachments",
             "author_id",
             "author_override",
             "channel_id",
             "components",
             "content",
             "content_proxy_urls",
             "created_at",
             "edited_at",
             "embeds",
             "id",
             "mention_everyone",
             "mention_user_ids",
             "nonce",
             "reactions",
             "referenced",
             "reply_to_id",
             "thread_id"
           ]

    assert events["CallEnd"] == ["call_id", "channel_id", "ended_at", "reason"]

    # Built in Cytale.Interactions and dispatched as `minted.payload`.
    assert "application_id" in events["InteractionCreate"]

    # The compat dialect's shouty spellings are not native event names.
    refute Map.has_key?(events, "READY")
    refute Map.has_key?(events, "POST")
  end

  describe "resolution cycles (the walk must terminate)" do
    # A parameter that shares its name with the caller's argument, piped into
    # `Map.put`, once bound `updated` to itself: the task looped until killed
    # (15 minutes in one run) and CI's `pnpm protocol:check` would have hung
    # the same way. A self-rebinding and mutual recursion close the family.
    @cyclic_source ~S"""
    defmodule ManifestFixture.CardController do
      alias ManifestFixture.Publish

      def update(conn, params) do
        updated = apply_update(params)
        Publish.publish(conn, {"CardUpdate", card_json(updated)})
      end

      def flag(conn, updated) do
        updated = Map.put(updated, "flagged", true)
        Publish.publish(conn, {"CardFlag", updated})
      end

      def loop(conn) do
        Publish.publish(conn, {"CardLoop", ping(%{"seed" => 1})})
      end

      defp apply_update(params), do: %{"id" => params["id"], "content" => params["content"]}

      defp card_json(updated) do
        updated |> Map.put("components", []) |> Map.put("embeds", [])
      end

      defp ping(payload), do: if(payload["done"], do: payload, else: pong(payload))
      defp pong(payload), do: ping(payload)
    end
    """

    @tag :tmp_dir
    test "terminates on self-referential bindings and yields the reachable fields", %{
      tmp_dir: tmp
    } do
      File.mkdir_p!(Path.join(tmp, "packages/protocol"))
      lib = Path.join(tmp, "apps/server/lib")
      File.mkdir_p!(lib)
      File.write!(Path.join(lib, "card_controller.ex"), @cyclic_source)

      task = Task.async(fn -> Manifest.manifest(tmp) end)

      events =
        case Task.yield(task, 10_000) || Task.shutdown(task, :brutal_kill) do
          {:ok, manifest} -> manifest.events
          nil -> flunk("protocol.manifest did not terminate on a cyclic binding")
        end

      # The caller's binding flows through the same-named parameter.
      assert events["CardUpdate"] == ["components", "content", "embeds", "id"]
      # A rebinding in terms of itself keeps what it adds.
      assert events["CardFlag"] == ["flagged"]
      # Mutual recursion: the terminating branch still contributes.
      assert events["CardLoop"] == ["seed"]
    end
  end
end
