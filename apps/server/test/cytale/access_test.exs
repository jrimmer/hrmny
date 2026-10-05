defmodule Cytale.AccessTest do
  @moduledoc """
  The agent access document (agent-scoped access plan, U1) — pure, DB-free.

  The document is the whole of an agent's authority, so these tests are the
  contract: what it means to grant nothing, what cascades, what stays dormant,
  and which capabilities no level can reach.
  """

  use ExUnit.Case, async: true

  alias Cytale.Access
  alias Cytale.Permissions.Bitfield

  describe "fail-closed defaults" do
    test "a missing, blank, corrupt or future document grants NOTHING" do
      for input <- [nil, "", "not json", "[]", "{}", %{}, %{"v" => 99} |> Jason.encode!()] do
        doc = Access.effective(input)
        assert doc == Access.default(), "input #{inspect(input)} must not widen access"
        assert Access.level_for_workspace(doc, 123) == :none
        assert Access.dms_level(doc) == :none
        assert Access.bits(Access.level_for_workspace(doc, 123)) == 0
      end
    end

    test "the default document grants nothing and holds the humans DM policy" do
      assert %{dms: :none, dm_support: :humans, workspaces: %{mode: :none, level: nil, grants: %{}}} =
               Access.default()

      # The counterparty policy is the ONE field that does not fail closed: an
      # absent or corrupt document reads as :humans, which is the documented
      # default for every agent that predates the field (owner direction
      # 2026-09-15). The grants above still read as nothing.
      assert Access.dm_support(Access.effective("{ not json")) == :humans
    end

    test "the fixed nodes are read and cannot be raised by any document" do
      assert Access.server_level() == :read
      assert Access.account_level() == :read
    end
  end

  describe "round-trip and validation" do
    test "encode → effective preserves the whole tree" do
      doc = %{
        version: 1,
        dms: :read_write,
        dm_support: :humans,
        workspaces: %{
          mode: :custom,
          level: nil,
          grants: %{
            111 => %{level: :read, channels: %{222 => :read_write}},
            333 => %{level: :none, channels: %{}}
          }
        }
      }

      assert Access.effective(Access.encode(doc)) == doc
    end

    test "to_map is the API value: a nested object, fixed nodes mirrored, and parse accepts it back" do
      doc = Access.default()
      wire = Access.to_map(doc)

      # An object, not a JSON string: `encode/1` is the storage form and rides
      # in the `access` column, so a controller that reached for it would put a
      # quoted string in the response body.
      refute is_binary(wire)
      assert wire["v"] == 1

      # The fixed nodes are REPORTED, not stored: a client renders the level the
      # server states instead of hardcoding one.
      assert wire["server"] == "read"
      assert wire["account"] == %{"agent" => "read"}
      refute Map.has_key?(wire["account"], "user")

      # read → edit → write round-trips: the client echoes back what it read.
      assert {:ok, parsed} = Access.parse(wire)
      assert parsed == doc

      custom = %{
        doc
        | dms: :read_write,
          workspaces: %{
            mode: :custom,
            level: nil,
            grants: %{111 => %{level: :read, channels: %{222 => :read_write}}}
          }
      }

      assert {:ok, round_tripped} = custom |> Access.to_map() |> Access.parse()
      assert round_tripped == custom
    end

    test "parse accepts the ATOM-keyed internal form as well as the wire form" do
      # Every nested read must accept both key shapes: reading only one turns an
      # internally-built document into the no-access default (which the
      # fail-closed design then reports as "no grants" rather than an error).
      atom_keyed = %{
        version: 1,
        dms: :read_write,
        dm_support: :humans,
        workspaces: %{
          mode: :custom,
          level: nil,
          grants: %{111 => %{level: :read, channels: %{222 => :read_write}}}
        }
      }

      assert {:ok, doc} = Access.parse(atom_keyed)
      assert doc == atom_keyed
      assert Access.level_for_channel(Access.effective(Access.encode(doc)), 111, 222) == :read_write
    end

    test "parse accepts the wire form (string keys) and the internal form" do
      wire = %{
        "v" => 1,
        "dms" => "read",
        "workspaces" => %{
          "mode" => "custom",
          "level" => nil,
          "grants" => %{"111" => %{"level" => "read_write", "channels" => %{"222" => "read"}}}
        }
      }

      assert {:ok, doc} = Access.parse(wire)
      assert doc.dms == :read
      assert doc.workspaces.grants[111] == %{level: :read_write, channels: %{222 => :read}}

      # The same document through JSON text, as it comes back from storage.
      assert {:ok, ^doc} = Access.parse(Jason.encode!(wire))
    end

    test "a document that wants :all without a level is refused (the misclick shape)" do
      assert {:error, :all_requires_level} =
               Access.parse(%{"v" => 1, "workspaces" => %{"mode" => "all"}})
    end

    test "malformed documents are refused rather than silently stored" do
      for {doc, reason} <- [
            {%{"v" => 2, "workspaces" => %{"mode" => "none"}}, {:unsupported_version, 2}},
            {%{"v" => 1, "workspaces" => %{"mode" => "everything"}}, {:invalid_mode, "everything"}},
            {%{"v" => 1, "dms" => "write"}, {:invalid_level, :dms, "write"}},
            {%{"v" => 1, "workspaces" => %{"mode" => "all", "level" => "admin"}},
             {:invalid_level, :workspaces_level, "admin"}},
            {%{"v" => 1, "workspaces" => %{"mode" => "custom", "grants" => %{"1" => "read"}}}, :invalid_grant},
            {%{
               "v" => 1,
               "workspaces" => %{"mode" => "custom", "grants" => %{"1" => %{"level" => "read", "channels" => "x"}}}
             }, :invalid_channels}
          ] do
        assert {:error, ^reason} = Access.parse(doc), "expected #{inspect(reason)} for #{inspect(doc)}"
      end
    end
  end

  describe "cascade" do
    test ":all answers for every workspace, including one the owner has not joined yet" do
      doc = Access.parse!(%{"v" => 1, "workspaces" => %{"mode" => "all", "level" => "read"}})

      assert Access.level_for_workspace(doc, 999_999_999) == :read
      # …and for its channels, including ones created later (no entry needed).
      assert Access.level_for_channel(doc, 999_999_999, 12_345) == :read
    end

    test "a workspace grant covers channels created later" do
      doc =
        Access.parse!(%{
          "v" => 1,
          "workspaces" => %{
            "mode" => "custom",
            "grants" => %{"111" => %{"level" => "read_write", "channels" => %{"222" => "read"}}}
          }
        })

      assert Access.level_for_channel(doc, 111, 222) == :read
      # A channel that did not exist at grant time inherits the workspace level.
      assert Access.level_for_channel(doc, 111, 777_777) == :read_write
      # A workspace with no grant has none, and so do its channels.
      assert Access.level_for_channel(doc, 444, 555) == :none
    end

    test "an explicit channel grant may exceed its workspace level" do
      doc =
        Access.parse!(%{
          "v" => 1,
          "workspaces" => %{
            "mode" => "custom",
            "grants" => %{"111" => %{"level" => "read", "channels" => %{"222" => "read_write"}}}
          }
        })

      assert Access.level_for_workspace(doc, 111) == :read
      assert Access.level_for_channel(doc, 111, 222) == :read_write
    end
  end

  describe "dormancy (the exclusivity rule)" do
    test "setting the root takes the explicit grants OUT of force and clearing it restores them exactly" do
      custom =
        Access.parse!(%{
          "v" => 1,
          "workspaces" => %{
            "mode" => "custom",
            "grants" => %{
              "111" => %{"level" => "read_write", "channels" => %{"222" => "read"}},
              "333" => %{"level" => "none", "channels" => %{}}
            }
          }
        })

      # The root is set: every workspace answers with the root's level, whatever
      # the retained grants say.
      rooted = %{custom | workspaces: %{custom.workspaces | mode: :all, level: :read}}
      assert Access.level_for_workspace(rooted, 111) == :read
      assert Access.level_for_workspace(rooted, 333) == :read

      # Clearing the root returns the SAME grants — dormancy never rewrites them
      # (the AE3 guard: byte-identical, not merely equivalent).
      restored = %{rooted | workspaces: %{rooted.workspaces | mode: :custom, level: nil}}
      assert Access.encode(restored) == Access.encode(custom)
      assert Access.level_for_workspace(restored, 111) == :read_write
      assert Access.level_for_channel(restored, 111, 222) == :read
      assert Access.level_for_workspace(restored, 333) == :none
    end

    test "mode :none grants no workspace and leaves retained grants dormant" do
      doc =
        Access.parse!(%{
          "v" => 1,
          "workspaces" => %{
            "mode" => "none",
            "grants" => %{"111" => %{"level" => "read_write", "channels" => %{}}}
          }
        })

      assert Access.level_for_workspace(doc, 111) == :none
      assert Access.level_for_channel(doc, 111, 222) == :none
      # …and they are still there for when the mode changes back.
      assert doc.workspaces.grants[111].level == :read_write
    end
  end

  describe "the capability table (the drift contract)" do
    test ":none confers nothing and read is a subset of read_write" do
      assert Access.bits(:none) == 0

      read = Access.bits(:read)
      read_write = Access.bits(:read_write)
      assert Bitfield.has?(read, :view_channel)
      assert Bitfield.has?(read, :read_message_history)
      refute Bitfield.has?(read, :send_messages)
      assert Bitwise.band(read_write, read) == read, "read_write must imply read"
    end

    test "creating a reaction is WRITE, not read" do
      refute Bitfield.has?(Access.bits(:read), :add_reactions)
      assert Bitfield.has?(Access.bits(:read_write), :add_reactions)
    end

    test "no level can confer a management or moderation capability" do
      for level <- [:read, :read_write], bit <- Access.never() do
        refute Bitfield.has?(Access.bits(level), bit), "#{bit} must not be grantable by #{level}"
      end
    end

    test "drift: every permission the codebase defines is either grantable or explicitly never" do
      # A new capability added to Bitfield must be classified here — granted by
      # some level, or in never/0. Anything else fails, which is the point: an
      # unclassified capability is how "no access by default" quietly becomes
      # "some access" (the plan's stop condition).
      unclassified = Bitfield.names() |> Enum.reject(&Access.grantable?/1) |> Enum.reject(&(&1 in Access.never()))

      assert unclassified == [], "classify these permissions in Cytale.Access: #{inspect(unclassified)}"
    end
  end
end
