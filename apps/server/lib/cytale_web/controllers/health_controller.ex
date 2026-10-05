defmodule CytaleWeb.HealthController do
  @moduledoc """
  Two probes, deliberately different (#87):

    * `GET /health` — **liveness**: 200 once the node can serve HTTP at all. It
      consults no dependency, which is what makes it right for a container
      restart policy and WRONG to wire a monitor to: the deploy health-gate uses
      it, so a release passes with ScyllaDB down.
    * `GET /health/ready` — **readiness**: 200 only when a member could actually
      read a message (one cheap CQL round trip; deeper checks layer on here as
      they earn their cost), 503 with per-check detail otherwise. This is the
      URL an off-box prober should hit.

  Both are unauthenticated on purpose: a probe that needs a credential fails on
  the day the credential expires, and neither discloses more than up/not-up plus
  the name of the failing check. The payloads deliberately carry NO node
  identity (#125, owner call 2026-09-20): `node()` names the Erlang node, which
  is implementation detail an internet-facing liveness probe has no business
  publishing — the gated /metrics surface is where operational identifiers live.
  """

  use CytaleWeb, :controller

  @doc "Liveness: the node serves HTTP. Consults nothing — see the moduledoc."
  def show(conn, _params) do
    json(conn, %{
      status: "ok",
      version: Application.spec(:cytale, :vsn) |> to_string()
    })
  end

  @doc """
  Readiness: does this node have what a request needs?

  503 (not 500) when a dependency is down — the service is up and saying so,
  which is the distinction a prober needs to alert on the right thing. The
  failing check is named in the body so an alert's annotation is useful without
  a shell on the box.
  """
  def ready(conn, _params) do
    checks = %{"scylla" => scylla_check()}
    ok? = Enum.all?(checks, fn {_name, check} -> check["status"] == "ok" end)

    conn
    |> put_status(if(ok?, do: 200, else: 503))
    |> put_resp_header("cache-control", "no-store")
    |> json(%{
      status: if(ok?, do: "ok", else: "degraded"),
      version: Application.spec(:cytale, :vsn) |> to_string(),
      checks: checks
    })
  end

  # One point read against a system table: the cheapest thing that proves the
  # cluster is ANSWERING QUERIES, not merely holding a TCP connection (a socket
  # check passes while a booting node answers nothing).
  #
  # Injectable, because "the probe fails when the database is down" is a claim
  # that deserves a test, and no test should have to stop ScyllaDB to make it.
  defp scylla_check do
    check = Application.get_env(:cytale, :readiness_scylla_check, &default_scylla_check/0)

    case check.() do
      :ok -> %{"status" => "ok"}
      {:error, reason} -> %{"status" => "error", "error" => inspect(reason)}
    end
  end

  defp default_scylla_check do
    _ =
      Cytale.Repo.execute!("SELECT release_version FROM system.local")
      |> Enum.take(1)

    :ok
  rescue
    e -> {:error, Exception.message(e)}
  end

  @doc """
  SPA fallback (deploy): serve the built web client's index.html for any
  unmatched GET, carrying the content-free share card (#118). Client-side hash
  routing owns navigation past /#/; API scopes match earlier in the router so
  their JSON 404s are unaffected.

  ## The two spellings a permalink arrives in, and why both land HERE

  * `https://…/m/{token}` — the copied form since #118 (option B). A real
    PATH, so the server does receive it; the SPA reads the token off it,
    resolves it over `GET /api/v1/permalinks/{token}` and continues on the
    ordinary `#/…message/…` route.
  * `https://…/#/workspace/{ws}/channel/{ch}/message/{mid}` — the #114
    spelling (decimal or base62 ids), which stays supported forever because
    it is already in circulation. Its address lives in the FRAGMENT, and an
    HTTP request never carries one: a platform unfurling it fetches the origin
    root.

  Both are unmatched GETs, so both are answered right here, and neither
  branches the response: this *is* the permalink's HTML, and there is no
  request on which the card would be "the permalink's" more than on any other.

  ## And why it is content-free

  An unfurl is fetched by the RECEIVING platform, unauthenticated, so anything
  in those tags is public. That is not merely a convention about crawlers: the
  server genuinely cannot tell a signed-in reader from a stranger on THIS
  request. Web access tokens are memory-only (never a cookie), so a signed-in
  SPA's document request carries no credential — its authenticated reads are
  separate XHRs that this fallback never sees. The card is therefore a
  CONSTANT: no message text, no author, no channel name, no workspace name —
  and deliberately nothing derived from the request either (not the token, not
  the path, not the host), so no input exists by which a private workspace
  could reach it, and two different permalinks answer byte-identically. A rich
  card is only possible for content that is public on purpose, which is the
  external-share feature #118 keeps out of scope. The leak rule is asserted in
  `test/cytale_web/spa_share_card_test.exs` for both spellings.
  """
  def spa(conn, params) do
    if Enum.at(params["path"] || [], 0) == "api" do
      # Never serve HTML for API paths — keep the JSON error envelope.
      conn
      |> put_status(404)
      |> json(%{error: %{key: "not_found", code: 40_404, message: "No such route"}})
    else
      conn
      |> put_resp_header("cache-control", "no-cache")
      |> put_resp_header("content-type", "text/html; charset=utf-8")
      |> send_resp(200, index_html() |> inject_share_card())
    end
  end

  # The shell, read through an injectable reader exactly like the readiness
  # check above: `priv/static` is a BUILD ARTIFACT (gitignored), so a test
  # checkout has no index.html and the fallback's contract would otherwise be
  # untestable. The default is the real deployed file.
  defp index_html do
    reader = Application.get_env(:cytale, :spa_index_reader, &default_index_html/0)
    reader.()
  end

  defp default_index_html do
    Application.app_dir(:cytale, "priv/static/index.html") |> File.read!()
  end

  # The card itself: app name, "a message in a private workspace", a sign-in
  # hint. Every value is a literal (see the doc above for why that matters).
  @share_card """
  <!-- #118: the content-free share card. Public by construction — unfurls are
       fetched unauthenticated — so it names the app and NOTHING else. -->
  <meta property="og:site_name" content="Hrmny" />
  <meta property="og:title" content="A message in a private workspace" />
  <meta property="og:description" content="Sign in to Hrmny to view it." />
  <meta property="og:type" content="website" />
  <meta name="twitter:card" content="summary" />
  <meta name="twitter:title" content="A message in a private workspace" />
  <meta name="twitter:description" content="Sign in to Hrmny to view it." />
  """

  # Splice the card in at the end of <head>. A shell that is not ours (someone
  # replaced index.html with a document without a head) is served untouched:
  # the fallback exists to keep the app loading, and a card is not worth
  # emitting malformed markup for.
  defp inject_share_card(html) when is_binary(html) do
    case :binary.match(html, "</head>") do
      :nomatch ->
        html

      {pos, len} ->
        head = binary_part(html, 0, pos)
        tail = binary_part(html, pos + len, byte_size(html) - pos - len)
        head <> @share_card <> tail
    end
  end
end
