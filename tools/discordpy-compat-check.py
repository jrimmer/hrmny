#!/usr/bin/env python3
"""
Bots-plan compat acceptance — the discord.py leg (2026-09-23).

The discord.js leg (discord-compat-check.mts) proves the wire against ONE
pinned client library. That is not enough: the Hermes outage (2026-09-23)
shipped precisely because discord.py 2.7.1 — the library the real production
bot runs — bare-reads member['roles'] and member['flags'] where discord.js
tolerates their absence, and our type-3 payload carried the thin member. A
single-dialect harness can only catch its own library's pins.

This leg mirrors the JS harness's shape with the other dialect: boot an
isolated server, seed over native REST, then drive a REAL pinned discord.py
client over the real HTTP + websocket wire.

  boot+seed   owner (register→verify→login), workspace, channels, bot mint
              + PATCH access (fail-closed documents need an explicit grant)
  connect     READY → GUILD_CREATE → guild.me (the always-cached contract)
  messaging   guild MESSAGE_CREATE delivery + library send lands natively
  command     guild-scoped command registration THROUGH the library, invoked
              by the human via native /interactions, answered via the
              callback POST
  select      THE HERMES PATH: library posts a string-select card, the human
              clicks via native /interactions, the library constructs the
              interaction (member.roles is load-bearing!) and answers with
              interaction.response.edit_message (the type-7 flip)
  dm-select   the DM twin of the select click — the user-shaped branch (no
              member, no guild_id)

The library pin rides Hermes's own (pyproject: discord.py[voice]==2.7.1);
bump the two in lockstep or the leg proves the wrong dialect.

Usage:  pnpm compat:check:py     (from the repo root)
Env:    DISCORDPY_LEG_PORT (default 4131), DISCORDPY_LEG_VERBOSE=1
"""

import asyncio
import atexit
import json
import os
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VENV_DIR = os.path.join(REPO_ROOT, "tools", ".venv-discordpy")
PINNED_DISCORD_PY = "2.7.1"
PORT = int(os.environ.get("DISCORDPY_LEG_PORT") or 0)
if PORT == 0:
    # A random port per run: orphaned servers from a crashed previous run
    # must never poison the next (an evening of exactly that, 2026-09-23).
    import socket as _s
    for _ in range(25):
        _cand = 4140 + (os.getpid() * 7 + int(time.time() * 1000)) % 400
        _probe = _s.socket()
        try:
            _probe.connect(("127.0.0.1", _cand))
            _probe.close()  # something answers — try another
        except OSError:
            _probe.close()
            PORT = _cand
            break
    if PORT == 0:
        raise RuntimeError("no free port found")
BASE = f"http://127.0.0.1:{PORT}"
API = f"{BASE}/api/v1"
COMPAT_API = f"{BASE}/api/v10"
MAILBOX = os.path.join(REPO_ROOT, "apps/server/tmp/dev_mailbox.jsonl")
TIMEOUT_S = 20.0

# ---------------------------------------------------------------------------
# venv bootstrap: the repo is a pnpm workspace; the python toolchain exists
# only for this leg and lives under tools/, pinned, created on first run.
# ---------------------------------------------------------------------------


def ensure_venv_and_maybe_reexec() -> None:
    py = os.path.join(VENV_DIR, "bin", "python")
    version_ok = False
    if os.path.exists(py):
        out = subprocess.run([py, "-c", "import discord; print(discord.__version__)"],
                             capture_output=True, text=True)
        version_ok = out.returncode == 0 and out.stdout.strip() == PINNED_DISCORD_PY
    if not version_ok:
        print(f"discordpy-leg: bootstrapping {VENV_DIR} (discord.py=={PINNED_DISCORD_PY})")
        if not os.path.exists(py):
            subprocess.run([sys.executable, "-m", "venv", VENV_DIR], check=True)
            subprocess.run([py, "-m", "pip", "install", "--quiet", "--upgrade", "pip"], check=True)
        subprocess.run([py, "-m", "pip", "install", "--quiet", f"discord.py=={PINNED_DISCORD_PY}"], check=True)
    if os.path.abspath(sys.executable) != os.path.abspath(py):
        os.execv(py, [py, os.path.abspath(__file__)] + sys.argv[1:])


ensure_venv_and_maybe_reexec()

import discord  # noqa: E402  (only after the venv re-exec)
import discord.http as discord_http  # noqa: E402
from discord import app_commands, ui  # noqa: E402

