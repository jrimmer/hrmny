defmodule CytaleWeb.FilterParametersTest do
  @moduledoc """
  Tier 3 (B) finding 12b — secrets and message bodies never reach Phoenix's
  request log: every key CONTAINING a filtered word is `[FILTERED]`.
  """

  use ExUnit.Case, async: true

  test "credentials, codes and message content are filtered; ordinary params are not" do
    params = %{
      "password" => "p",
      "new_password" => "p",
      "token" => "t",
      "refresh_token" => "t",
      "resume_token" => "t",
      "content" => "a private message",
      "secret" => "s",
      "code" => "123456",
      "invite_code" => "abc",
      "grant" => "g",
      "name" => "general",
      "limit" => "50"
    }

    filtered = Phoenix.Logger.filter_values(params)

    for key <- Map.keys(params) -- ["name", "limit"] do
      assert filtered[key] == "[FILTERED]", "#{key} reached the log"
    end

    assert filtered["name"] == "general"
    assert filtered["limit"] == "50"
  end
end
