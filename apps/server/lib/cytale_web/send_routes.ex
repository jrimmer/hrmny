defmodule CytaleWeb.SendRoutes do
  @moduledoc """
  The four message-SEND routes, recognized in one place:

    * native `POST /api/v1/channels/{id}/messages` (a body `thread_id` makes
      it a thread reply);
    * native `POST /api/v1/threads/{id}/messages`;
    * compat `POST /api/v10/channels/{id}/messages` and its bare `/api`
      alias, on a channel id or a thread id.

  All four run the one send pipeline (`Cytale.Messages.Send`). The plugs that
  treat sends differently from other requests ask this module, so a send
  route cannot be added to one of them and forgotten by another:

    * `CytaleWeb.Plugs.SendBudget` — the one send rate budget;
    * `CytaleWeb.Plugs.Idempotency` — steps aside for sends, whose retry key
      the pipeline's durable dedupe owns.
  """

  @typedoc "The dialect that renders the route's responses, and the path's target id."
  @type target :: {:native | :compat, String.t()}

  @doc """
  `{dialect, target_id}` for a send request, `nil` for anything else.
  `target_id` is the path's channel or thread id, unparsed (the route
  validates it; a malformed id still names ONE conversation for budgeting).
  """
  @spec target(Plug.Conn.t()) :: target() | nil
  def target(%Plug.Conn{method: "POST", path_info: path_info}), do: target_of(path_info)
  def target(_conn), do: nil

  @doc "Is this request one of the four send routes?"
  @spec send_route?(Plug.Conn.t()) :: boolean()
  def send_route?(conn), do: target(conn) != nil

  defp target_of(["api", "v1", "channels", id, "messages"]), do: {:native, id}
  defp target_of(["api", "v1", "threads", id, "messages"]), do: {:native, id}
  defp target_of(["api", "v10", "channels", id, "messages"]), do: {:compat, id}
  defp target_of(["api", "channels", id, "messages"]), do: {:compat, id}
  defp target_of(_path_info), do: nil
end
