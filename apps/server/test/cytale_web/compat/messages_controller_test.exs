defmodule CytaleWeb.Compat.MessagesControllerTest do
  @moduledoc """
  U6 (bots plan) — the compat message subset: bare-array history with
  Discord message objects, sends (message_reference → native reply),
  author-checked edit/delete, restrictions through the U3 resolver, and the
  Discord error-code mapping (KTD10).
  """

  use Cytale.ScyllaCase, async: false

  import ExUnit.CaptureLog
  import Phoenix.ConnTest
  import Plug.Conn

  alias Cytale.Accounts.{Principals, User}
  alias Cytale.Test.AgentGrants
  alias Cytale.Messages
  alias Cytale.Threads.{Member, Thread}
  alias Cytale.Workspaces

  @endpoint CytaleWeb.Endpoint

  defp run_unique(base) do
    # Collision-proof fixture nonce, unique WITHIN a run (monotonic unique)
    # and ACROSS runs (wall-clock ms — the persistent test keyspace keeps
    # rows from previous runs, so a per-VM counter alone collides).
    base <>
      Integer.to_string(
        :erlang.phash2({System.system_time(:millisecond), System.unique_integer([:positive])}, 1_000_000_000)
      )
  end

  defp conn_with(authorization) do
    Phoenix.ConnTest.build_conn()
    |> put_req_header("accept", "application/json")
    |> put_req_header("content-type", "application/json")
    |> put_req_header("authorization", authorization)
  end

  # Build a real multipart/form-data body: `{:field, name, value}` string
  # parts and `{:file, name, filename, content_type, blob}` file parts
  # (file parts are what Plug parses into %Plug.Upload{}).
  defp multipart_body(parts) do
    boundary = "cytale-multipart-#{System.unique_integer([:positive])}"

    body =
      Enum.map_join(parts, "", fn
        {:field, name, value} ->
          "--#{boundary}\r\n" <>
            "Content-Disposition: form-data; name=\"#{name}\"\r\n\r\n" <>
            value <> "\r\n"

        {:file, name, filename, content_type, blob} ->
          "--#{boundary}\r\n" <>
            "Content-Disposition: form-data; name=\"#{name}\"; filename=\"#{filename}\"\r\n" <>
            "Content-Type: #{content_type}\r\n\r\n" <>
            blob <> "\r\n"
      end) <> "--#{boundary}--\r\n"

    {body, "multipart/form-data; boundary=#{boundary}"}
  end

  setup do
    {:ok, owner} = User.create(run_unique("msg_owner"), run_unique("msg_owner@example.com"), "password-123")
    {:ok, ws} = Workspaces.create_workspace(owner.user_id, run_unique("msg-ws"))
    {:ok, ch} = Workspaces.create_channel(ws.workspace_id, "general")
    {:ok, secret} = Workspaces.create_channel(ws.workspace_id, "secret")
    bot_label = run_unique("Msg Bot")
    {:ok, bot} = AgentGrants.mint_all(owner.user_id, :bot, bot_label)

    %{user_id: bot_id, token: token, username: bot_username} = bot

    {:ok,
     owner: owner,
     ws_id: ws.workspace_id,
     ch_id: Integer.to_string(ch.channel_id),
     secret_id: Integer.to_string(secret.channel_id),
     bot_id: bot_id,
     bot_label: bot_label,
     bot_username: bot_username,
     token: token}
  end

  # ---------------------------------------------------------------------------
  # Sends
  # ---------------------------------------------------------------------------

  describe "POST /channels/{id}/messages" do
    test "create → 201 Discord message object (bot author, discriminator \"0\", global_name)", %{
      ch_id: ch_id,
      bot_id: bot_id,
      bot_label: bot_label,
      bot_username: bot_username,
      token: token
    } do
      conn = post(conn_with("Bot " <> token), "/api/v10/channels/#{ch_id}/messages", %{"content" => "hello compat"})
      assert conn.status == 201

      assert %{
               "id" => id,
               "channel_id" => ^ch_id,
               "author" => %{
                 "id" => author_id,
                 "username" => ^bot_username,
                 "discriminator" => "0",
                 # The display name (#168): a bot's is its label; the tag
                 # stays the username.
                 "global_name" => ^bot_label,
                 "bot" => true
               },
               "content" => "hello compat",
               "timestamp" => ts,
               "edited_timestamp" => nil,
               "tts" => false,
               "mentions" => [],
               "embeds" => [],
               "pinned" => false,
               "type" => 0,
               "attachments" => []
             } = Jason.decode!(conn.resp_body)

      assert id != nil
      assert author_id == Integer.to_string(bot_id)
      assert ts =~ ~r/^\d{4}-\d{2}-\d{2}T/
      # No native envelope wrapper, no Cytale-specific fields.
      body = Jason.decode!(conn.resp_body)
      refute Map.has_key?(body, "message")
      refute Map.has_key?(body, "author_id")
    end

    test "nonce echoes back when provided", %{ch_id: ch_id, token: token} do
      conn =
        post(conn_with("Bot " <> token), "/api/v10/channels/#{ch_id}/messages", %{
          "content" => "with nonce",
          "nonce" => "42"
        })

      assert conn.status == 201
      assert Jason.decode!(conn.resp_body)["nonce"] == "42"
    end

    test "reply via message_reference → type 19 + message_reference + referenced_message", %{
      ch_id: ch_id,
      token: token
    } do
      orig = post(conn_with("Bot " <> token), "/api/v10/channels/#{ch_id}/messages", %{"content" => "original"})
      orig_id = Jason.decode!(orig.resp_body)["id"]

      reply =
        post(conn_with("Bot " <> token), "/api/v10/channels/#{ch_id}/messages", %{
          "content" => "a reply",
          "message_reference" => %{"message_id" => orig_id}
        })

      assert reply.status == 201

      assert %{
               "type" => 19,
               "message_reference" => %{"message_id" => ^orig_id, "channel_id" => ^ch_id},
               "referenced_message" => %{"id" => ^orig_id, "content" => "original"}
             } = Jason.decode!(reply.resp_body)
    end

    test "attachments pass through as Discord attachment objects", %{ch_id: ch_id, token: token} do
      conn =
        post(conn_with("Bot " <> token), "/api/v10/channels/#{ch_id}/messages", %{
          "content" => "with file",
          "attachments" => [
            %{
              "url" => "/api/v1/attachments/abc123",
              "filename" => "cat.png",
              "content_type" => "image/png",
              "size" => 2048,
              "width" => 640,
              "height" => 480
            }
          ]
        })

      assert conn.status == 201

      assert [
               %{
                 "filename" => "cat.png",
                 "content_type" => "image/png",
                 "size" => 2048,
                 "url" => url,
                 "id" => att_id,
                 "width" => 640,
                 "height" => 480
               }
             ] = Jason.decode!(conn.resp_body)["attachments"]

      assert url == "/api/v1/attachments/abc123"
      assert is_binary(att_id)
    end

    # A11: attachment entry VALUES must be scalars (string/number/boolean) —
    # nil/map/list values used to reach `to_string/1` and raise (a 500), or
    # silently stringify nil. They are a 400 50035 now, never a 500.
    test "non-scalar attachment values → 400 50035 (not a 500)", %{ch_id: ch_id, token: token} do
      for bad <- [
            # The finding's exact probe.
            [%{"id" => nil}],
            [%{"filename" => %{"nested" => "map"}}],
            [%{"url" => ["a", "list"]}],
            # A non-map entry rides the same validation (embeds/components
            # semantics: garbage containers are invalid form bodies too).
            ["not-a-map"]
          ] do
        conn =
          post(conn_with("Bot " <> token), "/api/v10/channels/#{ch_id}/messages", %{
            "content" => "bad attachment",
            "attachments" => bad
          })

        assert conn.status == 400, "expected 400 for attachments=#{inspect(bad)}, got #{conn.status}"
        assert %{"code" => 50035} = Jason.decode!(conn.resp_body)
      end

      # A non-list attachments container is the same 400.
      conn =
        post(conn_with("Bot " <> token), "/api/v10/channels/#{ch_id}/messages", %{
          "content" => "bad container",
          "attachments" => %{"id" => "1"}
        })

      assert conn.status == 400
      assert %{"code" => 50035} = Jason.decode!(conn.resp_body)
    end

    # #136: a fieldless entry ({} — or a map none of whose keys are descriptor
    # fields) passed the all-scalar check vacuously and stored the empty-map
    # stub, which the v10 reader then rendered as a full phantom attachment
    # ({"id":"0","url":null,…}). A descriptor with no usable field is a 400;
    # nothing is stored.
    test "fieldless or unknown-keyed attachment entries → 400 50035, no stub stored", %{
      ch_id: ch_id,
      token: token
    } do
      for attachments <- [[%{}], [%{"x" => 1}]] do
        conn =
          post(conn_with("Bot " <> token), "/api/v10/channels/#{ch_id}/messages", %{
            "content" => "no phantom attachments",
            "attachments" => attachments
          })

        assert conn.status == 400,
               "expected 400 for attachments=#{inspect(attachments)}, got #{conn.status}"

        assert %{"code" => 50035} = Jason.decode!(conn.resp_body)
      end

      # The rejection happened at the create gate: no message row — stub or
      # otherwise — was written for either body. (The v10 history is a bare
      # JSON array.)
      conn = get(conn_with("Bot " <> token), "/api/v10/channels/#{ch_id}/messages")
      assert conn.status == 200

      stubs =
        conn.resp_body
        |> Jason.decode!()
        |> Enum.filter(fn m -> m["content"] == "no phantom attachments" end)

      assert stubs == []
    end

    test "malformed bodies → 400 50035 Invalid Form Body", %{ch_id: ch_id, token: token} do
      for body <- [%{}, %{"content" => ""}, %{"content" => String.duplicate("x", 4_001)}, %{"content" => 42}] do
        conn = post(conn_with("Bot " <> token), "/api/v10/channels/#{ch_id}/messages", body)
        assert conn.status == 400, inspect(body)
        assert Jason.decode!(conn.resp_body) == %{"code" => 50035, "message" => "Invalid Form Body"}
      end
    end

    test "dangling message_reference → 400 50035 (validation failure, not a 404 oracle)", %{
      ch_id: ch_id,
      token: token
    } do
      conn =
        post(conn_with("Bot " <> token), "/api/v10/channels/#{ch_id}/messages", %{
          "content" => "bad ref",
          "message_reference" => %{"message_id" => "123456789012345678"}
        })

      assert conn.status == 400
      assert Jason.decode!(conn.resp_body)["code"] == 50035
    end

    test "unknown channel → 404 10003 (identical to a restricted miss)", %{token: token} do
      conn = post(conn_with("Bot " <> token), "/api/v10/channels/123456789012345678/messages", %{"content" => "x"})
      assert conn.status == 404
      assert Jason.decode!(conn.resp_body) == %{"code" => 10003, "message" => "Unknown Channel"}
    end
  end

  # ---------------------------------------------------------------------------
  # Multipart create (Discord's files[n] + payload_json file model)
  # ---------------------------------------------------------------------------

  # The durable send dedupe on the compat CHANNEL branch (the thread branch's
  # twin is below): `(author_id, key)` is claimed in `message_nonces` before
  # the row is written, the same pipeline every send route shares
  # (`Cytale.Messages.Send`). The compat scope runs no in-memory
  # Idempotency-Key replay at all, so every retry here stands in for one
  # after a restart: only the durable reservation can answer it.
  describe "POST /channels/{id}/messages — durable dedupe (message_nonces)" do
    test "a retry with the same nonce is the original message, once — no second row, no second dispatch", %{
      ch_id: ch_id,
      token: token
    } do
      nonce = run_unique("dn")
      body = %{"content" => "exactly once", "nonce" => nonce}

      first = post(conn_with("Bot " <> token), "/api/v10/channels/#{ch_id}/messages", body)
      assert first.status == 201
      assert %{"id" => id, "nonce" => ^nonce} = Jason.decode!(first.resp_body)

      log =
        capture_log(fn ->
          retry = post(conn_with("Bot " <> token), "/api/v10/channels/#{ch_id}/messages", body)
          assert retry.status == 200
          assert get_resp_header(retry, "idempotency-replayed") == []

          assert %{"id" => ^id, "channel_id" => ^ch_id, "content" => "exactly once", "nonce" => ^nonce} =
                   Jason.decode!(retry.resp_body)
        end)

      refute log =~ "event=MessageCreate"
      assert channel_contents(token, ch_id) |> Enum.count(&(&1 == "exactly once")) == 1
    end

    test "an Idempotency-Key header dedupes the same way", %{ch_id: ch_id, token: token} do
      key = run_unique("dk")
      keyed = put_req_header(conn_with("Bot " <> token), "idempotency-key", key)

      first = post(keyed, "/api/v10/channels/#{ch_id}/messages", %{"content" => "keyed once"})
      assert first.status == 201
      %{"id" => id} = Jason.decode!(first.resp_body)

      log =
        capture_log(fn ->
          retry = post(keyed, "/api/v10/channels/#{ch_id}/messages", %{"content" => "keyed once"})
          assert retry.status == 200
          assert get_resp_header(retry, "idempotency-replayed") == []
          assert %{"id" => ^id} = Jason.decode!(retry.resp_body)
        end)

      refute log =~ "event=MessageCreate"
      assert channel_contents(token, ch_id) |> Enum.count(&(&1 == "keyed once")) == 1
    end

    test "a reply retried with its nonce answers with the original, reference included", %{
      ch_id: ch_id,
      token: token
    } do
      orig = post(conn_with("Bot " <> token), "/api/v10/channels/#{ch_id}/messages", %{"content" => "orig"})
      orig_id = Jason.decode!(orig.resp_body)["id"]

      body = %{
        "content" => "the reply",
        "nonce" => run_unique("dr"),
        "message_reference" => %{"message_id" => orig_id}
      }

      first = post(conn_with("Bot " <> token), "/api/v10/channels/#{ch_id}/messages", body)
      assert first.status == 201
      retry = post(conn_with("Bot " <> token), "/api/v10/channels/#{ch_id}/messages", body)
      assert retry.status == 200

      created = Jason.decode!(first.resp_body)
      replayed = Jason.decode!(retry.resp_body)
      assert replayed["id"] == created["id"]
      assert replayed["type"] == 19
      assert replayed["message_reference"] == created["message_reference"]
      assert replayed["referenced_message"]["id"] == orig_id
    end

    test "a different nonce is a new message", %{ch_id: ch_id, token: token} do
      path = "/api/v10/channels/#{ch_id}/messages"
      one = post(conn_with("Bot " <> token), path, %{"content" => "twin", "nonce" => run_unique("a")})
      two = post(conn_with("Bot " <> token), path, %{"content" => "twin", "nonce" => run_unique("b")})

      assert one.status == 201
      assert two.status == 201
      refute Jason.decode!(one.resp_body)["id"] == Jason.decode!(two.resp_body)["id"]
      assert channel_contents(token, ch_id) |> Enum.count(&(&1 == "twin")) == 2
    end

    test "another author's send with the same nonce does not collide", %{
      owner: owner,
      ch_id: ch_id,
      token: token
    } do
      {:ok, %{token: other}} = AgentGrants.mint_all(owner.user_id, :bot, run_unique("Other Bot"))
      nonce = run_unique("shared")
      path = "/api/v10/channels/#{ch_id}/messages"

      mine = post(conn_with("Bot " <> token), path, %{"content" => "mine", "nonce" => nonce})
      theirs = post(conn_with("Bot " <> other), path, %{"content" => "theirs", "nonce" => nonce})

      assert mine.status == 201
      assert theirs.status == 201
      assert %{"content" => "theirs"} = Jason.decode!(theirs.resp_body)
      contents = channel_contents(token, ch_id)
      assert Enum.count(contents, &(&1 == "mine")) == 1
      assert Enum.count(contents, &(&1 == "theirs")) == 1
    end

    test "a nonce spent on a thread reply is a 400 50035 on nonce, not that reply", %{
      bot_id: bot_id,
      ch_id: ch_id,
      token: token
    } do
      thread = seed_thread!(String.to_integer(ch_id), bot_id)
      nonce = run_unique("xt")

      reply =
        post(conn_with("Bot " <> token), "/api/v10/channels/#{thread.thread_id}/messages", %{
          "content" => "in thread",
          "nonce" => nonce
        })

      assert reply.status == 201

      clash =
        post(conn_with("Bot " <> token), "/api/v10/channels/#{ch_id}/messages", %{
          "content" => "timeline",
          "nonce" => nonce
        })

      assert clash.status == 400
      assert %{"code" => 50_035, "errors" => %{"nonce" => _}} = Jason.decode!(clash.resp_body)
      refute "timeline" in channel_contents(token, ch_id)
    end

    test "a channel send's nonce reused for a thread reply is a 400 50035 on nonce, not the message", %{
      bot_id: bot_id,
      ch_id: ch_id,
      token: token
    } do
      thread = seed_thread!(String.to_integer(ch_id), bot_id)
      nonce = run_unique("xc")

      sent =
        post(conn_with("Bot " <> token), "/api/v10/channels/#{ch_id}/messages", %{
          "content" => "timeline",
          "nonce" => nonce
        })

      assert sent.status == 201

      clash =
        post(conn_with("Bot " <> token), "/api/v10/channels/#{thread.thread_id}/messages", %{
          "content" => "in thread",
          "nonce" => nonce
        })

      assert clash.status == 400
      assert %{"code" => 50_035, "errors" => %{"nonce" => _}} = Jason.decode!(clash.resp_body)
      assert Thread.get(thread.thread_id).message_count == 0
    end

    test "a nonce spent in another channel is a 400 50035 on nonce", %{
      ws_id: ws_id,
      ch_id: ch_id,
      token: token
    } do
      {:ok, other} = Workspaces.create_channel(ws_id, "other")
      nonce = run_unique("xo")

      assert post(conn_with("Bot " <> token), "/api/v10/channels/#{other.channel_id}/messages", %{
               "content" => "there",
               "nonce" => nonce
             }).status == 201

      clash =
        post(conn_with("Bot " <> token), "/api/v10/channels/#{ch_id}/messages", %{"content" => "here", "nonce" => nonce})

      assert clash.status == 400
      assert %{"code" => 50_035, "errors" => %{"nonce" => _}} = Jason.decode!(clash.resp_body)
    end

    test "a reservation whose message never landed is RE-DRIVEN under the reserved id", %{
      bot_id: bot_id,
      ch_id: ch_id,
      token: token
    } do
      nonce = run_unique("rd")
      reserved = Cytale.Snowflake.next()
      assert :claimed = Messages.Nonces.claim(bot_id, nonce, String.to_integer(ch_id), reserved)

      log =
        capture_log(fn ->
          retry =
            post(conn_with("Bot " <> token), "/api/v10/channels/#{ch_id}/messages", %{
              "content" => "recovered",
              "nonce" => nonce
            })

          assert retry.status == 201
          assert Jason.decode!(retry.resp_body)["id"] == Integer.to_string(reserved)
        end)

      assert log =~ "re-driving the reserved write"
      assert log =~ "event=MessageCreate"
      assert %{content: "recovered", thread_id: nil} = Messages.get_message(String.to_integer(ch_id), reserved)
      assert channel_contents(token, ch_id) |> Enum.count(&(&1 == "recovered")) == 1
    end
  end

  describe "POST /channels/{id}/messages (multipart)" do
    test "payload_json + files[0] → 201 with stored Discord attachment objects", %{
      ch_id: ch_id,
      token: token
    } do
      blob = <<0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 7, 7, 7>>

      {body, ct} =
        multipart_body([
          {:field, "payload_json", Jason.encode!(%{"content" => "compat multipart", "nonce" => "77"})},
          {:file, "files[0]", "compat-pixel.png", "image/png", blob}
        ])

      conn =
        conn_with("Bot " <> token)
        |> put_req_header("content-type", ct)
        |> post("/api/v10/channels/#{ch_id}/messages", body)

      assert conn.status == 201
      parsed = Jason.decode!(conn.resp_body)
      assert parsed["content"] == "compat multipart"
      assert parsed["nonce"] == "77"

      # The Discord attachment object: fresh snowflake id (NOT the index),
      # ABSOLUTE url, part filename/type/byte size.
      assert [att] = parsed["attachments"]
      assert att["filename"] == "compat-pixel.png"
      assert att["content_type"] == "image/png"
      assert att["size"] == byte_size(blob)
      assert match?({int, ""} when int > 0, Integer.parse(att["id"]))

      assert Cytale.Attachments.SignedUrl.canonical(att["url"]) ==
               "http://www.example.com/api/v1/attachments/#{Cytale.Attachments.Store.hash(blob)}"

      # The blob serves back (through its signed url) with the stored type and
      # inline disposition.
      %URI{path: path, query: query} = URI.parse(att["url"])
      served = get(conn_with("Bot " <> token), path <> "?" <> query)
      assert served.status == 200
      assert served.resp_body == blob
      assert get_resp_header(served, "content-type") == ["image/png"]
      assert get_resp_header(served, "content-disposition") == ["inline; filename=\"compat-pixel.png\""]
    end

    # #65: the shape EVERY real library sends. discord.py hardcodes the
    # `files[n]` part content-type as `application/octet-stream`
    # (`discord/http.py`) and ignores the file's own type, so comparing that
    # literal against the allowlist rejected every bot file upload with
    # `400 50035` — and there was no client-side remedy, because the value is
    # a literal in the library. The filename is the only remaining signal, so
    # it decides both what is judged and what is STORED (which is why the
    # served type below is image/png, not the octet-stream the part claimed).
    test "a library's octet-stream part stores as the file's real type (#65)", %{
      ch_id: ch_id,
      token: token
    } do
      blob = Cytale.UploadHelpers.png_1x1()

      {body, ct} =
        multipart_body([
          {:field, "payload_json", Jason.encode!(%{"content" => "from discord.py"})},
          {:file, "files[0]", "probe.png", "application/octet-stream", blob}
        ])

      conn =
        conn_with("Bot " <> token)
        |> put_req_header("content-type", ct)
        |> post("/api/v10/channels/#{ch_id}/messages", body)

      assert conn.status == 201, "discord.py's part shape must upload: #{conn.resp_body}"

      assert [att] = Jason.decode!(conn.resp_body)["attachments"]
      assert att["filename"] == "probe.png"
      assert att["content_type"] == "image/png"

      # ...and the sniffed dimensions ride along, because the resolved type is
      # an image (an octet-stream PNG used to store with no width/height).
      assert att["width"] == 1 and att["height"] == 1

      # Through the SIGNED url, as a client would. The bare path serves only
      # public profile media, so it worked here only when another test had
      # already uploaded this same PNG as an avatar (content addressing
      # marked the shared blob public). In a run where no avatar test went
      # first, the unsigned fetch was a JSON 404.
      %URI{path: path, query: query} = URI.parse(att["url"])
      served = get(conn_with("Bot " <> token), path <> "?" <> query)
      assert served.status == 200
      assert get_resp_header(served, "content-type") == ["image/png"]
    end

    test "a generic part header cannot launder a script-bearing extension (#65)", %{
      ch_id: ch_id,
      token: token
    } do
      # `.svg` is banned everywhere (inline SVG executes script on our
      # origin). Under the old exact comparison a `text/plain` header made it
      # look like a text file; now the extension supplies the real type and
      # the gate refuses it.
      for {name, header} <- [
            {"payload.svg", "application/octet-stream"},
            {"payload.html", "text/plain"},
            {"payload.sh", "application/octet-stream"}
          ] do
        {body, ct} =
          multipart_body([
            {:field, "payload_json", Jason.encode!(%{"content" => "nope"})},
            {:file, "files[0]", name, header, "<script>alert(1)</script>"}
          ])

        conn =
          conn_with("Bot " <> token)
          |> put_req_header("content-type", ct)
          |> post("/api/v10/channels/#{ch_id}/messages", body)

        assert conn.status == 400, "#{name} (#{header}) must be refused"
        assert Jason.decode!(conn.resp_body)["code"] == 50_035
      end
    end

    test "stored files REPLACE the payload_json.attachments index-map metadata", %{
      ch_id: ch_id,
      token: token
    } do
      {body, ct} =
        multipart_body([
          # Discord's index map: id → metadata describing the files[n] parts.
          {:field, "payload_json",
           Jason.encode!(%{
             "content" => "index map",
             "attachments" => [%{"id" => "0", "filename" => "client-side-name.png", "description" => "a pixel"}]
           })},
          {:file, "files[0]", "real-upload.png", "image/png", <<1, 2, 3>>}
        ])

      conn =
        conn_with("Bot " <> token)
        |> put_req_header("content-type", ct)
        |> post("/api/v10/channels/#{ch_id}/messages", body)

      assert conn.status == 201

      assert [att] = Jason.decode!(conn.resp_body)["attachments"]
      assert att["filename"] == "real-upload.png"

      assert Cytale.Attachments.SignedUrl.canonical(att["url"]) ==
               "http://www.example.com/api/v1/attachments/#{Cytale.Attachments.Store.hash(<<1, 2, 3>>)}"

      assert att["size"] == 3
    end

    test "two files ride in index order with fresh ids", %{ch_id: ch_id, token: token} do
      {body, ct} =
        multipart_body([
          {:field, "payload_json", Jason.encode!(%{"content" => "two files"})},
          {:file, "files[1]", "second.txt", "text/plain", "second"},
          {:file, "files[0]", "first.txt", "text/plain", "first"}
        ])

      conn =
        conn_with("Bot " <> token)
        |> put_req_header("content-type", ct)
        |> post("/api/v10/channels/#{ch_id}/messages", body)

      assert conn.status == 201

      assert [first, second] = Jason.decode!(conn.resp_body)["attachments"]
      assert first["filename"] == "first.txt" and first["size"] == 5
      assert second["filename"] == "second.txt" and second["size"] == 6
      assert first["id"] != second["id"]
    end

    test "missing payload_json → 400 50035; disallowed mime → 400 50035", %{ch_id: ch_id, token: token} do
      {no_payload, no_payload_ct} = multipart_body([{:file, "files[0]", "a.png", "image/png", <<1>>}])

      conn =
        conn_with("Bot " <> token)
        |> put_req_header("content-type", no_payload_ct)
        |> post("/api/v10/channels/#{ch_id}/messages", no_payload)

      assert conn.status == 400
      assert Jason.decode!(conn.resp_body) == %{"code" => 50035, "message" => "Invalid Form Body"}

      {bad_mime, bad_mime_ct} =
        multipart_body([
          {:field, "payload_json", Jason.encode!(%{"content" => "bad mime"})},
          {:file, "files[0]", "evil.sh", "application/x-sh", "#!/bin/sh"}
        ])

      conn =
        conn_with("Bot " <> token)
        |> put_req_header("content-type", bad_mime_ct)
        |> post("/api/v10/channels/#{ch_id}/messages", bad_mime)

      assert conn.status == 400
      assert Jason.decode!(conn.resp_body) == %{"code" => 50035, "message" => "Invalid Form Body"}
    end

    test "permission gate unchanged: a read-only agent gets 403 50001 on the multipart route", %{
      owner: owner,
      ch_id: ch_id
    } do
      {:ok, %{token: ro_token}} =
        AgentGrants.mint_all(owner.user_id, :agent, run_unique("Multipart Reader"), %{
          "actions" => ["read"],
          "channels" => [ch_id]
        })

      {body, ct} =
        multipart_body([
          {:field, "payload_json", Jason.encode!(%{"content" => "should not land"})},
          {:file, "files[0]", "nope.png", "image/png", <<1>>}
        ])

      conn =
        conn_with("Bot " <> ro_token)
        |> put_req_header("content-type", ct)
        |> post("/api/v10/channels/#{ch_id}/messages", body)

      assert conn.status == 403
      assert Jason.decode!(conn.resp_body)["code"] == 50_001
    end
  end

  # ---------------------------------------------------------------------------
  # History
  # ---------------------------------------------------------------------------

  describe "GET /channels/{id}/messages" do
    setup %{token: token, ch_id: ch_id} do
      for i <- 1..3 do
        created = post(conn_with("Bot " <> token), "/api/v10/channels/#{ch_id}/messages", %{"content" => "m#{i}"})
        assert created.status == 201
      end

      :ok
    end

    test "bare JSON array, newest-first, no envelope wrapper", %{ch_id: ch_id, token: token} do
      conn = get(conn_with("Bot " <> token), "/api/v10/channels/#{ch_id}/messages")
      assert conn.status == 200

      body = Jason.decode!(conn.resp_body)
      assert is_list(body)
      assert length(body) == 3
      assert Enum.map(body, & &1["content"]) == ["m3", "m2", "m1"]
      assert Enum.all?(body, &(&1["author"]["bot"] == true))
      assert Enum.all?(body, &(&1["mentions"] == []))
    end

    test "?limit= and ?before= map to native pagination", %{ch_id: ch_id, token: token} do
      all = Jason.decode!(get(conn_with("Bot " <> token), "/api/v10/channels/#{ch_id}/messages").resp_body)
      [newest | _] = all
      middle = Enum.at(all, 1)

      one = Jason.decode!(get(conn_with("Bot " <> token), "/api/v10/channels/#{ch_id}/messages?limit=1").resp_body)
      assert length(one) == 1
      assert hd(one)["id"] == newest["id"]

      before =
        Jason.decode!(
          get(conn_with("Bot " <> token), "/api/v10/channels/#{ch_id}/messages?before=#{newest["id"]}").resp_body
        )

      assert hd(before)["id"] == middle["id"]
    end
  end

  # ---------------------------------------------------------------------------
  # Edit / delete
  # ---------------------------------------------------------------------------

  describe "PATCH/DELETE /channels/{id}/messages/{mid}" do
    setup %{token: token, ch_id: ch_id} do
      created = post(conn_with("Bot " <> token), "/api/v10/channels/#{ch_id}/messages", %{"content" => "original"})
      {:ok, ch_id: ch_id, mid: Jason.decode!(created.resp_body)["id"]}
    end

    test "author edit → 200 Discord object with edited_timestamp set", %{ch_id: ch_id, mid: mid, token: token} do
      conn = patch(conn_with("Bot " <> token), "/api/v10/channels/#{ch_id}/messages/#{mid}", %{"content" => "edited"})
      assert conn.status == 200

      assert %{"content" => "edited", "edited_timestamp" => edited, "type" => 0} = Jason.decode!(conn.resp_body)
      refute is_nil(edited)
    end

    test "non-author edit → 403 50001 (author check mirrors native)", %{
      ch_id: ch_id,
      mid: mid,
      owner: owner
    } do
      {:ok, %{token: other}} = AgentGrants.mint_all(owner.user_id, :bot, run_unique("Other Bot"))

      conn = patch(conn_with("Bot " <> other), "/api/v10/channels/#{ch_id}/messages/#{mid}", %{"content" => "hijack"})
      assert conn.status == 403
      assert Jason.decode!(conn.resp_body) == %{"code" => 50001, "message" => "Missing Permissions"}
    end

    test "invalid content on edit → 400 50035", %{ch_id: ch_id, mid: mid, token: token} do
      conn = patch(conn_with("Bot " <> token), "/api/v10/channels/#{ch_id}/messages/#{mid}", %{"content" => ""})
      assert conn.status == 400
      assert Jason.decode!(conn.resp_body)["code"] == 50035
    end

    test "unknown message → 404 10008 Unknown Message", %{ch_id: ch_id, token: token} do
      conn =
        patch(conn_with("Bot " <> token), "/api/v10/channels/#{ch_id}/messages/123456789012345678", %{"content" => "x"})

      assert conn.status == 404
      assert Jason.decode!(conn.resp_body) == %{"code" => 10008, "message" => "Unknown Message"}
    end

    test "author delete → 204 empty; non-author delete → 403 50001", %{
      ch_id: ch_id,
      mid: mid,
      owner: owner,
      token: token
    } do
      {:ok, %{token: other}} = AgentGrants.mint_all(owner.user_id, :bot, run_unique("Other Bot"))

      denied = delete(conn_with("Bot " <> other), "/api/v10/channels/#{ch_id}/messages/#{mid}")
      assert denied.status == 403
      assert Jason.decode!(denied.resp_body)["code"] == 50001

      gone = delete(conn_with("Bot " <> token), "/api/v10/channels/#{ch_id}/messages/#{mid}")
      assert gone.status == 204
      assert gone.resp_body == ""

      # Deleted: absent from history.
      history = Jason.decode!(get(conn_with("Bot " <> token), "/api/v10/channels/#{ch_id}/messages").resp_body)
      refute mid in Enum.map(history, & &1["id"])

      # Idempotent-ish re-delete → 404 Unknown Message.
      again = delete(conn_with("Bot " <> token), "/api/v10/channels/#{ch_id}/messages/#{mid}")
      assert again.status == 404
      assert Jason.decode!(again.resp_body)["code"] == 10008
    end
  end

  # ---------------------------------------------------------------------------
  # Embeds + components (bots plan U10, R11/KTD11)
  # ---------------------------------------------------------------------------

  describe "embeds and components (U10 payload richness)" do
    test "content + 2 embeds → 201, stored, Discord embed array on compat reads", %{
      ch_id: ch_id,
      token: token
    } do
      e1 = %{
        "title" => "Deploy OK",
        "description" => "prod is green",
        "fields" => [%{"name" => "commit", "value" => "abc123", "inline" => true}]
      }

      e2 = %{"title" => "Second", "color" => 4_437_377}

      conn =
        post(conn_with("Bot " <> token), "/api/v10/channels/#{ch_id}/messages", %{
          "content" => "with embeds",
          "embeds" => [e1, e2]
        })

      assert conn.status == 201
      assert Jason.decode!(conn.resp_body)["embeds"] == [e1, e2]

      history = Jason.decode!(get(conn_with("Bot " <> token), "/api/v10/channels/#{ch_id}/messages").resp_body)
      assert hd(history)["embeds"] == [e1, e2]
    end

    test "embed-only message (no content) is valid", %{ch_id: ch_id, token: token} do
      conn =
        post(conn_with("Bot " <> token), "/api/v10/channels/#{ch_id}/messages", %{
          "embeds" => [%{"title" => "GitHub", "description" => "pushed 3 commits"}]
        })

      assert conn.status == 201

      assert %{"content" => "", "embeds" => [%{"title" => "GitHub"}]} = Jason.decode!(conn.resp_body)
    end

    test "embeds with arbitrary nested keys round-trip byte-equal (Jason decode equality)", %{
      ch_id: ch_id,
      token: token
    } do
      weird = %{
        "title" => "github",
        "footer" => %{"text" => "f", "unknown_key" => [1, 2, %{"deep" => true}]},
        "video" => %{"url" => "https://example.com/v", "width" => 1_920}
      }

      created =
        post(conn_with("Bot " <> token), "/api/v10/channels/#{ch_id}/messages", %{
          "content" => "weird",
          "embeds" => [weird]
        })

      assert created.status == 201
      assert Jason.decode!(created.resp_body)["embeds"] == [weird]

      history = Jason.decode!(get(conn_with("Bot " <> token), "/api/v10/channels/#{ch_id}/messages").resp_body)
      assert hd(history)["embeds"] == [weird]
      assert Jason.decode!(Jason.encode!(hd(history)["embeds"])) == [weird]
    end

    test "11th embed → 400 50035; 9 KB embed → 400 50035", %{ch_id: ch_id, token: token} do
      eleven =
        post(conn_with("Bot " <> token), "/api/v10/channels/#{ch_id}/messages", %{
          "content" => "too many",
          "embeds" => Enum.map(1..11, &%{"title" => "e#{&1}"})
        })

      assert eleven.status == 400
      assert Jason.decode!(eleven.resp_body)["code"] == 50035

      huge =
        post(conn_with("Bot " <> token), "/api/v10/channels/#{ch_id}/messages", %{
          "content" => "too big",
          "embeds" => [%{"description" => String.duplicate("x", 9_000)}]
        })

      assert huge.status == 400
      assert Jason.decode!(huge.resp_body)["code"] == 50035
    end

    test "embeds not a list / entry not a map → 400 50035", %{ch_id: ch_id, token: token} do
      for embeds <- ["nope", [42]] do
        conn =
          post(conn_with("Bot " <> token), "/api/v10/channels/#{ch_id}/messages", %{
            "content" => "bad embeds",
            "embeds" => embeds
          })

        assert conn.status == 400, inspect(embeds)
        assert Jason.decode!(conn.resp_body)["code"] == 50035
      end
    end

    test "components not a list → 400 50035", %{ch_id: ch_id, token: token} do
      conn =
        post(conn_with("Bot " <> token), "/api/v10/channels/#{ch_id}/messages", %{
          "content" => "bad components",
          "components" => "x"
        })

      assert conn.status == 400
      assert Jason.decode!(conn.resp_body)["code"] == 50035
    end

    # The message_write class bucket is 10/5s per principal (setup mints a
    # FRESH bot per test, so each test here gets its own bucket) — the matrix
    # is split across two tests to stay under it.
    test "component cap violations (shape + caps) → 400 50035", %{
      ch_id: ch_id,
      token: token
    } do
      button = fn id -> %{"type" => 2, "style" => 1, "label" => "B", "custom_id" => id} end

      bad_payloads = [
        # 6th row.
        Enum.map(1..6, &%{"type" => 1, "components" => [button.("r#{&1}")]}),
        # 6th button in one row.
        [%{"type" => 1, "components" => Enum.map(1..6, &button.("b#{&1}"))}],
        # select + button in one row.
        [
          %{
            "type" => 1,
            "components" => [
              button.("mix"),
              %{"type" => 3, "custom_id" => "pick", "options" => [%{"label" => "L", "value" => "v"}]}
            ]
          }
        ],
        # 26th option.
        [
          %{
            "type" => 1,
            "components" => [
              %{
                "type" => 3,
                "custom_id" => "pick",
                "options" => Enum.map(1..26, &%{"label" => "o#{&1}", "value" => "v#{&1}"})
              }
            ]
          }
        ],
        # custom_id 101 chars / empty custom_id.
        [%{"type" => 1, "components" => [button.(String.duplicate("c", 101))]}],
        [%{"type" => 1, "components" => [button.("")]}],
        # style 5 with custom_id; style 6.
        [
          %{
            "type" => 1,
            "components" => [%{"type" => 2, "style" => 5, "label" => "L", "url" => "https://x.y", "custom_id" => "no"}]
          }
        ],
        [%{"type" => 1, "components" => [%{"type" => 2, "style" => 6, "label" => "P", "custom_id" => "p"}]}],
        # max_values 2 over a ONE-option select (max may not exceed the option count, #30).
        [
          %{
            "type" => 1,
            "components" => [
              %{
                "type" => 3,
                "custom_id" => "pick",
                "max_values" => 2,
                "options" => [%{"label" => "L", "value" => "v"}]
              }
            ]
          }
        ],
        # >8 KB total serialized.
        [%{"type" => 1, "components" => [Map.put(button.("z"), "pad", String.duplicate("p", 8_200))]}]
      ]

      for payload <- bad_payloads do
        conn =
          post(conn_with("Bot " <> token), "/api/v10/channels/#{ch_id}/messages", %{
            "content" => "cap matrix",
            "components" => payload
          })

        assert conn.status == 400, inspect(payload)
        assert Jason.decode!(conn.resp_body)["code"] == 50035, inspect(payload)
      end
    end

    test "component cap violations (style-5 url lattice) → 400 50035", %{
      ch_id: ch_id,
      token: token
    } do
      button = fn id -> %{"type" => 2, "style" => 1, "label" => "B", "custom_id" => id} end

      bad_payloads = [
        # style-5 without url / javascript: / data: / protocol-relative urls.
        [%{"type" => 1, "components" => [%{"type" => 2, "style" => 5, "label" => "L"}]}],
        [
          %{
            "type" => 1,
            "components" => [%{"type" => 2, "style" => 5, "label" => "L", "url" => "javascript:alert(1)"}]
          }
        ],
        [
          %{
            "type" => 1,
            "components" => [%{"type" => 2, "style" => 5, "label" => "L", "url" => "data:text/html,x"}]
          }
        ],
        [
          %{"type" => 1, "components" => [%{"type" => 2, "style" => 5, "label" => "L", "url" => "//evil.com"}]}
        ],
        # url on style 2.
        [%{"type" => 1, "components" => [Map.put(button.("u"), "url", "https://example.com")]}]
      ]

      for payload <- bad_payloads do
        conn =
          post(conn_with("Bot " <> token), "/api/v10/channels/#{ch_id}/messages", %{
            "content" => "url lattice",
            "components" => payload
          })

        assert conn.status == 400, inspect(payload)
        assert Jason.decode!(conn.resp_body)["code"] == 50035, inspect(payload)
      end
    end

    test "components accepted and STORED: ride compat reads + the native projection verbatim", %{
      ch_id: ch_id,
      token: token
    } do
      components = [
        %{
          "type" => 1,
          "components" => [
            %{"type" => 2, "style" => 1, "label" => "Approve", "custom_id" => "approve"},
            %{"type" => 2, "style" => 3, "label" => "Deny", "custom_id" => "deny"},
            %{"type" => 2, "style" => 5, "label" => "Docs", "url" => "https://docs.example.com/x"}
          ]
        },
        %{
          "type" => 1,
          "components" => [
            %{
              "type" => 3,
              "custom_id" => "model",
              "options" => [%{"label" => "GLM", "value" => "glm"}, %{"label" => "Other", "value" => "other"}]
            }
          ]
        }
      ]

      conn =
        post(conn_with("Bot " <> token), "/api/v10/channels/#{ch_id}/messages", %{
          "content" => "with buttons",
          "components" => components
        })

      assert conn.status == 201
      assert Jason.decode!(conn.resp_body)["components"] == components

      # Compat history: the array rides verbatim, order preserved.
      history = Jason.decode!(get(conn_with("Bot " <> token), "/api/v10/channels/#{ch_id}/messages").resp_body)
      assert hd(history)["components"] == components
      assert Jason.decode!(Jason.encode!(hd(history)["components"])) == components

      # Native history (the same join the native REST surface reads): the
      # components key is present with the identical array (R2).
      channel_id = String.to_integer(ch_id)
      assert [%{components: ^components}] = Messages.history(channel_id, limit: 1)
    end

    test "components absent from every read when the message stored none", %{ch_id: ch_id, token: token} do
      conn = post(conn_with("Bot " <> token), "/api/v10/channels/#{ch_id}/messages", %{"content" => "no buttons"})

      assert conn.status == 201
      body = Jason.decode!(conn.resp_body)
      refute Map.has_key?(body, "components")

      history = Jason.decode!(get(conn_with("Bot " <> token), "/api/v10/channels/#{ch_id}/messages").resp_body)
      for m <- history, do: refute(Map.has_key?(m, "components"))
    end

    test "valid anchors: style-5 https link without custom_id; disabled button; 25 options", %{
      ch_id: ch_id,
      token: token
    } do
      anchors = [
        %{
          "type" => 1,
          "components" => [
            %{"type" => 2, "style" => 5, "label" => "Open", "url" => "https://example.com/a"},
            %{"type" => 2, "style" => 1, "label" => "Done", "custom_id" => "done", "disabled" => true}
          ]
        },
        %{
          "type" => 1,
          "components" => [
            %{
              "type" => 3,
              "custom_id" => "pick",
              "options" => Enum.map(1..25, &%{"label" => "o#{&1}", "value" => "v#{&1}"})
            }
          ]
        }
      ]

      conn =
        post(conn_with("Bot " <> token), "/api/v10/channels/#{ch_id}/messages", %{
          "content" => "anchors",
          "components" => anchors
        })

      assert conn.status == 201
      assert Jason.decode!(conn.resp_body)["components"] == anchors
    end

    test "a message with embeds fans out MessageCreate carrying the embeds (native projection)", %{
      ch_id: ch_id,
      token: token
    } do
      # Mirrors the native controller's fan-out seam assertion: the publish
      # log carries the event name and the embed payload (Publish.Log is the
      # :test impl).
      log =
        capture_log(fn ->
          conn =
            post(conn_with("Bot " <> token), "/api/v10/channels/#{ch_id}/messages", %{
              "content" => "fanout embeds",
              "embeds" => [%{"title" => "Fanout Embed Title", "description" => "seen live"}]
            })

          assert conn.status == 201
        end)

      assert log =~ "[publish]"
      assert log =~ "MessageCreate"
      assert log =~ "embeds"
      assert log =~ "Fanout Embed Title"
    end
  end

  # ---------------------------------------------------------------------------
  # Restrictions (R1/R7 through the U3 resolver)
  # ---------------------------------------------------------------------------

  describe "restrictions apply" do
    test "read-restricted agent: in-profile history 200; POST → 403 50001; out-of-profile GET → 404 10003", %{
      owner: owner,
      ch_id: ch_id,
      secret_id: secret_id,
      token: token
    } do
      {:ok, %{token: ro}} =
        AgentGrants.mint_all(owner.user_id, :agent, run_unique("Reader"), %{
          "actions" => ["read"],
          "channels" => [ch_id]
        })

      # Seed one message as the unrestricted bot for the reader to see.
      seeded = post(conn_with("Bot " <> token), "/api/v10/channels/#{ch_id}/messages", %{"content" => "seed"})
      assert seeded.status == 201

      history = get(conn_with("Bot " <> ro), "/api/v10/channels/#{ch_id}/messages")
      assert history.status == 200
      assert is_list(Jason.decode!(history.resp_body))

      denied = post(conn_with("Bot " <> ro), "/api/v10/channels/#{ch_id}/messages", %{"content" => "nope"})
      assert denied.status == 403
      assert Jason.decode!(denied.resp_body) == %{"code" => 50001, "message" => "Missing Permissions"}

      out = get(conn_with("Bot " <> ro), "/api/v10/channels/#{secret_id}/messages")
      assert out.status == 404
      assert Jason.decode!(out.resp_body) == %{"code" => 10003, "message" => "Unknown Channel"}
    end

    test "a policy with no granted actions masks to nothing (restrictive)", %{owner: owner, ch_id: ch_id} do
      # The mint boundary drops an EMPTY actions list (nil = unrestricted),
      # but a policy whose actions normalize away entirely — channels-only —
      # leaves the resolver's action mask at 0: view included in the deny,
      # nothing granted. The channel gate (compat surface) then renders the
      # anti-enumeration 10003.
      {:ok, %{token: none}} =
        AgentGrants.mint_all(owner.user_id, :agent, run_unique("Mute"), %{"actions" => [], "channels" => [ch_id]})

      conn = get(conn_with("Bot " <> none), "/api/v10/channels/#{ch_id}/messages")
      assert conn.status == 404
      assert Jason.decode!(conn.resp_body)["code"] == 10003
    end
  end

  # ---------------------------------------------------------------------------
  # Thread history through the standard route (C-2: threads ARE channels)
  # ---------------------------------------------------------------------------

  describe "GET /channels/{thread_id}/messages (threads are channels, C-2)" do
    setup %{bot_id: bot_id, ch_id: ch_id, token: token} do
      ch_int = String.to_integer(ch_id)

      # A plain channel message — must never appear in the thread's page.
      {:ok, _unrelated} = Messages.create_message(%{channel_id: ch_int, author_id: bot_id, content: "channel-side"})

      {:ok, root} = Messages.create_message(%{channel_id: ch_int, author_id: bot_id, content: "thread root"})
      {:ok, thread} = Thread.create(ch_int, root.id, "deploy talk", bot_id)

      {:ok, r1} =
        Messages.create_message(%{channel_id: ch_int, author_id: bot_id, content: "r1", thread_id: thread.thread_id})

      {:ok, r2} =
        Messages.create_message(%{
          channel_id: ch_int,
          author_id: bot_id,
          content: "r2",
          thread_id: thread.thread_id,
          reply_to_id: r1.id
        })

      {:ok, thread: thread, r1: r1, r2: r2, token: token}
    end

    test "in-profile history round-trip: channel_id IS the thread id, newest-first", %{
      token: token,
      thread: thread,
      ch_id: ch_id
    } do
      conn = get(conn_with("Bot " <> token), "/api/v10/channels/#{thread.thread_id}/messages")
      assert conn.status == 200

      body = Jason.decode!(conn.resp_body)
      assert is_list(body)
      assert Enum.map(body, & &1["content"]) == ["r2", "r1"]
      assert Enum.all?(body, &(&1["channel_id"] == Integer.to_string(thread.thread_id)))

      # The parent channel's own traffic (the thread root included) does
      # not leak into the thread's page; the parent id is a different id.
      refute "channel-side" in Enum.map(body, & &1["content"])
      refute "thread root" in Enum.map(body, & &1["content"])
      refute Integer.to_string(thread.thread_id) == ch_id
    end

    test "an in-thread reply renders type 19 with the thread as message_reference.channel_id", %{
      token: token,
      thread: thread,
      r1: r1,
      r2: r2
    } do
      conn = get(conn_with("Bot " <> token), "/api/v10/channels/#{thread.thread_id}/messages")
      body = Jason.decode!(conn.resp_body)
      reply = Enum.find(body, &(&1["id"] == Integer.to_string(r2.id)))

      thread_id = Integer.to_string(thread.thread_id)
      r1_id = Integer.to_string(r1.id)

      assert %{
               "type" => 19,
               "message_reference" => %{"message_id" => ^r1_id, "channel_id" => ^thread_id},
               "referenced_message" => %{"id" => ^r1_id, "channel_id" => ^thread_id}
             } = reply
    end

    test "?limit= maps to native pagination on the thread surface", %{token: token, thread: thread} do
      conn = get(conn_with("Bot " <> token), "/api/v10/channels/#{thread.thread_id}/messages?limit=1")
      assert conn.status == 200

      assert [%{"content" => "r2"}] = Jason.decode!(conn.resp_body)
    end

    test "in-profile RESTRICTED agent reads thread history; out-of-profile parent → 404 10003", %{
      owner: owner,
      ch_id: ch_id,
      secret_id: secret_id,
      bot_id: bot_id
    } do
      # A thread under the visible channel and one under `secret`.
      visible_thread = seed_thread!(String.to_integer(ch_id), bot_id)
      secret_thread = seed_thread!(String.to_integer(secret_id), bot_id)

      {:ok, %{token: ro}} =
        AgentGrants.mint_all(owner.user_id, :agent, run_unique("Thread Reader"), %{
          "actions" => ["read"],
          "channels" => [ch_id]
        })

      conn = get(conn_with("Bot " <> ro), "/api/v10/channels/#{visible_thread.thread_id}/messages")
      assert conn.status == 200
      assert is_list(Jason.decode!(conn.resp_body))

      # The thread itself is unknown to this agent's profile through its
      # PARENT: the identical anti-enumeration 10003, never a thread oracle.
      denied = get(conn_with("Bot " <> ro), "/api/v10/channels/#{secret_thread.thread_id}/messages")
      assert denied.status == 404
      assert Jason.decode!(denied.resp_body) == %{"code" => 10003, "message" => "Unknown Channel"}

      # An unknown id (channel or thread) renders the same body.
      unknown = get(conn_with("Bot " <> ro), "/api/v10/channels/123456789012345678/messages")
      assert unknown.status == 404
      assert Jason.decode!(unknown.resp_body) == %{"code" => 10003, "message" => "Unknown Channel"}
    end
  end

  # ---------------------------------------------------------------------------
  # Read-ack route (C-4)
  # ---------------------------------------------------------------------------

  describe "POST /channels/{id}/messages/{mid}/ack (C-4)" do
    test "agent ack writes the AGENT's read_state row; the parent's never moves", %{
      owner: owner,
      ch_id: ch_id,
      token: token
    } do
      seeded =
        post(conn_with("Bot " <> token), "/api/v10/channels/#{ch_id}/messages", %{"content" => "seed for compat ack"})

      assert seeded.status == 201
      mid = Jason.decode!(seeded.resp_body)["id"]

      {:ok, %{user_id: agent_id, token: agent_token}} =
        AgentGrants.mint_all(owner.user_id, :agent, run_unique("Compat Ack Agent"))

      ack = post(conn_with("Bot " <> agent_token), "/api/v10/channels/#{ch_id}/messages/#{mid}/ack", %{})
      assert ack.status == 200
      # Discord's shape: Cytale synthesizes no read-state token.
      assert Jason.decode!(ack.resp_body) == %{"token" => nil}

      # read_state is keyed by user: the AGENT holds its own row…
      channel_int = String.to_integer(ch_id)

      assert [%{"last_read_id" => last_read}] = read_state_rows(agent_id, channel_int)
      assert last_read == String.to_integer(mid)

      # …and the parent holds NONE (per-principal read-state, R4).
      assert read_state_rows(owner.user_id, channel_int) == []
    end

    test "out-of-profile and unknown channels → the identical 404 10003", %{
      owner: owner,
      ch_id: ch_id,
      secret_id: secret_id,
      token: token
    } do
      seeded = post(conn_with("Bot " <> token), "/api/v10/channels/#{ch_id}/messages", %{"content" => "seed"})
      mid = Jason.decode!(seeded.resp_body)["id"]

      {:ok, %{token: ro}} =
        AgentGrants.mint_all(owner.user_id, :agent, run_unique("Ack Scope"), %{
          "actions" => ["read"],
          "channels" => [ch_id]
        })

      out = post(conn_with("Bot " <> ro), "/api/v10/channels/#{secret_id}/messages/#{mid}/ack", %{})
      assert out.status == 404
      assert Jason.decode!(out.resp_body) == %{"code" => 10003, "message" => "Unknown Channel"}

      unknown = post(conn_with("Bot " <> ro), "/api/v10/channels/123456789012345678/messages/#{mid}/ack", %{})
      assert unknown.status == 404
      assert Jason.decode!(unknown.resp_body) == %{"code" => 10003, "message" => "Unknown Channel"}
    end
  end

  # ---------------------------------------------------------------------------
  # Thread WRITES through the standard routes (C-2, #83 compat-surface
  # remainder — the surface was reads-only on a thread id before, the gap
  # compat.md documented as "Thread REPLIES are still not POSTable")
  # ---------------------------------------------------------------------------

  describe "POST/PATCH/DELETE/ack on a thread id (C-2 writes)" do
    setup %{bot_id: bot_id, ch_id: ch_id} do
      thread = seed_thread!(String.to_integer(ch_id), bot_id)
      {:ok, thread: thread}
    end

    test "a compat reply rides the NATIVE hot path: 201 on the thread id, " <>
           "dual emission, auto-follow, discovery counter",
         %{
           ws_id: ws_id,
           bot_id: bot_id,
           token: token,
           thread: thread
         } do
      tid = Integer.to_string(thread.thread_id)

      log =
        capture_log(fn ->
          conn = post(conn_with("Bot " <> token), "/api/v10/channels/#{tid}/messages", %{"content" => "compat reply"})
          assert conn.status == 201

          # The SAME builder the ThreadMessageCreate dispatch translation
          # uses, so the response cannot disagree with what other sessions
          # see live.
          body = Jason.decode!(conn.resp_body)
          assert body["channel_id"] == tid
          assert body["content"] == "compat reply"
          assert body["guild_id"] == Integer.to_string(ws_id)
          assert body["author"]["id"] == Integer.to_string(bot_id)
          assert body["timestamp"] =~ "T"
        end)

      # The dual emission fired — the same two legs a native reply publishes.
      assert log =~ "event=ThreadMessageCreate"
      assert log =~ "event=MessageCreate"

      # The native reply's side effects: auto-follow + the discovery counter.
      assert %{} = Member.get(thread.thread_id, bot_id)
      assert %{} = Thread.get(thread.thread_id)
      assert Thread.get(thread.thread_id).message_count == 1

      # And the reply is readable through the same thread id.
      history = get(conn_with("Bot " <> token), "/api/v10/channels/#{tid}/messages")
      assert [%{"content" => "compat reply", "channel_id" => ^tid}] = Jason.decode!(history.resp_body)
    end

    # The durable send dedupe reaches the compat thread branch too: a bot's
    # retry with the same `nonce` (after a restart, a timeout, a 5xx) answers
    # with the ORIGINAL reply — 200, no second row, no second dispatch, no
    # second counted reply. A different nonce is a different reply.
    test "a retried reply with the same nonce is the original reply, once", %{
      token: token,
      thread: thread
    } do
      tid = Integer.to_string(thread.thread_id)
      nonce = run_unique("cn")
      body = %{"content" => "compat once", "nonce" => nonce}

      first = post(conn_with("Bot " <> token), "/api/v10/channels/#{tid}/messages", body)
      assert first.status == 201
      assert %{"id" => id, "nonce" => ^nonce} = Jason.decode!(first.resp_body)
      assert Thread.get(thread.thread_id).message_count == 1

      log =
        capture_log(fn ->
          retry = post(conn_with("Bot " <> token), "/api/v10/channels/#{tid}/messages", body)
          assert retry.status == 200

          assert %{"id" => ^id, "channel_id" => ^tid, "content" => "compat once", "nonce" => ^nonce} =
                   Jason.decode!(retry.resp_body)
        end)

      refute log =~ "event=ThreadMessageCreate"
      refute log =~ "event=MessageCreate"
      assert Thread.get(thread.thread_id).message_count == 1

      other =
        post(conn_with("Bot " <> token), "/api/v10/channels/#{tid}/messages", %{body | "nonce" => run_unique("cm")})

      assert other.status == 201
      refute Jason.decode!(other.resp_body)["id"] == id

      history = get(conn_with("Bot " <> token), "/api/v10/channels/#{tid}/messages")
      assert length(Jason.decode!(history.resp_body)) == 2
    end

    # The native reply route gates `send_messages` on the PARENT channel; the
    # compat thread branch is the same send and takes the same gate. A
    # read-only principal can read the thread but cannot reply in it.
    test "a read-only principal cannot reply in the thread: 403 50001, nothing stored", %{
      owner: owner,
      ch_id: ch_id,
      thread: thread
    } do
      tid = Integer.to_string(thread.thread_id)

      {:ok, %{token: ro}} =
        AgentGrants.mint_all(owner.user_id, :agent, run_unique("Thread Reader"), %{
          "actions" => ["read"],
          "channels" => [ch_id]
        })

      assert get(conn_with("Bot " <> ro), "/api/v10/channels/#{tid}/messages").status == 200

      denied = post(conn_with("Bot " <> ro), "/api/v10/channels/#{tid}/messages", %{"content" => "nope"})
      assert denied.status == 403
      assert Jason.decode!(denied.resp_body) == %{"code" => 50001, "message" => "Missing Permissions"}
      assert Thread.get(thread.thread_id).message_count == 0
    end

    test "attachments ride the reply (the dispatch renders them too)", %{token: token, thread: thread} do
      tid = Integer.to_string(thread.thread_id)

      conn =
        post(conn_with("Bot " <> token), "/api/v10/channels/#{tid}/messages", %{
          "content" => "with file",
          "attachments" => [%{"url" => "/api/v1/attachments/cat1", "filename" => "cat.png", "size" => 12}]
        })

      assert conn.status == 201

      assert [%{"filename" => "cat.png", "url" => "/api/v1/attachments/cat1"}] =
               Jason.decode!(conn.resp_body)["attachments"]
    end

    # Thread cards: the reply body is the CHANNEL send's surface — embeds and
    # components are stored and rendered (they were refused 50035 while the
    # thread wire could not carry them). The full parity suite lives in
    # `CytaleWeb.ThreadCardsTest`; this pins the route's shape here.
    # `message_reference` stays ACCEPTED (#155).
    test "embeds and components ride a thread reply, as in a channel", %{
      token: token,
      thread: thread
    } do
      tid = Integer.to_string(thread.thread_id)
      embed = %{"title" => "card"}
      row = %{"type" => 1, "components" => [%{"type" => 2, "style" => 1, "label" => "Go", "custom_id" => "go"}]}

      conn =
        post(conn_with("Bot " <> token), "/api/v10/channels/#{tid}/messages", %{
          "content" => "x",
          "embeds" => [embed],
          "components" => [row]
        })

      assert conn.status == 201
      assert %{"channel_id" => ^tid, "embeds" => [^embed], "components" => [^row]} = Jason.decode!(conn.resp_body)
    end

    # A dangling reference stays a validation failure (the same anti-oracle
    # posture as the channel branch — 400 50035, never a 404 oracle).
    test "a dangling message_reference is 400 50035", %{token: token, thread: thread} do
      tid = Integer.to_string(thread.thread_id)

      refused =
        post(conn_with("Bot " <> token), "/api/v10/channels/#{tid}/messages", %{
          "content" => "x",
          "message_reference" => %{"message_id" => "999"}
        })

      assert refused.status == 400
      assert %{"code" => 50_035} = Jason.decode!(refused.resp_body)
    end

    # #155: a thread reply WITH a reference is a real reply — 201 renders
    # Discord's type-19 shape (message_reference with the THREAD id as its
    # channel), the live ThreadMessageCreate dispatch carries the same
    # reference (one shared builder), and the row stores reply_to_id.
    test "reply via message_reference on a thread → type 19 + message_reference, dispatch agrees", %{
      bot_id: bot_id,
      ch_id: ch_id,
      token: token,
      thread: thread
    } do
      tid = Integer.to_string(thread.thread_id)
      ch_int = String.to_integer(ch_id)

      # The original: the thread's ROOT message (created with the thread),
      # plus a second reply so the reference targets a non-root row.
      {:ok, orig} =
        Messages.create_message(%{channel_id: ch_int, author_id: bot_id, content: "r1", thread_id: thread.thread_id})

      orig_id = Integer.to_string(orig.id)

      log =
        capture_log(fn ->
          conn =
            post(conn_with("Bot " <> token), "/api/v10/channels/#{tid}/messages", %{
              "content" => "a reply to r1",
              "message_reference" => %{"message_id" => orig_id}
            })

          assert conn.status == 201
          body = Jason.decode!(conn.resp_body)
          assert body["channel_id"] == tid
          assert body["type"] == 19
          assert body["message_reference"] == %{"message_id" => orig_id, "channel_id" => tid}
        end)

      # The live dispatch carries the same reference (one builder, no drift).
      assert log =~ "event=ThreadMessageCreate"
      assert log =~ orig_id
    end

    # Native parity: a native reply's dispatch carries the reply snapshot
    # (`referenced`), so a live viewer renders the context line without a
    # fetch. A reply posted through compat is the same message on the same
    # wire, snapshot included.
    test "a compat reply's dispatch carries the reply snapshot, as a native reply's does", %{
      bot_id: bot_id,
      ch_id: ch_id,
      token: token,
      thread: thread
    } do
      tid = Integer.to_string(thread.thread_id)

      {:ok, orig} =
        Messages.create_message(%{
          channel_id: String.to_integer(ch_id),
          author_id: bot_id,
          content: "the original",
          thread_id: thread.thread_id
        })

      orig_id = Integer.to_string(orig.id)

      log =
        capture_log(fn ->
          conn =
            post(conn_with("Bot " <> token), "/api/v10/channels/#{tid}/messages", %{
              "content" => "a reply",
              "message_reference" => %{"message_id" => orig_id}
            })

          assert conn.status == 201
        end)

      assert log =~ "event=ThreadMessageCreate"
      assert log =~ ~s("referenced" => %{)
      assert log =~ ~s("message_id" => "#{orig_id}")
      assert log =~ ~s("content" => "the original")
    end

    test "edit + delete a thread reply through the thread id (author-only)", %{
      token: token,
      thread: thread
    } do
      tid = Integer.to_string(thread.thread_id)
      {:ok, reply} = post_reply!(token, tid)

      edited =
        patch(conn_with("Bot " <> token), "/api/v10/channels/#{tid}/messages/#{reply["id"]}", %{
          "content" => "edited in thread"
        })

      assert edited.status == 200
      body = Jason.decode!(edited.resp_body)
      assert body["channel_id"] == tid
      assert body["content"] == "edited in thread"

      # The edit is what a read now serves.
      history = get(conn_with("Bot " <> token), "/api/v10/channels/#{tid}/messages")
      assert [%{"content" => "edited in thread"}] = Jason.decode!(history.resp_body)

      deleted = delete(conn_with("Bot " <> token), "/api/v10/channels/#{tid}/messages/#{reply["id"]}")
      assert deleted.status == 204

      assert [] = Jason.decode!(get(conn_with("Bot " <> token), "/api/v10/channels/#{tid}/messages").resp_body)
    end

    test "a NON-author with send rights still cannot edit another's reply (50001)", %{
      owner: owner,
      token: token,
      thread: thread
    } do
      tid = Integer.to_string(thread.thread_id)
      {:ok, reply} = post_reply!(token, tid)

      {:ok, %{token: other}} = AgentGrants.mint_all(owner.user_id, :bot, run_unique("Other Thread Bot"))

      denied =
        patch(conn_with("Bot " <> other), "/api/v10/channels/#{tid}/messages/#{reply["id"]}", %{"content" => "hijack"})

      assert denied.status == 403
      assert Jason.decode!(denied.resp_body)["code"] == 50_001
    end

    test "ack advances the THREAD read watermark; an ack never mints membership", %{
      owner: owner,
      token: token,
      thread: thread
    } do
      tid = Integer.to_string(thread.thread_id)
      {:ok, reply} = post_reply!(token, tid)

      # A principal that never replied holds no membership row (the reply
      # auto-followed only its AUTHOR): its ack answers 200 — the read
      # happened — but mints nothing.
      {:ok, %{user_id: other_id, token: other}} = AgentGrants.mint_all(owner.user_id, :bot, run_unique("Bare Ack Bot"))

      bare = post(conn_with("Bot " <> other), "/api/v10/channels/#{tid}/messages/#{reply["id"]}/ack", %{})
      assert bare.status == 200
      assert Member.get(thread.thread_id, other_id) == nil

      # Followed, the same ack moves the member watermark — the native
      # PATCH /threads/:id/members/@me writer.
      joined = put(conn_with("Bot " <> other), "/api/v10/channels/#{tid}/thread-members/@me")
      assert joined.status == 204

      acked = post(conn_with("Bot " <> other), "/api/v10/channels/#{tid}/messages/#{reply["id"]}/ack", %{})
      assert acked.status == 200
      assert Jason.decode!(acked.resp_body) == %{"token" => nil}

      member = Member.get(thread.thread_id, other_id)
      assert member.last_read_id == String.to_integer(reply["id"])
    end

    test "an out-of-profile parent keeps the anti-enumeration 10003 on every thread write", %{
      owner: owner,
      ch_id: ch_id,
      secret_id: secret_id,
      bot_id: bot_id
    } do
      secret_thread = seed_thread!(String.to_integer(secret_id), bot_id)
      tid = Integer.to_string(secret_thread.thread_id)

      # An EMPTY allowlist is unrestricted — the profile must NAME the one
      # channel it may see for everything else to be out-of-profile (the
      # same shape the thread-write gate tests pin).
      {:ok, %{token: ro}} =
        AgentGrants.mint_all(owner.user_id, :agent, run_unique("Thread Writer"), %{
          "actions" => ["read", "post"],
          "channels" => [ch_id]
        })

      denied_reply = post(conn_with("Bot " <> ro), "/api/v10/channels/#{tid}/messages", %{"content" => "sneak"})
      assert denied_reply.status == 404
      assert Jason.decode!(denied_reply.resp_body)["code"] == 10_003

      denied = put(conn_with("Bot " <> ro), "/api/v10/channels/#{tid}/thread-members/@me")
      assert denied.status == 404
      assert Jason.decode!(denied.resp_body)["code"] == 10_003
    end
  end

  # -- helpers ----------------------------------------------------------------------

  # A thread reply through the compat route itself (the C-2 write path).
  defp post_reply!(token, tid) do
    conn = post(conn_with("Bot " <> token), "/api/v10/channels/#{tid}/messages", %{"content" => "thread reply"})

    assert conn.status == 201
    {:ok, Jason.decode!(conn.resp_body)}
  end

  # A thread row under `channel_id` (root message + thread row, the domain
  # path the native controllers drive).
  defp channel_contents(token, ch_id) do
    conn_with("Bot " <> token)
    |> get("/api/v10/channels/#{ch_id}/messages")
    |> Map.fetch!(:resp_body)
    |> Jason.decode!()
    |> Enum.map(& &1["content"])
  end

  defp seed_thread!(channel_id, author_id) do
    {:ok, root} = Messages.create_message(%{channel_id: channel_id, author_id: author_id, content: "root"})
    {:ok, thread} = Thread.create(channel_id, root.id, "seeded thread", author_id)
    thread
  end

  # Raw read_state partition read — the isolation pins assert table state.
  defp read_state_rows(user_id, channel_id) do
    Cytale.Repo.execute!(
      "SELECT user_id, channel_id, last_read_id, mention_count, unread_count FROM #{Cytale.Repo.keyspace()}.read_state WHERE user_id = ? AND channel_id = ?",
      [{"bigint", user_id}, {"bigint", channel_id}]
    )
    |> Enum.to_list()
  end
end