# Point the library at OUR server: REST base + the gateway URL. 2.7.1 has
# no gateway-override parameter (plain Client.connect hard-defaults to
# wss://gateway.discord.gg — only the auto-sharded path fetches
# /gateway/bot), so the DEFAULT_GATEWAY constant is the seam. Hermes itself
# reaches us through network-level interception; the wire it speaks is
# identical.
discord_http.Route.BASE = f"{COMPAT_API}"
import yarl  # noqa: E402
dgw = sys.modules["discord.gateway"]
dgw.DiscordWebSocket.DEFAULT_GATEWAY = yarl.URL(f"ws://127.0.0.1:{PORT}/gateway/websocket")

# ---------------------------------------------------------------------------
# server lifecycle + native REST (mirrors the JS harness)
# ---------------------------------------------------------------------------

server: subprocess.Popen | None = None


def kill_server() -> None:
    if server and server.poll() is None:
        try:
            server.kill()
        except OSError:
            pass


atexit.register(kill_server)


def start_server() -> None:
    global server
    env = {
        **os.environ,
        "MIX_ENV": "dev",
        "PORT": str(PORT),
        "SECRET_KEY_BASE": "dpy-leg-secret-key-base-32-chars-min!",
        "AUTH_JWT_SECRET": "dpy-leg-jwt-secret-key-base-32-chars-min",
        "AUTH_REFRESH_PEPPER": "dpy-leg-refresh-pepper-32-chars-minimum!!",
        "CYTALE_SCYLLA_NODES": "127.0.0.1:9042",
        "LOG_LEVEL": os.environ.get("DISCORDPY_LEG_LOG", "info"),
    }
    server_log = open("/tmp/dpy-leg-server.log", "w")
    server = subprocess.Popen(
        ["mix", "phx.server"],
        cwd=os.path.join(REPO_ROOT, "apps/server"),
        env=env,
        stdout=server_log,
        stderr=subprocess.STDOUT,
    )
    for _ in range(400):
        try:
            with urllib.request.urlopen(f"{BASE}/health", timeout=1) as r:
                if r.status == 200:
                    return
        except OSError:
            pass
        time.sleep(0.5)
    raise RuntimeError("server never became healthy (tail: "
                       + open("/tmp/dpy-leg-server.log").read()[-400:] + ")")


