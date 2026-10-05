defmodule Cytale.Notifications.DeliveryChannelNamesTest do
  @moduledoc """
  A push preview names a referenced channel (`<#id>`) only when the RECIPIENT
  may see it — the app would show them `#unknown-channel` otherwise, and the
  notification must not disclose more than the app does.
  """

  use Cytale.ScyllaCase, async: false

  alias Cytale.Accounts.User
  alias Cytale.Notifications.Delivery.Push
  alias Cytale.Permissions.Bitfield
  alias Cytale.Workspaces

  defp run_unique(base), do: base <> "r" <> Cytale.TestNonce.get()

  test "visible channels are named; a hidden or unknown one is left out" do
    {:ok, owner} = User.create(run_unique("cn"), run_unique("cn@example.com"), "password-123")
    {:ok, member} = User.create(run_unique("cm"), run_unique("cm@example.com"), "password-123")
    {:ok, ws} = Workspaces.create_workspace(owner.user_id, run_unique("cn-ws"))
    :ok = Workspaces.add_member(ws.workspace_id, member.user_id, owner.user_id)
    {:ok, open} = Workspaces.create_channel(ws.workspace_id, run_unique("open"))
    {:ok, hidden} = Workspaces.create_channel(ws.workspace_id, run_unique("hidden"))
    Workspaces.put_overwrite(hidden.channel_id, :member, member.user_id, 0, Bitfield.bit(:view_channel))

    content = "see <##{open.channel_id}> and <##{hidden.channel_id}> and <#12345>"

    assert Push.channel_names_for(content, member.user_id) == %{open.channel_id => open.name}

    # The owner can see both.
    assert Push.channel_names_for(content, owner.user_id) == %{
             open.channel_id => open.name,
             hidden.channel_id => hidden.name
           }

    assert Push.channel_names_for(content, nil) == %{}
  end
end
