defmodule CytaleWeb.RequireVerifiedFlagTest do
  @moduledoc """
  CYTALE_REQUIRE_VERIFIED=false lifts the view-only gate for deploys with no
  working mailer adapter: unverified accounts pass RequireVerified, and
  effective verification reports true. Default (unset/true) is unchanged.
  """

  use Cytale.ScyllaCase, async: false

  @endpoint CytaleWeb.Endpoint

  alias Cytale.Config

  setup do
    on_exit(fn -> Application.delete_env(:cytale, :require_verified_email) end)
    :ok
  end

  describe "effective_verified?/1" do
    test "default flag: stored verification state is the truth" do
      refute Config.effective_verified?(false)
      assert Config.effective_verified?(true)
    end

    test "flag off: every account is effectively verified" do
      Application.put_env(:cytale, :require_verified_email, false)
      assert Config.effective_verified?(false)
      assert Config.effective_verified?(true)
      assert Config.require_verified_email?() == false
    end
  end

  describe "RequireVerified plug under flag-off" do
    test "an unverified account's token passes the gate on a gated route" do
      Application.put_env(:cytale, :require_verified_email, false)

      conn =
        build_conn()
        |> put_req_header("authorization", "Bearer unverified-token")
        |> post("/api/v1/channels/9007199254740993/messages", %{content: "hi"})

      # 403 account_unverified must NOT appear — the gate is lifted. (The
      # channel id is unknown to this store, so any other status from the
      # route itself is acceptable.)
      refute conn.status == 403 and conn.resp_body =~ "account_unverified"
    end
  end
end
