defmodule Cytale.Interactions do
  @moduledoc """
  Bots plan U8 (KTD13) — the interactions context: workspace-scoped
  application commands + the interaction lifecycle.

    * **Commands** live in `application_commands` (workspace, application,
      command) — registered over the compat applications routes by the bot
      itself (binding + workspace-rights checks live in the compat
      controller; this module owns validation and storage). CHAT_INPUT names
      follow Discord's regex `^[-_\\p{L}\\p{N}]{1,32}$` AND must be
      lowercase; `options` ride verbatim as JSON (store-and-forward, like
      embeds). Bulk upsert (`:replace`) is Discord's PUT semantics — the
      payload IS the application's command set (surviving names keep their
      ids); `:merge` is the single-create POST.
    * **Invocation** (`invoke/4`, the native endpoint U9's composer calls)
      checks the HUMAN caller's send right on the target channel through the
      one principal-rights resolver, mints a snowflake interaction id + an
      opaque token into the ETS store (15-minute life), and returns the
      native `InteractionCreate` payload for the controller to fan out to
      the bot's user key. A command whose NAME is gated (`invite` — #134)
      additionally demands `manage_workspace` of the acting principal,
      enforced HERE at invocation: the stored command object has no Discord
      `default_member_permissions` counterpart, so the authority cannot ride
      the registration.
    * **Component clicks** (`invoke_component/5`, components plan U2 — the
      provenance swap: one mint machinery, two provenances, KTD2) resolve
      `(channel, message)` → the message's CURRENT stored components (the
      R3 membership check) → the owning bot (the message's author) →
      liveness → the HUMAN clicker gate, then mint the same 15-minute
      credential with `{message_id, custom_id, component_type, values}` in
      the token's data map (never the TokenStore 3-tuple).
    * **Callback verification** (`verify_callback/2`): the URL token is the
      credential — unknown/expired/purged tokens all fail; revocation of the
      bot principal purges its outstanding tokens (derivative credentials
      die with the primary).

  The response path (posting the bot's callback message through the
  resolver-gated create) lives in `CytaleWeb.InteractionController` beside
  the other message-creation surfaces.
  """

  alias Cytale.Accounts.Principals
  alias Cytale.Interactions.TokenStore
  alias Cytale.Messages
  alias Cytale.Permissions.Bitfield
  alias Cytale.Permissions.Principal
  alias Cytale.Repo
  alias Cytale.Workspaces

  @typedoc "A stored application command (options already decoded from JSON)."
  @type command :: %{
          workspace_id: integer(),
          application_id: integer(),
          command_id: integer(),
          name: String.t(),
          description: String.t(),
          options: term() | nil,
          created_at: DateTime.t() | nil
        }

  @typedoc "Claims of the invoking human (the native auth plug shape)."
  @type claims :: %{
          required(:user_id) => integer(),
          required(:username) => String.t(),
          optional(:kind) => atom() | nil,
          optional(:verified) => boolean()
        }

  # Discord's CHAT_INPUT name rule (KTD13): `^[-_\p{L}\p{N}]{1,32}$`, lowercase.
  @name_re ~r/^[-_\p{L}\p{N}]{1,32}$/u
  @max_description 100
  @max_options_bytes 8 * 1024
  @max_invocation_options_bytes 4 * 1024

  # Components plan U2 (R3): the only interactive component types minted
  # (R4 — anything else is a 400 at ingress, never an interaction).
  @component_type_button 2
  @component_type_string_select 3
  @component_type_text_input 4

  # Modal caps (#30, Discord's modal + text-input reference).
  @max_custom_id_chars 100
  @max_modal_title 45
  @max_modal_rows 5
  @max_input_label 45
  @max_input_length 4000
  @max_input_placeholder 100
  @max_select_value_chars 100
  @max_values_bytes 4 * 1024

  # ---------------------------------------------------------------------------
  # Command registration
  # ---------------------------------------------------------------------------

  @doc """
  Upsert an application's command set in a workspace.

  `mode`:

    * `:replace` — bulk (Discord's PUT): the payload IS the set; names absent
      from the payload are deleted, surviving names keep their command ids;
    * `:merge` — single create (Discord's POST): upserts the payload's
      commands, leaves siblings untouched.

  Returns `{:ok, stored_commands}` (input order) or `{:error,
  :invalid_commands}` — the caller renders Discord's 50035.
  """
  @spec upsert_commands(integer(), integer(), [map()], :replace | :merge) ::
          {:ok, [command()]} | {:error, :invalid_commands}
  def upsert_commands(workspace_id, application_id, commands, mode)
      when is_integer(workspace_id) and is_integer(application_id) and mode in [:replace, :merge] do
    with {:ok, parsed} <- parse_commands(commands) do
      existing = application_rows(workspace_id, application_id)
      existing_by_name = Map.new(existing, &{&1.name, &1})

      now = DateTime.utc_now() |> DateTime.truncate(:millisecond)

      stored =
        Enum.map(parsed, fn cmd ->
          command_id =
            case Map.get(existing_by_name, cmd.name) do
              %{command_id: id} -> id
              nil -> Cytale.Snowflake.next()
            end

          row = %{
            workspace_id: workspace_id,
            application_id: application_id,
            command_id: command_id,
            name: cmd.name,
            description: cmd.description,
            options: cmd.options,
            created_at: now
          }

          insert_command(row)
          row
        end)

      if mode == :replace do
        wanted = MapSet.new(parsed, & &1.name)

        for row <- existing, row.name not in wanted do
          delete_command(workspace_id, application_id, row.command_id)
        end
      end

      {:ok, stored}
    end
  end

  @doc "Every LIVE command in the workspace (all applications) — the composer list."
  @spec list_commands(integer()) :: [command()]
  def list_commands(workspace_id) when is_integer(workspace_id) do
    workspace_id
    |> workspace_rows()
    |> filter_live_applications()
    |> Enum.map(&row_to_command/1)
  end

  @doc """
  One command by id within a workspace (nil when absent or when its
  application principal is dead — a revoked/deleted bot's commands are not
  invokable). Matches on the RAW row and decodes only the matched command's
  options blob — the invocation path never pays Jason.decode for the
  workspace's other commands.
  """
  @spec get_command(integer(), integer()) :: command() | nil
  def get_command(workspace_id, command_id)
      when is_integer(workspace_id) and is_integer(command_id) do
    case Enum.find(workspace_rows(workspace_id), &(&1["command_id"] == command_id)) do
      nil ->
        nil

      row ->
        if application_live?(row["application_id"]),
          do: row_to_command(row),
          else: nil
    end
  end

  # Liveness: a command whose application principal row is gone (bot revoked
  # or deleted) is dead — hidden from the composer and uninvokable. One
  # batched principals read per list, not one per row.
  defp filter_live_applications(rows) do
    app_ids = rows |> MapSet.new(& &1["application_id"]) |> Enum.to_list()

    live =
      if app_ids == [] do
        MapSet.new()
      else
        Cytale.Accounts.Principals.exists_many?(app_ids)
        |> MapSet.new()
      end

    Enum.filter(rows, &MapSet.member?(live, &1["application_id"]))
  end

  defp application_live?(application_id) do
    Cytale.Accounts.Principals.get(application_id) != nil
  end

  # ---------------------------------------------------------------------------
  # Invocation
  # ---------------------------------------------------------------------------

  @doc """
  Invoke `command_id` in `channel_id` as `claims` (the human caller).

  Checks the caller's send right on the channel through the ONE resolver
  (parent∩restrictions semantics apply to machine callers identically),
  mints the interaction (snowflake id + opaque token, 15-minute ETS life),
  and returns `{:ok, %{interaction_id, token, payload}}` where `payload` is
  the native `InteractionCreate` dispatch — the CONTROLLER fans it to the
  bot's user key before answering.

  Errors: `:channel_not_found` | `:command_not_found` | `:forbidden` (no
  membership / no send right — never a membership oracle) |
  `:command_forbidden` (a NAME-gated command — `invite` — invoked without
  `manage_workspace`) | `:invalid_options`.
  """
  @spec invoke(claims(), integer(), integer(), map() | nil) ::
          {:ok, %{interaction_id: integer(), token: String.t(), payload: map()}}
          | {:error,
             :channel_not_found
             | :command_not_found
             | :forbidden
             | :command_forbidden
             | :invalid_options}
  def invoke(claims, command_id, channel_id, options \\ %{})
      when is_map(claims) and is_integer(command_id) and is_integer(channel_id) do
    with {:ok, channel} <- fetch_channel(channel_id),
         {:ok, command} <- fetch_command(channel.workspace_id, command_id),
         :ok <- check_send_right(claims, channel.workspace_id, channel_id),
         :ok <- check_command_gate(claims, channel.workspace_id, command),
         {:ok, options} <- invocation_options(options) do
      interaction_id = Cytale.Snowflake.next()
      token = generate_token()

      :ok =
        TokenStore.put(interaction_id, token, %{
          application_id: command.application_id,
          workspace_id: channel.workspace_id,
          channel_id: channel_id,
          command_id: command.command_id,
          command_name: command.name,
          invoked_by: %{user_id: claims.user_id, username: claims[:username]}
        })

      payload = %{
        "id" => Integer.to_string(interaction_id),
        "token" => token,
        "application_id" => Integer.to_string(command.application_id),
        "command" => %{
          "id" => Integer.to_string(command.command_id),
          "name" => command.name
        },
        "options" => options,
        "channel_id" => Integer.to_string(channel_id),
        "workspace_id" => Integer.to_string(channel.workspace_id),
        "user" => %{
          "id" => Integer.to_string(claims.user_id),
          "username" => claims[:username]
        }
      }

      {:ok, %{interaction_id: interaction_id, token: token, payload: payload}}
    else
      {:error, _} = error -> error
    end
  end

  @doc """
  Invoke a MESSAGE COMPONENT click (components plan U2, R3 — the provenance
  swap beside `invoke/4`: one mint machinery, two provenances, KTD2).

  The click resolves `(channel_id, message_id)` → the message's CURRENT
  stored components (the membership check: at least one stored component;
  the `(component_type, custom_id)` pair matches a stored NON-`disabled`
  component on that row; for selects, `values` is a list of strings ≤
  #{@max_select_value_chars} chars each, ⊆ that component's stored option
  values, and |values| within its min/max_values) → the owning bot (the
  message's author principal) → liveness (a revoked-and-deleted bot's
  buttons are inert, R8 — `:application_dead` fires BEFORE any mint) → the
  clicker gate (humans only: the kind-guard doctrine — machine principals
  cannot click; workspace channels require the send right through the ONE
  resolver, DM channels gate on human participation at channel resolution,
  the anti-oracle 404) → mint.

  The token data map (never the TokenStore 3-tuple) carries
  `{application_id, workspace_id (nil on DMs), channel_id, message_id,
  custom_id, component_type, values, thread_id (nil unless the clicked
  message is a thread reply), invoked_by}`; the native payload gains
  the `kind: "component"` discriminator (KTD9) + the component fields and
  embeds the clicked message row snapshot (the codec's `d.message` source —
  the join is already paid, the embed is free).

  Errors: `:channel_not_found` (unknown id, or a DM the clicker does not
  participate in — never an oracle) | `:message_not_found` |
  `:component_unavailable` (forged/stale/disabled custom_id, or a
  component-less message — the dead-air guard) | `:invalid_values` |
  `:application_dead` | `:forbidden` (machine clicker, no membership, or no
  send right).
  """
  @spec invoke_component(
          claims(),
          integer(),
          integer(),
          String.t(),
          2 | 3,
          [String.t()] | nil
        ) ::
          {:ok, %{interaction_id: integer(), token: String.t(), payload: map()}}
          | {:error,
             :channel_not_found
             | :message_not_found
             | :component_unavailable
             | :invalid_values
             | :application_dead
             | :forbidden}
  def invoke_component(claims, channel_id, message_id, custom_id, component_type, values \\ nil)
      when is_map(claims) and is_integer(channel_id) and is_integer(message_id) and is_binary(custom_id) and
             component_type in [@component_type_button, @component_type_string_select] do
    with {:ok, channel} <- fetch_channel(channel_id, claims),
         {:ok, message} <- fetch_message(channel_id, message_id),
         {:ok, component} <- membership_check(message, custom_id, component_type, values),
         {:ok, application} <- owning_application(message.author_id),
         :ok <- check_clicker(claims, channel, component) do
      interaction_id = Cytale.Snowflake.next()
      token = generate_token()

      # KTD2: the provenance rides the DATA MAP — the TokenStore row stays
      # the 3-tuple `{interaction_id, data_map, ack_count}`.
      :ok =
        TokenStore.put(interaction_id, token, %{
          application_id: application.user_id,
          workspace_id: channel.workspace_id,
          channel_id: channel_id,
          message_id: message_id,
          custom_id: custom_id,
          component_type: component_type,
          values: values || [],
          # A card inside a THREAD: every message the bot posts in answer
          # (type 4, followups, a deferred reply) lands back in the thread.
          # `channel_id` stays the parent — the storage partition and the
          # rights anchor (thread visibility rides the parent's rights).
          thread_id: message.thread_id,
          invoked_by: %{user_id: claims.user_id, username: claims[:username]}
        })

      payload =
        %{
          "id" => Integer.to_string(interaction_id),
          "token" => token,
          "application_id" => Integer.to_string(application.user_id),
          "kind" => "component",
          "channel_id" => Integer.to_string(channel_id),
          "user" => %{
            "id" => claims.user_id,
            "username" => claims[:username]
          },
          "custom_id" => custom_id,
          "component_type" => component_type,
          "message_id" => Integer.to_string(message_id),
          # The clicked row snapshot (components joined by the membership
          # read) — the compat codec's `d.message` source.
          "message" => message,
          # The owning bot's resolved channel bitfield (DM: the participation
          # full bitfield); the codec renders Discord's decimal string.
          "app_permissions" => application_permissions(application, channel)
        }
        |> maybe_values(values)
        |> maybe_workspace(channel.workspace_id)
        |> maybe_thread(message.thread_id)

      {:ok, %{interaction_id: interaction_id, token: token, payload: payload}}
    else
      {:error, _} = error -> error
    end
  end

  # ---------------------------------------------------------------------------
  # Modals (#30): callback type 9 in, MODAL_SUBMIT out
  # ---------------------------------------------------------------------------

  @doc """
  Validate a type-9 (MODAL) callback's `data` against Discord's shape:
  `custom_id` 1–#{@max_custom_id_chars} chars, `title` 1–#{@max_modal_title},
  and 1–#{@max_modal_rows} action rows, each holding EXACTLY one text input
  (`type: 4`) with a unique `custom_id`, `style` 1 (short) or 2 (paragraph),
  `label` 1–#{@max_input_label}, optional `min_length` 0–#{@max_input_length},
  `max_length` 1–#{@max_input_length} (min ≤ max), `required` (default
  true), a `value` prefill within the bounds, and `placeholder` ≤
  #{@max_input_placeholder}.

  Returns the NORMALIZED modal (defaults filled, unknown keys dropped) — the
  definition every submission is later checked against.
  """
  @spec validate_modal(term()) :: {:ok, map()} | {:error, :invalid_body}
  def validate_modal(%{"custom_id" => custom_id, "title" => title, "components" => rows})
      when is_list(rows) do
    with true <- id_ok?(custom_id),
         true <- is_binary(title) and String.length(title) in 1..@max_modal_title,
         true <- length(rows) in 1..@max_modal_rows,
         {:ok, inputs} <- modal_inputs(rows),
         true <- length(Enum.uniq_by(inputs, & &1["custom_id"])) == length(inputs) do
      {:ok,
       %{
         "custom_id" => custom_id,
         "title" => title,
         "components" => Enum.map(inputs, &%{"type" => 1, "components" => [&1]})
       }}
    else
      _ -> {:error, :invalid_body}
    end
  end

  def validate_modal(_), do: {:error, :invalid_body}

  defp id_ok?(id), do: is_binary(id) and String.length(id) in 1..@max_custom_id_chars

  defp modal_inputs(rows) do
    Enum.reduce_while(rows, {:ok, []}, fn
      %{"type" => 1, "components" => [%{"type" => @component_type_text_input} = input]}, {:ok, acc} ->
        case text_input(input) do
          {:ok, normalized} -> {:cont, {:ok, acc ++ [normalized]}}
          :error -> {:halt, :error}
        end

      _row, _acc ->
        {:halt, :error}
    end)
  end

  defp text_input(input) do
    min = Map.get(input, "min_length", 0)
    max = Map.get(input, "max_length", @max_input_length)
    required = Map.get(input, "required", true)
    value = input["value"]
    placeholder = input["placeholder"]

    valid? =
      id_ok?(input["custom_id"]) and input["style"] in [1, 2] and
        is_binary(input["label"]) and String.length(input["label"]) in 1..@max_input_label and
        is_integer(min) and min in 0..@max_input_length and
        is_integer(max) and max in 1..@max_input_length and min <= max and
        is_boolean(required) and
        (is_nil(value) or (is_binary(value) and String.length(value) <= max)) and
        (is_nil(placeholder) or (is_binary(placeholder) and String.length(placeholder) <= @max_input_placeholder))

    if valid? do
      {:ok,
       %{
         "type" => @component_type_text_input,
         "custom_id" => input["custom_id"],
         "style" => input["style"],
         "label" => input["label"],
         "min_length" => min,
         "max_length" => max,
         "required" => required
       }
       |> then(&if(is_nil(value), do: &1, else: Map.put(&1, "value", value)))
       |> then(&if(is_nil(placeholder), do: &1, else: Map.put(&1, "placeholder", placeholder)))}
    else
      :error
    end
  end

  @doc """
  Submit a modal (#30): the human `claims` answers the modal a bot opened on
  interaction `interaction_id`.

  Provenance, in order, all BEFORE anything is minted:

    * the modal exists, is unexpired, and was opened on an interaction THIS
      user invoked (`TokenStore.fetch_modal/2` — anyone else gets the same
      `:modal_unavailable`);
    * `custom_id` is the modal's own;
    * `components` answers EXACTLY the modal's inputs — every stored
      `custom_id` once, nothing extra — with string values that respect each
      input's `required`, `min_length`/`max_length` (graphemes), and a SHORT
      input holds no line break;
    * the owning bot is still alive (a revoked bot's modal dies, R8);
    * it has not been submitted before (`claim_modal/2` — single-use, and
      checked LAST so a rejected submission does not burn the modal).

  Mints a MODAL_SUBMIT interaction (`kind: "modal_submit"`, fresh id + token,
  the same TokenStore life) carrying the originating message when the modal
  came from a component click — so the bot may answer with 6/7 against it.
  """
  @spec submit_modal(claims(), integer(), String.t(), term()) ::
          {:ok, %{interaction_id: integer(), token: String.t(), payload: map()}}
          | {:error, :modal_unavailable | :invalid_submission | :application_dead | :channel_not_found}
  def submit_modal(claims, interaction_id, custom_id, components)
      when is_map(claims) and is_integer(interaction_id) do
    with {:ok, origin} <- TokenStore.fetch_modal(interaction_id, claims.user_id),
         :ok <- if(origin.modal["custom_id"] == custom_id, do: :ok, else: {:error, :modal_unavailable}),
         {:ok, answers} <- modal_answers(origin.modal, components),
         {:ok, application} <- owning_application(origin.application_id),
         {:ok, channel} <- fetch_channel(origin.channel_id, claims),
         :ok <- TokenStore.claim_modal(interaction_id, origin.expires_at_ms) do
      submit_id = Cytale.Snowflake.next()
      token = generate_token()
      message_id = Map.get(origin, :message_id)

      :ok =
        TokenStore.put(
          submit_id,
          token,
          %{
            application_id: application.user_id,
            workspace_id: channel.workspace_id,
            channel_id: origin.channel_id,
            thread_id: Map.get(origin, :thread_id),
            custom_id: custom_id,
            kind: :modal_submit,
            invoked_by: %{user_id: claims.user_id, username: claims[:username]}
          }
          |> then(&if(message_id, do: Map.put(&1, :message_id, message_id), else: &1))
        )

      payload =
        %{
          "id" => Integer.to_string(submit_id),
          "token" => token,
          "application_id" => Integer.to_string(application.user_id),
          "kind" => "modal_submit",
          "channel_id" => Integer.to_string(origin.channel_id),
          "user" => %{"id" => claims.user_id, "username" => claims[:username]},
          "custom_id" => custom_id,
          "components" =>
            Enum.map(answers, fn {input_id, value} ->
              %{
                "type" => 1,
                "components" => [%{"type" => @component_type_text_input, "custom_id" => input_id, "value" => value}]
              }
            end),
          "app_permissions" => application_permissions(application, channel)
        }
        |> maybe_workspace(channel.workspace_id)
        |> maybe_thread(Map.get(origin, :thread_id))
        |> maybe_origin_message(origin.channel_id, message_id)

      {:ok, %{interaction_id: submit_id, token: token, payload: payload}}
    end
  end

  def submit_modal(_claims, _interaction_id, _custom_id, _components), do: {:error, :modal_unavailable}

  # The submission must answer the stored inputs exactly, in the modal's own
  # order (the order the bot will read them back in).
  defp modal_answers(%{"components" => rows}, components) when is_list(components) do
    stored = Enum.map(rows, fn %{"components" => [input]} -> input end)

    submitted =
      Enum.reduce_while(components, %{}, fn
        %{"components" => [%{"custom_id" => id, "value" => value}]}, acc
        when is_binary(id) and is_binary(value) and not is_map_key(acc, id) ->
          {:cont, Map.put(acc, id, value)}

        _, _acc ->
          {:halt, :error}
      end)

    with %{} <- submitted,
         true <- map_size(submitted) == length(stored),
         true <- Enum.all?(stored, &answer_ok?(&1, Map.get(submitted, &1["custom_id"]))) do
      {:ok, Enum.map(stored, &{&1["custom_id"], Map.fetch!(submitted, &1["custom_id"])})}
    else
      _ -> {:error, :invalid_submission}
    end
  end

  defp modal_answers(_modal, _components), do: {:error, :invalid_submission}

  defp answer_ok?(_input, nil), do: false

  defp answer_ok?(input, value) do
    length = String.length(value)

    cond do
      input["style"] == 1 and String.contains?(value, ["\n", "\r"]) -> false
      value == "" -> not input["required"]
      true -> length >= input["min_length"] and length <= input["max_length"]
    end
  end

  # A modal opened from a component click keeps its message: the payload
  # carries it (discord.js exposes `interaction.message` on a submit from a
  # message) and the token's data map lets the bot's 6/7 target it.
  defp maybe_origin_message(payload, _channel_id, nil), do: payload

  defp maybe_origin_message(payload, channel_id, message_id) do
    payload = Map.put(payload, "message_id", Integer.to_string(message_id))

    case fetch_message(channel_id, message_id) do
      {:ok, message} -> Map.put(payload, "message", message)
      _ -> payload
    end
  end

  # ---------------------------------------------------------------------------
  # Callback credential surface
  # ---------------------------------------------------------------------------

  @doc """
  Verify a callback credential pair. `{:ok, data}` carries the interaction's
  stored context (application_id / workspace_id / channel_id + provenance);
  failures are `:unknown_interaction | :expired | :bad_token` — the caller
  renders the Discord 401 without distinguishing them on the wire.
  """
  @spec verify_callback(integer(), String.t()) ::
          {:ok, map()} | {:error, :unknown_interaction | :expired | :bad_token}
  def verify_callback(interaction_id, token)
      when is_integer(interaction_id) and is_binary(token) do
    TokenStore.fetch(interaction_id, token)
  end

  @doc """
  Consume the interaction's SINGLE-USE ack (C-1, Discord parity): the first
  type-4 callback post owns the interaction's reply — this is the atomic
  check-and-set. `:ok` means THIS caller posted the ack;
  `{:error, :ack_consumed}` means a type-4 already answered (the caller
  renders Discord's `10063 Unknown interaction`); the other errors mirror
  `verify_callback/2`. Followups never call this — the ack slot only moves
  for typed responses.
  """
  @spec consume_callback_ack(integer(), String.t()) ::
          :ok | {:error, :ack_consumed | :bad_token | :unknown_interaction}
  def consume_callback_ack(interaction_id, token)
      when is_integer(interaction_id) and is_binary(token) do
    TokenStore.consume_ack(interaction_id, token)
  end

  @doc """
  Merge `fields` into the token's stored DATA MAP (components plan U3 —
  the per-token continuation state: `acked_as` records which FLOW consumed
  the ack (reply vs update), `response_message_id` records the first posted
  response — the `@original` target for reply flows). The TokenStore row
  stays the 3-tuple; ONLY the data map ever extends.
  """
  @spec merge_callback_data(integer(), String.t(), map()) ::
          :ok | {:error, :unknown_interaction | :bad_token}
  def merge_callback_data(interaction_id, token, fields)
      when is_integer(interaction_id) and is_binary(token) and is_map(fields) do
    TokenStore.merge_data(interaction_id, token, fields)
  end

  @doc """
  Resolve an outstanding interaction by its token ALONE (components plan
  U3, KTD5): the webhook-shaped continuation routes
  (`/webhooks/{application_id}/{token}` + `…/messages/@original`) carry no
  interaction id segment — the token is the whole credential. Returns
  `{:ok, interaction_id, data}` (the same verified data map the callback
  route reads) or `:unknown_interaction` (never minted, expired, swept, or
  purged by revocation — rendered exactly as the callback's 401).
  """
  @spec resolve_by_token(String.t()) :: {:ok, integer(), map()} | {:error, :unknown_interaction}
  def resolve_by_token(token) when is_binary(token), do: TokenStore.resolve_by_token(token)

  # ---------------------------------------------------------------------------
  # Validation internals
  # ---------------------------------------------------------------------------

  defp parse_commands(commands) when is_list(commands) do
    parsed = Enum.map(commands, &parse_command/1)

    if Enum.all?(parsed, &match?({:ok, _}, &1)) do
      commands = Enum.map(parsed, &elem(&1, 1))

      names = Enum.map(commands, & &1.name)

      if length(names) == length(Enum.uniq(names)),
        do: {:ok, commands},
        else: {:error, :invalid_commands}
    else
      {:error, :invalid_commands}
    end
  end

  defp parse_commands(_), do: {:error, :invalid_commands}

  defp parse_command(%{"name" => name, "description" => description} = body)
       when is_map(body) do
    with {:ok, name} <- valid_name(name),
         :ok <- valid_description(description),
         {:ok, options} <- valid_options(body["options"]) do
      {:ok, %{name: name, description: description, options: options}}
    else
      _ -> {:error, :invalid_commands}
    end
  end

  defp parse_command(_), do: {:error, :invalid_commands}

  defp valid_name(name) when is_binary(name) do
    if Regex.match?(@name_re, name) and name == String.downcase(name),
      do: {:ok, name},
      else: {:error, :invalid_name}
  end

  defp valid_name(_), do: {:error, :invalid_name}

  defp valid_description(description) when is_binary(description),
    do: if(String.length(description) in 1..@max_description, do: :ok, else: {:error, :invalid_description})

  defp valid_description(_), do: {:error, :invalid_description}

  # Options ride verbatim (Discord's option-definition array; a plain map is
  # accepted too for hand-rolled clients) — bounded in bytes only.
  defp valid_options(nil), do: {:ok, nil}

  defp valid_options(options) when is_map(options) or is_list(options) do
    encoded = Jason.encode!(options)

    if byte_size(encoded) <= @max_options_bytes,
      do: {:ok, options},
      else: {:error, :invalid_options}
  rescue
    _ -> {:error, :invalid_options}
  end

  defp valid_options(_), do: {:error, :invalid_options}

  # The invocation body's options: a flat JSON map of name → value.
  defp invocation_options(nil), do: {:ok, %{}}

  defp invocation_options(options) when is_map(options) do
    encoded = Jason.encode!(options)

    if byte_size(encoded) <= @max_invocation_options_bytes,
      do: {:ok, options},
      else: {:error, :invalid_options}
  rescue
    _ -> {:error, :invalid_options}
  end

  defp invocation_options(_), do: {:error, :invalid_options}

  # The R3 membership check: the click is verified against the message's
  # CURRENT stored components (provenance verification, not interpretation —
  # `custom_id` is never parsed, only matched). A component-less message
  # mints nothing (the dead-air guard), and only a stored NON-`disabled`
  # component with the exact `(component_type, custom_id)` pair passes —
  # forged custom_ids, stale-open-select races, and resolved cards all die
  # here, BEFORE any token exists.
  defp membership_check(%{components: components}, custom_id, component_type, values)
       when is_list(components) and components != [] do
    component =
      components
      |> Enum.flat_map(fn row -> row["components"] || [] end)
      |> Enum.find(&(&1["type"] == component_type and &1["custom_id"] == custom_id))

    case component do
      nil ->
        {:error, :component_unavailable}

      %{"disabled" => true} ->
        {:error, :component_unavailable}

      %{} = component when component_type == @component_type_string_select ->
        select_values_check(component, values)

      %{} = component ->
        # Buttons carry no values (a non-empty values list on a button click
        # is a malformed body, not a mint).
        if values in [nil, []], do: {:ok, component}, else: {:error, :invalid_values}
    end
  end

  defp membership_check(_, _, _, _), do: {:error, :component_unavailable}

  # Selects: `values` must be a list of strings ≤ @max_select_value_chars
  # chars each, ⊆ the component's stored option values, ≤ @max_values_bytes
  # serialized, |values| within its min/max_values (Discord defaults 1/1), and
  # no value twice — a multi-pick (#30) is a SET of options.
  defp select_values_check(component, nil), do: select_values_check(component, [])

  defp select_values_check(component, values) when is_list(values) do
    option_values = component["options"] |> Enum.map(& &1["value"]) |> MapSet.new()
    min = component["min_values"] || 1
    max = component["max_values"] || 1

    cond do
      not Enum.all?(values, &is_binary/1) ->
        {:error, :invalid_values}

      not Enum.all?(values, &(String.length(&1) <= @max_select_value_chars)) ->
        {:error, :invalid_values}

      byte_size(Jason.encode!(values)) > @max_values_bytes ->
        {:error, :invalid_values}

      not Enum.all?(values, &MapSet.member?(option_values, &1)) ->
        {:error, :invalid_values}

      length(Enum.uniq(values)) != length(values) ->
        {:error, :invalid_values}

      length(values) not in min..max ->
        {:error, :invalid_values}

      true ->
        {:ok, component}
    end
  end

  defp select_values_check(_component, _non_list), do: {:error, :invalid_values}

  # Native-payload optional keys: values ride only when non-empty; the
  # workspace key is OMITTED on DM clicks (the member-vs-user discriminator
  # the codec consumes).
  defp maybe_values(payload, values) when is_list(values) and values != [],
    do: Map.put(payload, "values", values)

  defp maybe_values(payload, _), do: payload

  defp maybe_workspace(payload, nil), do: payload
  defp maybe_workspace(payload, workspace_id), do: Map.put(payload, "workspace_id", Integer.to_string(workspace_id))

  # A component interaction on a THREAD message names the thread (additive
  # key, absent otherwise): `channel_id` stays the parent — the native
  # fan-out and rights anchor — and the compat codec renders the thread id
  # as Discord's `channel_id` (threads are channels, C-2).
  defp maybe_thread(payload, thread_id) when is_integer(thread_id),
    do: Map.put(payload, "thread_id", Integer.to_string(thread_id))

  defp maybe_thread(payload, _), do: payload

  # ---------------------------------------------------------------------------
  # Authorization
  # ---------------------------------------------------------------------------

  # The invoking caller's SEND right on the target channel, through the ONE
  # resolver (parent∩restrictions for machine callers identically). An
  # unknown workspace never leaks past the channel gate (anti-oracle 404).
  defp check_send_right(claims, workspace_id, channel_id) do
    case Principal.resolve(workspace_id, claims, channel_id) do
      {:ok, bits} ->
        if Bitfield.has?(bits, :send_messages), do: :ok, else: {:error, :forbidden}

      {:error, :not_found} ->
        {:error, :channel_not_found}

      {:error, :forbidden} ->
        {:error, :forbidden}
    end
  end

  # The invocation-side command gate (#134). A registered command is ONE
  # shared object every member of the workspace sees, so its AUTHORITY is
  # checked at INVOCATION against the acting principal — the serializer
  # stores no Discord `default_member_permissions` (the compat command
  # object's recorded divergence: no stored counterpart), so the gate cannot
  # ride the registration row. Keyed by NAME — it applies to any
  # application's command with that name, exactly as Discord's
  # default_member_permissions would:
  #
  #   * `invite` mints workspace invites — the acting principal needs
  #     `manage_workspace` (the owner's direction on #134; deliberately
  #     stricter than today's REST invite-create, which gates on bare
  #     membership). Resolved at WORKSPACE scope (channel nil) through the
  #     one resolver; every failure is the same :command_forbidden — the
  #     gate is not a membership oracle.
  #
  # Every OTHER command needs only what check_send_right/3 already verified
  # — the @-mention precedent: invoking the agent where you can speak asks
  # nothing more of you.
  defp check_command_gate(claims, workspace_id, %{name: "invite"}) do
    case Principal.resolve(workspace_id, claims, nil) do
      {:ok, bits} ->
        if Bitfield.has?(bits, :manage_workspace), do: :ok, else: {:error, :command_forbidden}

      {:error, _} ->
        {:error, :command_forbidden}
    end
  end

  defp check_command_gate(_claims, _workspace_id, _command), do: :ok

  # The component clicker gate (R3, KD2). Clicks are a HUMAN input primitive
  # — the kind-guard doctrine extends the no bot↔bot DM decision of record:
  # machine principals cannot click (a bot clicking bots would ping-pong
  # autonomous clients with no human watching). Past the kind guard:
  # workspace channels require the send right (the invoke precedent — a
  # read-only channel's approval cards are unclickable, KD2's documented
  # trade-off); DM participation was already decided at channel resolution.
  defp check_clicker(%{kind: kind}, _channel, _component) when kind in [:bot, :agent, :webhook],
    do: {:error, :forbidden}

  # DM channels: participation IS authorization (the channel-gate precedent)
  # — already checked in fetch_channel's DM leg; only humans reach here.
  defp check_clicker(_claims, %{workspace_id: nil}, _component), do: :ok

  defp check_clicker(claims, %{workspace_id: workspace_id, channel_id: channel_id}, _component),
    do: check_send_right(claims, workspace_id, channel_id)

  # The owning application of a component message: the message's AUTHOR
  # principal, live and of an interactive kind. A deleted bot's principal row
  # is gone (application_live? semantics) — its buttons are inert (R8), the
  # distinct dead-button error, BEFORE any mint. Humans/webhooks can never
  # own stored interactive components by construction (U1: Bot-auth surfaces
  # only); failing closed here is defense-in-depth for store-level forgeries.
  defp owning_application(author_id) do
    case Principals.get(author_id) do
      %{kind: kind} = principal when kind in [:bot, :agent] -> {:ok, principal}
      _ -> {:error, :application_dead}
    end
  end

  # The owning bot's effective channel bitfield — the `app_permissions` the
  # type-3 payload rides (metadata only; the bot's RIGHTS gate its callback,
  # not the mint). DMs carry the full participation bitfield (the dm_gate
  # precedent); a resolver miss (e.g. the bot restricted out after posting)
  # renders 0, never a failure — buttons die with rights on UPDATE (KD3), not
  # at ingress.
  defp application_permissions(_principal, %{workspace_id: nil}),
    do: Bitfield.all()

  defp application_permissions(principal, %{workspace_id: workspace_id, channel_id: channel_id}) do
    case Principal.resolve(workspace_id, Principals.claims(principal), channel_id) do
      {:ok, bits} -> bits
      _ -> 0
    end
  end

  # ---------------------------------------------------------------------------
  # Storage
  # ---------------------------------------------------------------------------

  # Channel resolution for the two provenances: workspace channels today, and
  # the DM leg (components plan U2) when a CLICKER is supplied. `clicker`
  # decides DM admission — participation IS authorization (the channel-gate
  # precedent, B-1), and a NON-participant gets the identical
  # :channel_not_found as an unknown id (the anti-oracle 404 — it must not
  # learn the DM exists). Command invocation (clicker nil) keeps the
  # channels_by_id-only view: commands are workspace-scoped.
  defp fetch_channel(channel_id, clicker \\ nil) do
    case Workspaces.get_channel(channel_id) do
      %{workspace_id: workspace_id} ->
        {:ok, %{channel_id: channel_id, workspace_id: workspace_id}}

      nil ->
        fetch_dm_channel(channel_id, clicker)
    end
  end

  defp fetch_dm_channel(_channel_id, nil), do: {:error, :channel_not_found}

  defp fetch_dm_channel(channel_id, clicker) do
    case Workspaces.get_dm(channel_id) do
      nil ->
        {:error, :channel_not_found}

      dm ->
        if Workspaces.dm_participant?(dm, clicker.user_id),
          do: {:ok, %{channel_id: channel_id, workspace_id: nil}},
          else: {:error, :channel_not_found}
    end
  end

  defp fetch_message(channel_id, message_id) do
    case Messages.get_message(channel_id, message_id) do
      nil -> {:error, :message_not_found}
      message -> {:ok, message}
    end
  end

  defp fetch_command(workspace_id, command_id) do
    case get_command(workspace_id, command_id) do
      nil -> {:error, :command_not_found}
      command -> {:ok, command}
    end
  end

  defp insert_command(row) do
    Repo.execute!(
      "INSERT INTO {{K}}.application_commands (workspace_id, application_id, command_id, name, description, options, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [
        {"bigint", row.workspace_id},
        {"bigint", row.application_id},
        {"bigint", row.command_id},
        {"text", row.name},
        {"text", row.description},
        {"text", row.options && Jason.encode!(row.options)},
        {"timestamp", row.created_at}
      ]
    )

    :ok
  end

  defp delete_command(workspace_id, application_id, command_id) do
    Repo.execute!(
      "DELETE FROM {{K}}.application_commands WHERE workspace_id = ? AND application_id = ? AND command_id = ?",
      [
        {"bigint", workspace_id},
        {"bigint", application_id},
        {"bigint", command_id}
      ]
    )

    :ok
  end

  defp workspace_rows(workspace_id) do
    Repo.execute!(
      "SELECT workspace_id, application_id, command_id, name, description, options, created_at FROM {{K}}.application_commands WHERE workspace_id = ?",
      [{"bigint", workspace_id}]
    )
    |> Enum.to_list()
  end

  defp application_rows(workspace_id, application_id) do
    Repo.execute!(
      "SELECT workspace_id, application_id, command_id, name, description, options, created_at FROM {{K}}.application_commands WHERE workspace_id = ? AND application_id = ?",
      [{"bigint", workspace_id}, {"bigint", application_id}]
    )
    |> Enum.to_list()
    |> Enum.map(&row_to_command/1)
  end

  defp row_to_command(row) do
    %{
      workspace_id: row["workspace_id"],
      application_id: row["application_id"],
      command_id: row["command_id"],
      name: row["name"],
      description: row["description"],
      options: decode_options(row["options"]),
      created_at: row["created_at"]
    }
  end

  defp decode_options(nil), do: nil

  defp decode_options(text) when is_binary(text) do
    case Jason.decode(text) do
      {:ok, decoded} -> decoded
      _ -> nil
    end
  end

  # Opaque URL-safe credential (matches the resume-token discipline: strong
  # randomness, never derived from the interaction id).
  defp generate_token do
    Base.url_encode64(:crypto.strong_rand_bytes(32), padding: false)
  end
end
