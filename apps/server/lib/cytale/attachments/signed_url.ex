defmodule Cytale.Attachments.SignedUrl do
  @moduledoc """
  Short-lived signed attachment URLs (security Tier 2 #4).

  `GET /api/v1/attachments/:hash` used to serve any blob to anyone holding its
  hash, `public, immutable`, forever: a URL copied out of a channel — or kept
  by a member who has since been removed — stayed a working link to private
  content indefinitely. Message attachments are now served only against a
  signature the server mints when it RENDERS a message for someone who can
  see it:

      /api/v1/attachments/<hash>?e=<unix expiry>&s=<HMAC>

  * The query string carries the signature so the URL keeps working where no
    header can ride — `<img src>`, a link opened in a new tab, the desktop
    webview.
  * `s` is HMAC-SHA256 over `"<hash>.<e>"` with a key derived from the
    endpoint's `secret_key_base` (its own derivation salt, so it can never
    collide with a Phoenix token).
  * `e` is rounded UP to the hour, `ttl .. ttl + 1h` ahead: every render
    inside one hour mints the byte-identical URL, so the browser cache and
    React's unchanged-`src` short-circuit keep working instead of every
    refetch re-downloading every image. `ttl` is
    `Cytale.Config.attachment_url_ttl_seconds/0` (default 24h).
  * The STORED descriptor is never signed: `canonical/1` strips any query a
    client echoed back (the upload response is signed so the composer can
    preview it), and every wire render re-signs (`sign/1`), so a URL is only
    ever as old as the fetch that produced it.

  Avatars and workspace icons are PUBLIC profile media (they are shown to
  anyone who can see the profile, and cached aggressively by clients) and are
  served unsigned — see `Cytale.Attachments.Store.public?/1`.
  """

  @path_re ~r"\A((?:https?://[^/?#]+)?/api/v1/attachments/)([0-9a-f]{64})(?:\?[^#]*)?\z"
  @bucket_s 3_600
  @salt "cytale attachment url v1"

  @doc """
  Sign an attachment URL (relative or absolute, signed or not). Anything that
  is not one of our attachment URLs (an external embed URL, nil) is returned
  unchanged.
  """
  @spec sign(term(), integer()) :: term()
  def sign(url, now_s \\ System.system_time(:second))

  def sign(url, now_s) when is_binary(url) do
    case Regex.run(@path_re, url) do
      [_, prefix, hash] ->
        exp = expiry(now_s)
        prefix <> hash <> "?e=" <> Integer.to_string(exp) <> "&s=" <> signature(hash, exp)

      nil ->
        url
    end
  end

  def sign(other, _now_s), do: other

  @doc "Strip a signature (any query) from an attachment URL; other values pass through."
  @spec canonical(term()) :: term()
  def canonical(url) when is_binary(url) do
    case Regex.run(@path_re, url) do
      [_, prefix, hash] -> prefix <> hash
      nil -> url
    end
  end

  def canonical(other), do: other

  @doc "A stored/wire attachment descriptor with its `url` canonicalized."
  @spec canonical_attachment(term()) :: term()
  def canonical_attachment(%{"url" => url} = att), do: %{att | "url" => canonical(url)}
  def canonical_attachment(%{url: url} = att), do: %{att | url: canonical(url)}
  def canonical_attachment(att), do: att

  @doc "A wire attachment descriptor with its `url` signed."
  @spec sign_attachment(term()) :: term()
  def sign_attachment(%{"url" => url} = att), do: %{att | "url" => sign(url)}
  def sign_attachment(att), do: att

  @doc """
  Verify a request's `e`/`s` for `hash`. `{:ok, seconds_left}` when the
  signature matches and the expiry is in the future; `:expired` for a genuine
  but stale URL; `:invalid` for anything missing or tampered.
  """
  @spec verify(String.t(), term(), term(), integer()) :: {:ok, pos_integer()} | :expired | :invalid
  def verify(hash, e, s, now_s \\ System.system_time(:second))

  def verify(hash, e, s, now_s) when is_binary(hash) and is_binary(e) and is_binary(s) do
    with {exp, ""} <- Integer.parse(e),
         true <- Plug.Crypto.secure_compare(signature(hash, exp), s) do
      if exp > now_s, do: {:ok, exp - now_s}, else: :expired
    else
      _ -> :invalid
    end
  end

  def verify(_hash, _e, _s, _now_s), do: :invalid

  @doc false
  @spec expiry(integer()) :: integer()
  def expiry(now_s) do
    (div(now_s + Cytale.Config.attachment_url_ttl_seconds(), @bucket_s) + 1) * @bucket_s
  end

  defp signature(hash, exp) do
    :hmac
    |> :crypto.mac(:sha256, key(), hash <> "." <> Integer.to_string(exp))
    |> Base.url_encode64(padding: false)
  end

  # Derived once per secret_key_base and cached (PBKDF2 is deliberately slow;
  # this runs on every rendered attachment).
  defp key do
    secret = CytaleWeb.Endpoint.config(:secret_key_base)

    case :persistent_term.get({__MODULE__, :key}, nil) do
      {^secret, key} ->
        key

      _ ->
        key = Plug.Crypto.KeyGenerator.generate(secret, @salt, length: 32)
        :persistent_term.put({__MODULE__, :key}, {secret, key})
        key
    end
  end
end
