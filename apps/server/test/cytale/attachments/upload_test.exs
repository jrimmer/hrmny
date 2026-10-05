defmodule Cytale.Attachments.UploadTest do
  @moduledoc """
  #65 — content-type resolution: which signal decides what an upload IS.

  The bug this pins: discord.py (and any library assembling its own multipart)
  hardcodes `application/octet-stream` on every `files[n]` part, ignoring the
  file's real type. The allowlist compared that literal, never matched, and a
  bot could not send ANY file — `400 50035` before storage, with no
  client-side remedy, because the value is a literal in the library.

  The rule (documented in `docs/protocol/compat.md` and in the module):
  a SPECIFIC header wins; a GENERIC one defers to the filename, which then
  decides both what is judged and what is stored.
  """

  use ExUnit.Case, async: true

  alias Cytale.Attachments.Upload

  defp part(content_type, filename), do: %Plug.Upload{path: "/tmp/x", content_type: content_type, filename: filename}

  describe "specific headers are taken at their word" do
    test "an allowed specific type is kept as-is" do
      assert Upload.effective_content_type(part("image/png", "photo")) == "image/png"
      assert Upload.effective_content_type(part("text/csv", "data.csv")) == "text/csv"
      # The header wins even when the extension says otherwise.
      assert Upload.effective_content_type(part("image/png", "misleading.html")) == "image/png"
    end

    test "a disallowed specific type stays disallowed — the filename never rescues it" do
      # `.png` here must NOT launder a header the client explicitly set.
      assert Upload.effective_content_type(part("application/x-sh", "innocent.png")) == "application/x-sh"
      assert Upload.effective_content_type(part("text/html", "innocent.png")) == "text/html"
    end
  end

  describe "generic headers defer to the filename (the discord.py shape)" do
    test "application/octet-stream — what every library sends for every file" do
      assert Upload.effective_content_type(part("application/octet-stream", "probe.png")) == "image/png"
      assert Upload.effective_content_type(part("application/octet-stream", "report.pdf")) == "application/pdf"
      assert Upload.effective_content_type(part("application/octet-stream", "notes.md")) == "text/markdown"
      assert Upload.effective_content_type(part("application/octet-stream", "log.txt")) == "text/plain"
      assert Upload.effective_content_type(part("binary/octet-stream", "probe.png")) == "image/png"
    end

    test "text/plain is generic too — a library with no better type sends it" do
      assert Upload.effective_content_type(part("text/plain", "probe.png")) == "image/png"
      assert Upload.effective_content_type(part("text/plain", "report.pdf")) == "application/pdf"
    end

    test "a KNOWN but disallowed extension is resolved and then rejected by the gate" do
      # The point: the filename supplies the real type, so the allowlist sees
      # `text/html` / `image/svg+xml` instead of a harmless-looking
      # `text/plain` and refuses them.
      assert Upload.effective_content_type(part("text/plain", "attack.html")) == "text/html"
      assert Upload.effective_content_type(part("text/plain", "attack.svg")) == "image/svg+xml"
      assert Upload.effective_content_type(part("application/octet-stream", "run.sh")) == "application/x-sh"
    end
  end

  describe "nothing to infer" do
    test "an unknown extension leaves the header standing" do
      # No recognizable extension: the header is all there is, so a text part
      # still stores as text and an octet-stream part is refused (see below).
      assert Upload.effective_content_type(part("text/plain", "NOTES")) == "text/plain"
      assert Upload.effective_content_type(part("text/plain", "archive.zzz")) == "text/plain"

      assert Upload.effective_content_type(part("application/octet-stream", "archive.zzz")) ==
               "application/octet-stream"
    end

    test "an absent/non-binary content type falls back to the filename" do
      assert Upload.effective_content_type(%Plug.Upload{path: "/tmp/x", filename: "a.png", content_type: nil}) ==
               "image/png"

      assert Upload.effective_content_type(%Plug.Upload{path: "/tmp/x", filename: "a.zzz", content_type: nil}) ==
               "application/octet-stream"
    end

    test "a filename-less part degrades to its header, then to octet-stream" do
      assert Upload.effective_content_type(%Plug.Upload{path: "/tmp/x", content_type: "image/png"}) == "image/png"

      assert Upload.effective_content_type(%Plug.Upload{path: "/tmp/x", content_type: nil}) ==
               "application/octet-stream"
    end
  end

  # The allowlist is the gate; these assert the RESOLVED type is what it sees.
  describe "the gate sees the resolved type" do
    test "the discord.py shape is allowed for every permitted extension" do
      allowed = Cytale.Config.attachment_allowed_mime_types()

      for {ext, expected} <- [
            {"png", "image/png"},
            {"jpg", "image/jpeg"},
            {"gif", "image/gif"},
            {"webp", "image/webp"},
            {"pdf", "application/pdf"},
            {"txt", "text/plain"},
            {"md", "text/markdown"},
            {"json", "application/json"},
            {"csv", "text/csv"}
          ] do
        resolved = Upload.effective_content_type(part("application/octet-stream", "file.#{ext}"))
        assert resolved == expected, "#{ext} resolved to #{resolved}"
        assert resolved in allowed, "#{ext} must survive the allowlist"
      end
    end

    test "script-bearing types stay outside the allowlist however they are labelled" do
      allowed = Cytale.Config.attachment_allowed_mime_types()

      for {ct, name} <- [
            {"application/octet-stream", "x.html"},
            {"application/octet-stream", "x.svg"},
            {"application/octet-stream", "x.sh"},
            {"application/octet-stream", "x.exe"},
            {"application/octet-stream", "x.js"}
          ] do
        resolved = Upload.effective_content_type(part(ct, name))
        refute resolved in allowed, "#{name} resolved to #{resolved}, which the gate permits"
      end
    end
  end
end
