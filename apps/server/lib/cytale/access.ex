defmodule Cytale.Access do
  @moduledoc """
  The agent access document (agent-scoped access plan, U1).

  An AGENT — a machine principal (`:bot` internally, "Agent" to a user) — starts
  with **no access** and holds only what this document grants, node by node. The
  document replaces the old model, where a machine principal inherited its
  owner's membership rights and a flat restriction map narrowed them: that made
  access implicit and broad by default.

  ## The tree

      Server          fixed :read — always granted, not user-changeable
      Account
        └ agent       fixed :read — its own identity; nothing to grant
      DMs             :none | :read | :read_write   (semantics: its own ticket)
      Workspaces      mode: :none | :all | :custom
        └ workspace   :none | :read | :read_write   (when :custom)
            └ channel  :none | :read | :read_write   (when :custom)

  Two rules carry the design:

    * **Cascade.** `mode: :all` applies to every workspace, *including ones the
      owner joins later* — a predicate, not a snapshot. A workspace's level is
      the default for its channels, including channels created later.
    * **Dormancy.** The document always keeps the explicit `grants`; the mode
      decides whether they are IN FORCE. Setting the root (`:all`) puts them out
      of force without deleting them, so clearing the root restores the exact
      same grants. Nothing about switching modes rewrites the other side.

  ## Fail-closed

  `effective/1` is what the resolver reads: a missing, blank or corrupt
  document yields the all-none default, never the legacy behaviour. There is no
  path where "we could not read the grants" means "unrestricted".

  ## The capability table

  `@capabilities` is DATA — one place a level's meaning is written down, so a
  capability added later cannot quietly acquire a level. `never/0` lists what no
  level confers, and `grantable?/1` answers the question a drift test asks.
  """

  alias Cytale.Permissions.Bitfield

  @version 1

  @typedoc "A grant level. `:read_write` implies `:read`."
  @type level :: :none | :read | :read_write

  @typedoc "How the Workspaces node resolves: none, all (a level for every ws), or the explicit grants."
  @type mode :: :none | :all | :custom

  @typedoc "A workspace's explicit grant: a level plus optional per-channel levels."
  @type grant :: %{level: level(), channels: %{optional(integer()) => level()}}

  @typedoc "The document: mode + level + grants, with the fixed nodes."
  @type t :: %{
          version: pos_integer(),
          dms: level(),
          dm_support: dm_support(),
          workspaces: %{mode: mode(), level: level() | nil, grants: %{optional(integer()) => grant()}}
        }

  @typedoc """
  WHO this agent will hold a direct message WITH (owner direction 2026-09-15):
  `:humans` (the default — people only), `:everyone` (people and other agents),
  `:none` (nobody). It is the counterparty axis, distinct from `dms`, which is
  the agent's own read/write level on a DM it already has.

  NOTE it does NOT fail closed the way the grants do: absent or corrupt reads as
  `:humans`, because that is the stated default for every agent that predates
  this field. The grants default to nothing; this policy defaults to its
  documented resting state.
  """
  @type dm_support :: :humans | :everyone | :none

  @levels [:none, :read, :read_write]
  @modes [:none, :all, :custom]
  @dm_supports [:humans, :everyone, :none]
  @dm_support_default :humans

  @doc """
  What each level confers, as Bitfield names. `:none` confers nothing, so it has
  no entry; anything not listed here and present in `never/0` is ungrantable.
  """
  @spec capabilities() :: %{level() => [atom()]}
  def capabilities do
    %{
      read: [:view_channel, :read_message_history],
      # add_reactions is WRITE (creating a reaction mutates state), and threads
      # are participation. Neither is implied by reading.
      read_write: [
        :view_channel,
        :read_message_history,
        :send_messages,
        :upload_attachments,
        :add_reactions,
        :create_threads,
        # A bot may set its OWN workspace nickname, like any member (#169:
        # bots and people get the same capabilities). Still ANDed with its
        # parent's bits, so it only holds it where the parent does.
        :change_nickname
      ]
    }
  end

  @doc """
  Bits NO level confers — management and moderation live outside an agent's
  grant surface entirely. A grant cannot be expressed for these, so a resolver
  never has to ask "is this allowed by the level?": the level cannot name them.
  """
  @spec never() :: [atom()]
  def never do
    [
      :manage_channels,
      :manage_roles,
      :manage_workspace,
      :manage_messages,
      :mention_everyone,
      :create_invites,
      :kick_members,
      :ban_members,
      :administrator,
      :manage_threads,
      # Renaming OTHERS is moderation, never part of a grant (#169).
      :manage_nicknames,
      # Voice/video are NOT part of an agent's grant surface in v1: an agent that
      # may write to a channel must not thereby acquire the ability to open a
      # call or publish media. If agents are ever given media, that is a new
      # level or a new node — a deliberate design — never a side-effect of
      # `:read_write`. (The drift test is what surfaced these three.)
      :start_call,
      :send_video,
      :share_screen
    ]
  end

  @doc """
  Is `bit` reachable by ANY level? The drift guard: a capability added to the
  codebase must appear in a level's list or in `never/0`, or this returns false
  and the test fails.
  """
  @spec grantable?(atom()) :: boolean()
  def grantable?(bit) do
    capabilities() |> Map.values() |> List.flatten() |> Enum.member?(bit)
  end

  @doc "The all-none document: what an agent has before anyone grants it anything."
  @spec default() :: t()
  def default do
    %{
      version: @version,
      dms: :none,
      dm_support: @dm_support_default,
      workspaces: %{mode: :none, level: nil, grants: %{}}
    }
  end

  @doc """
  Read a STORED document. Never fails and never widens: nil/blank/corrupt, or a
  version we do not understand, yields the no-access default (fail-closed).
  """
  @spec effective(String.t() | map() | nil) :: t()
  def effective(nil), do: default()
  def effective(""), do: default()

  def effective(text) when is_binary(text) do
    case Jason.decode(text) do
      {:ok, map} when is_map(map) -> effective(map)
      _ -> default()
    end
  end

  def effective(%{} = map) do
    case parse(map) do
      {:ok, doc} -> doc
      {:error, _} -> default()
    end
  end

  def effective(_), do: default()

  @doc """
  Strict parse for the WRITE path: a document the caller wants stored must be
  well-formed, so a bad payload is refused rather than silently stored as
  no-access. Accepts the wire form (string keys) or the internal atom-keyed form.
  """
  @spec parse(map() | String.t() | nil) :: {:ok, t()} | {:error, term()}
  def parse(text) when is_binary(text) do
    case Jason.decode(text) do
      {:ok, map} when is_map(map) -> parse(map)
      _ -> {:error, :invalid_json}
    end
  end

  def parse(%{} = map) do
    with {:ok, _} <- version(map),
         {:ok, dms} <- level(field(map, "dms", :none), :dms),
         {:ok, dm_support} <- dm_support_field(field(map, "dm_support", @dm_support_default)),
         {:ok, workspaces} <- workspaces(map) do
      {:ok, %{version: @version, dms: dms, dm_support: dm_support, workspaces: workspaces}}
    end
  end

  def parse(_), do: {:error, :invalid_document}

  @doc """
  Strict parse that RAISES on an invalid document. For tests and for callers
  that treat a malformed grant as a programming error rather than user input
  (the write path uses `parse/1` so it can answer 400).
  """
  @spec parse!(map() | String.t()) :: t()
  def parse!(doc) do
    case parse(doc) do
      {:ok, parsed} -> parsed
      {:error, reason} -> raise ArgumentError, "invalid access document: #{inspect(reason)}"
    end
  end

  @doc """
  The document as an API value: string keys, version stamped, and the FIXED
  nodes mirrored in it (`server`, `account`) so a client renders the levels the
  server reports rather than hardcoding them — a change to `server_level/0`
  reaches the UI without a client release.

  This is the form that rides in JSON responses and that a client echoes back
  on a write: `parse/1` ignores the fixed mirrors and reads only what the
  caller may actually set, so read → edit → write round-trips by construction.
  """
  @spec to_map(t()) :: map()
  def to_map(%{} = doc) do
    %{
      "v" => @version,
      "server" => Atom.to_string(server_level()),
      "account" => %{"agent" => Atom.to_string(account_level())},
      "dms" => Atom.to_string(doc.dms),
      "dm_support" => Atom.to_string(doc.dm_support),
      "workspaces" => %{
        "mode" => Atom.to_string(doc.workspaces.mode),
        "level" => level_string(doc.workspaces.level),
        "grants" => encode_grants(doc.workspaces.grants)
      }
    }
  end

  @doc "Encode for storage (text; the `principals.access` column)."
  @spec encode(t()) :: String.t()
  def encode(%{} = doc), do: Jason.encode!(to_map(doc))

  # -- resolution (pure; the resolver wires these in U2) ------------------------

  @doc "Server is fixed: always granted at read, never user-changeable."
  @spec server_level() :: level()
  def server_level, do: :read

  @doc """
  The agent's OWN account is fixed at read — it is its identity, so there is
  nothing to grant. The owner's account is NOT a node: an agent acts under its
  own identity, so no grant can make it act as its owner.
  """
  @spec account_level() :: level()
  def account_level, do: :read

  @doc "The DM level the document grants (semantics land with the DM ticket)."
  @spec dms_level(t()) :: level()
  def dms_level(%{dms: dms}), do: dms

  @doc """
  Who this agent will DM with. The one reader the DM-open guard consults, so
  the policy has exactly one interpretation.
  """
  @spec dm_support(t()) :: dm_support()
  def dm_support(%{dm_support: support}), do: support

  # The wire/stored value for the counterparty policy; a value we do not know is
  # refused on the write path rather than coerced.
  defp dm_support_field(value) when value in @dm_supports, do: {:ok, value}

  defp dm_support_field(value) when is_binary(value) do
    case Enum.find(@dm_supports, &(Atom.to_string(&1) == value)) do
      nil -> {:error, {:invalid_dm_support, value}}
      atom -> {:ok, atom}
    end
  end

  defp dm_support_field(value), do: {:error, {:invalid_dm_support, value}}

  @doc """
  The effective level for a workspace.

  `:all` answers for EVERY workspace — including ones the owner has not joined
  yet — because the grant is a predicate over "my workspaces", not a list baked
  at grant time. `:custom` reads the explicit grants; `:none` grants nothing and
  leaves any retained grants dormant.
  """
  @spec level_for_workspace(t(), integer() | String.t()) :: level()
  def level_for_workspace(%{workspaces: %{mode: :all, level: level}}, _ws_id), do: level

  def level_for_workspace(%{workspaces: %{mode: :custom, grants: grants}}, ws_id) do
    case grant_for(grants, ws_id) do
      %{level: level} -> level
      nil -> :none
    end
  end

  def level_for_workspace(%{workspaces: %{mode: :none}}, _ws_id), do: :none
  def level_for_workspace(_doc, _ws_id), do: :none

  @doc """
  The effective level for a channel: its own explicit grant when it has one,
  otherwise the workspace's level (which is how a workspace grant covers channels
  created later). An explicit channel grant may be HIGHER than its workspace's —
  "this one channel is writable" is a legitimate thing to want.
  """
  @spec level_for_channel(t(), integer() | String.t(), integer() | String.t()) :: level()
  def level_for_channel(%{workspaces: %{mode: :custom, grants: grants}} = doc, ws_id, ch_id) do
    case grant_for(grants, ws_id) do
      %{channels: channels} ->
        Map.get(channels, normalise_id(ch_id)) || level_for_workspace(doc, ws_id)

      _ ->
        :none
    end
  end

  def level_for_channel(doc, ws_id, _ch_id), do: level_for_workspace(doc, ws_id)

  @doc """
  The bits a level confers — the ONLY way bits are derived for a machine
  principal. `:none` is zero bits, and no level can name a `never/0` bit.
  """
  @spec bits(level()) :: Bitfield.t()
  def bits(:none), do: 0

  def bits(level) do
    capabilities()
    |> Map.get(level, [])
    |> Enum.reduce(0, fn name, acc -> Bitfield.bor(acc, Bitfield.bit(name)) end)
  end

  # -- internals ---------------------------------------------------------------

  # A field read that accepts the wire shape and the internal one. Reading only
  # one key shape is how an atom-keyed document silently parses as all-none,
  # which is exactly the failure mode a fail-closed default hides.
  defp field(map, key, default \\ nil) when is_map(map) do
    Map.get(map, key, Map.get(map, String.to_existing_atom(key), default))
  end

  defp version(map) do
    case field(map, "v", @version) do
      @version -> {:ok, @version}
      other -> {:error, {:unsupported_version, other}}
    end
  end

  defp workspaces(map) do
    ws = field(map, "workspaces", %{})

    with {:ok, mode} <- mode(field(ws, "mode", :none)),
         {:ok, level} <- all_level(mode, field(ws, "level")),
         {:ok, grants} <- grants(field(ws, "grants", %{})) do
      {:ok, %{mode: mode, level: level, grants: grants}}
    end
  end

  defp mode(mode) do
    case atom(mode) do
      m when m in @modes -> {:ok, m}
      other -> {:error, {:invalid_mode, other}}
    end
  end

  # `:all` must NAME a level (it is the level that cascades); the others carry
  # none. A missing level on `:all` is the misclick this shape prevents.
  defp all_level(:all, nil), do: {:error, :all_requires_level}
  defp all_level(:all, level), do: level(level, :workspaces_level)
  defp all_level(_mode, _level), do: {:ok, nil}

  defp grants(map) when is_map(map) do
    Enum.reduce_while(map, {:ok, %{}}, fn {ws_id, grant}, {:ok, acc} ->
      case grant(grant) do
        {:ok, parsed} -> {:cont, {:ok, Map.put(acc, normalise_id(ws_id), parsed)}}
        {:error, reason} -> {:halt, {:error, reason}}
      end
    end)
  end

  defp grants(_), do: {:error, :invalid_grants}

  defp grant(map) when is_map(map) do
    with {:ok, level} <- level(field(map, "level", :none), :grant_level),
         {:ok, channels} <- channels(field(map, "channels", %{})) do
      {:ok, %{level: level, channels: channels}}
    end
  end

  defp grant(_), do: {:error, :invalid_grant}

  defp channels(map) when is_map(map) do
    Enum.reduce_while(map, {:ok, %{}}, fn {ch_id, level}, {:ok, acc} ->
      case level(level, :channel_level) do
        {:ok, parsed} -> {:cont, {:ok, Map.put(acc, normalise_id(ch_id), parsed)}}
        {:error, reason} -> {:halt, {:error, reason}}
      end
    end)
  end

  defp channels(_), do: {:error, :invalid_channels}

  defp level(nil, _where), do: {:ok, :none}

  defp level(value, where) do
    case atom(value) do
      l when l in @levels -> {:ok, l}
      other -> {:error, {:invalid_level, where, other}}
    end
  end

  defp atom(value) when is_atom(value), do: value

  # The wire carries levels AND modes as strings; unknown values pass through so
  # the validator reports what it actually saw.
  defp atom(value) when is_binary(value) do
    case value do
      "none" -> :none
      "read" -> :read
      "read_write" -> :read_write
      "all" -> :all
      "custom" -> :custom
      other -> other
    end
  end

  defp atom(other), do: other

  # Ids arrive as integers (internal) or decimal strings (wire/JSON keys).
  defp normalise_id(id) when is_integer(id), do: id

  defp normalise_id(id) when is_binary(id) do
    case Integer.parse(id) do
      {int, ""} -> int
      _ -> id
    end
  end

  defp normalise_id(id), do: id

  defp grant_for(grants, ws_id), do: Map.get(grants, normalise_id(ws_id))

  defp level_string(nil), do: nil
  defp level_string(level), do: Atom.to_string(level)

  defp encode_grants(grants) do
    Map.new(grants, fn {ws_id, %{level: level, channels: channels}} ->
      {Integer.to_string(ws_id),
       %{
         "level" => level_string(level),
         "channels" => Map.new(channels, fn {ch, l} -> {Integer.to_string(ch), level_string(l)} end)
       }}
    end)
  end
end
