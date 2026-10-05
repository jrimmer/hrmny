defmodule Cytale.Notifications.DeliveryAuthorNameTest do
  @moduledoc """
  A push is titled by its sender the way the app names them (2026-10-02): a
  webhook message by the name it posted under — never the account behind the
  webhook — and everyone else (people and bots) by their account.
  """

  use Cytale.ScyllaCase, async: false

  alias Cytale.Accounts.User
  alias Cytale.Notifications.Delivery.Push

  defp run_unique(base), do: base <> "r" <> Cytale.TestNonce.get()

  test "a webhook message is named by its per-message identity; an account by its display name" do
    {:ok, user} = User.create(run_unique("an"), run_unique("an@example.com"), "password-123")

    assert Push.author_name_for(%{"author_override" => %{"username" => "CI Hook"}}, user.user_id) == "CI Hook"
    assert Push.author_name_for(%{}, user.user_id) == user.username
    assert Push.author_name_for(%{"author_override" => %{"username" => ""}}, user.user_id) == user.username
    assert Push.author_name_for(%{}, nil) == nil
  end
end