def rest(method: str, path: str, token: str | None = None, body: dict | None = None,
         base: str = API) -> dict:
    req = urllib.request.Request(
        base + path,
        data=json.dumps(body).encode() if body is not None else None,
        method=method,
        headers={
            "content-type": "application/json",
            **({"authorization": f"Bearer {token}"} if token else {}),
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"HTTP {e.code} {method} {path}: {e.read().decode()[:400]}") from e


def register_and_login(label: str) -> str:
    registered = rest("POST", "/auth/register", body={
        "username": label, "email": f"{label}@leg.local", "password": "leg-password-1",
    })
    token_from_reg = registered["access_token"]
    mail_token = None
    for _ in range(20):
        time.sleep(0.3)
        try:
            with open(MAILBOX) as f:
                hits = [json.loads(l) for l in f if f"{label}@leg.local" in l]
            mail_token = hits[-1]["token"]
            break
        except (OSError, IndexError, KeyError):
            continue
    if not mail_token:
        raise RuntimeError(f"no verify mail for {label}")
    rest("POST", "/auth/verify-email", token_from_reg, {"token": mail_token})
    logged_in = rest("POST", "/auth/login", body={
        "identifier": label, "password": "leg-password-1",
    })
    return logged_in["access_token"]


# ---------------------------------------------------------------------------
# assertions + waits
# ---------------------------------------------------------------------------

FAILURES: list[str] = []


def check(leg: str, cond: bool, what: str) -> None:
    if cond:
        print(f"ok    [{leg}] {what}")
    else:
        print(f"FAIL  [{leg}] {what}")
        FAILURES.append(f"{leg}: {what}")


async def wait_for(pred, what: str, timeout: float = TIMEOUT_S):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        hit = pred()
        if hit:
            return hit
        await asyncio.sleep(0.1)
    raise TimeoutError(f"{what} (waited {timeout:.0f}s)")


# ---------------------------------------------------------------------------
# the leg
# ---------------------------------------------------------------------------


async def main() -> int:
    run = f"dpy_{int(time.time())}"
    print("discordpy-leg: spawning server")
    start_server()
    print("ok    server up")

    owner_token = register_and_login(f"own_{run}")
    ws = rest("POST", "/workspaces", owner_token, {"name": f"dpy-ws-{run}"})
    ws_id = ws["workspace"]["id"]
    ch = rest("POST", f"/workspaces/{ws_id}/channels", owner_token, {"name": "general"})
    channel_id = ch["channel"]["id"]
    bot = rest("POST", "/bots", owner_token, {"name": f"dpy-bot-{run}"})
    bot_id, bot_token = bot["id"], bot["token"]
    # A bare mint carries no workspace access (fail-closed documents):
    # grant all-workspaces read_write, the REST form of the data-layer
    # tests' AgentGrants.all_access.
    rest("PATCH", f"/bots/{bot_id}", owner_token, {
        "access": {"v": 1, "dms": "read_write", "workspaces": {"mode": "all", "level": "read_write"}},
    })
    me = rest("GET", "/users/@me", owner_token)
    owner_id = me["user"]["id"]
    print("ok    seed ready (owner, workspace, channel, granted bot)")

    intents = discord.Intents.none()
    intents.guilds = True
    intents.guild_messages = True
    intents.dm_messages = True
    client = discord.Client(intents=intents)
    tree = app_commands.CommandTree(client)

    ready = asyncio.Event()
    guild_messages: list[discord.Message] = []
    dm_messages: list[discord.Message] = []
    interactions: list[discord.Interaction] = []
    command_replied = asyncio.Event()
    select_done: dict[str, asyncio.Event] = {"guild": asyncio.Event(), "dm": asyncio.Event()}
    select_facts: dict[str, dict] = {}

    @client.event
    async def on_ready() -> None:
        ready.set()

    @client.event
    async def on_message(message: discord.Message) -> None:
        (dm_messages if message.guild is None else guild_messages).append(message)

    raw_events: list[str] = []

    dm_channel_ids: set[str] = set()

    @client.event
    async def on_socket_event_type(event_type: str) -> None:
        raw_events.append(event_type)

    @client.event
    async def on_interaction(interaction: discord.Interaction) -> None:
        # Constructed interactions land here — a payload the library cannot
        # construct never arrives (and kills the process outright for some
        # shapes; the thin-member KeyError was exactly that class).
        interactions.append(interaction)

    @tree.command(name="compat_ping", description="Cytale compat acceptance ping (discord.py leg)")
    async def compat_ping(interaction: discord.Interaction) -> None:
        check("command", interaction.data is not None and interaction.data.get("name") == "compat_ping",
              f"chat-input interaction carried command name ({interaction.data})")
        await interaction.response.send_message("compat: py interaction reply")
        command_replied.set()

    class ProviderSelect(ui.Select):
        def __init__(self, branch: str) -> None:
            self.branch = branch
            super().__init__(
                custom_id=f"py_provider_select_{branch}",
                placeholder="Choose a provider...",
                options=[
                    discord.SelectOption(label="Anthropic", value="anthropic"),
                    discord.SelectOption(label="OpenAI", value="openai"),
                ],
            )

        async def callback(self, interaction: discord.Interaction) -> None:
            # THE assertion the discord.js leg can never make: discord.py
            # 2.7.1 constructs a Member for guild interactions and bare-reads
            # roles/flags — the Hermes crash (2026-09-23) died exactly here.
            if self.branch == "guild":
                check("select", interaction.user is not None and len(interaction.user._roles) > 0,
                      f"guild click built a Member with roles ({interaction.user!r})")
                check("select", interaction.guild is not None and str(interaction.guild.id) == ws_id,
                      "guild click resolved the guild")
            else:
                check("dm-select", interaction.guild is None and not isinstance(interaction.user, discord.Member),
                      f"DM click resolved a USER (not a Member): {interaction.user!r}")
            values = (interaction.data or {}).get("values")
            check(self.branch if self.branch == "dm-select" else "select",
                  values == ["anthropic"], f"click carried select values ({values})")
            await interaction.response.edit_message(
                content=f"compat: py provider selected ({self.branch})", view=None)
            select_facts[self.branch] = {"values": values}
            select_done[self.branch].set()

    # -- connect ----------------------------------------------------------------
    task = asyncio.create_task(client.start(bot_token))
    await wait_for(ready.is_set, "READY never fired")
    guild = client.get_channel(int(channel_id)).guild if client.get_channel(int(channel_id)) else None
    guild = guild or [g for g in client.guilds if str(g.id) == ws_id][0]
    check("connect", client.user is not None and str(client.user.id) == bot_id,
          f"READY user is the bot ({client.user!r})")
    check("connect", guild is not None and str(guild.id) == ws_id, "GUILD_CREATE landed in the cache")
    check("connect", guild.me is not None, "guild.me is cached (discord.py's unguarded contract)")

    # -- messaging ----------------------------------------------------------------
    rest("POST", f"/channels/{channel_id}/messages", owner_token, {"content": "compat: py native hello"})
    received = await wait_for(
        lambda: next((m for m in guild_messages if m.content == "compat: py native hello"), None),
        "guild MESSAGE_CREATE never reached the client")
    check("messaging", received.author.id == int(owner_id), "native post's author resolved")

    def native_row(channel: str, message_id: str) -> dict:
        rows = rest("GET", f"/channels/{channel}/messages?limit=10", owner_token)["messages"]
        return next((m for m in rows if m.get("id") == message_id), {})

    ch_obj = client.get_channel(int(channel_id))
    sent = await ch_obj.send("compat: py library hello")
    landed = native_row(channel_id, str(sent.id))
    check("messaging", landed.get("content") == "compat: py library hello"
          and landed.get("author_id") == bot_id,
          "library send landed in native history with the bot as author")

    # -- command (type 2) -----------------------------------------------------------
    # discord.py's guild-command flow: copy the tree's GLOBAL commands into
    # the guild scope first (sync(guild=...) alone syncs only guild-scoped
    # registrations and would PUT an empty set).
    tree.copy_global_to(guild=discord.Object(id=int(ws_id)))
    synced = await tree.sync(guild=discord.Object(id=int(ws_id)))
    check("command", any(c.name == "compat_ping" for c in synced),
          f"guild-scoped command registration through the library ({[c.name for c in synced]})")
    # The authoritative command id: the native workspace list the composer
    # itself reads (the library's returned object may not carry the id).
    commands = rest("GET", f"/workspaces/{ws_id}/commands", owner_token)["commands"]
    command_id = next((c["id"] for c in commands if c.get("name") == "compat_ping"), None)
    if command_id is None:
        raise RuntimeError(f"compat_ping not in the native command list: {commands}")
    rest("POST", "/interactions", owner_token, {"command_id": str(command_id), "channel_id": channel_id})
    await wait_for(command_replied.is_set, "the chat-input interaction never completed its reply")
    history = rest("GET", f"/channels/{channel_id}/messages?limit=10", owner_token)
    reply_row = next((m for m in history["messages"] if m.get("content") == "compat: py interaction reply"), None)
    check("command", reply_row is not None and reply_row.get("author_id") == bot_id,
          "the callback POST landed as a bot-authored message")

    # -- select click (type 3, guild branch) — the Hermes path ----------------------
    view = ui.View(timeout=120)
    view.add_item(ProviderSelect("guild"))
    card = await client.get_channel(int(channel_id)).send(
        "compat: py pick a provider", view=view)
    rest("POST", "/interactions", owner_token, {
        "channel_id": channel_id, "message_id": str(card.id),
        "custom_id": "py_provider_select_guild", "component_type": 3, "values": ["anthropic"],
    })
    await wait_for(select_done["guild"].is_set,
                   "the guild select click never fired (constructor or dispatch failure)")
    await wait_for(
        lambda: native_row(channel_id, str(card.id)).get("content") == "compat: py provider selected (guild)",
        "the type-7 update (edit_message) never flipped the card")
    check("select", True, "the card's stored content flipped (interaction.update round-trip)")

    # -- select click (type 3, DM branch) --------------------------------------------
    dm = await client.create_dm(discord.Object(id=int(owner_id)))
    dm_view = ui.View(timeout=120)
    dm_view.add_item(ProviderSelect("dm"))
    dm_card = await dm.send("compat: py dm pick a provider", view=dm_view)
    # Wait for OUR OWN card echo before clicking: the first message in a
    # fresh DM triggers a route re-sync on the session, and a click fanned
    # inside that window is LOST (send-to-unsubscribed) — a real gateway
    # race the JS harness sidesteps the same way (it awaits the echo too).
    # A human never clicks in 9ms; the race is filed as follow-up.
    await wait_for(
        lambda: next((m for m in dm_messages if m.id == dm_card.id), None),
        f"the DM card echo never reached the bot's own session "
        f"(raw tail: {raw_events[-12:]})")
    rest("POST", "/interactions", owner_token, {
        "channel_id": str(dm.id), "message_id": str(dm_card.id),
        "custom_id": "py_provider_select_dm", "component_type": 3, "values": ["anthropic"],
    })
    await wait_for(select_done["dm"].is_set,
                   "the DM select click never fired (user-shape branch failure)", 45)
    check("dm-select", select_facts["dm"]["values"] == ["anthropic"],
          "DM click values survived the user-shaped payload")

    await client.close()
    task.cancel()

    if FAILURES:
        print(f"\nDISCORD.PY LEG FAIL — {len(FAILURES)} assertion(s):")
        for f in FAILURES:
            print(f"  - {f}")
        return 1
    print("\nDISCORD.PY LEG PASS — connect · messaging · command · select(guild+dm)")
    return 0


if __name__ == "__main__":
    signal.signal(signal.SIGINT, lambda *_: (kill_server(), sys.exit(130)))
    sys.exit(asyncio.run(main()))
