# syntax=docker/dockerfile:1
# Cytale — single-image build for the portable single-node deploy (docs/self-hosting.md).
#
#   webbuild      node:22 + corepack/pnpm → builds the React SPA (apps/web/dist)
#   releasebuild  elixir:1.18.4-otp-27 (Debian bookworm) + Rust → prod mix release
#   runtime       debian:bookworm-slim + the self-contained release (/app/bin/cytale)
#
# The SPA is staged into apps/server/priv/static before `mix release`, so the
# image serves the SPA, the REST API and the gateway from one origin on :4000.

# ---------------------------------------------------------------------------
# Stage 1 — webbuild
# ---------------------------------------------------------------------------
FROM node:26-bookworm-slim AS webbuild
ENV CI=1
RUN corepack enable
WORKDIR /repo

# Workspace manifests first (install layer cache). pnpm-lock.yaml resolves
# EVERY workspace importer, so all workspace package.json files must be
# present for `pnpm install --frozen-lockfile` to validate.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY patches patches/
COPY apps/desktop/package.json        apps/desktop/
COPY apps/mobile/package.json        apps/mobile/
COPY apps/server/package.json         apps/server/
COPY apps/tui/package.json           apps/tui/
COPY apps/web/package.json            apps/web/
COPY packages/api-client/package.json     packages/api-client/
COPY packages/calls/package.json          packages/calls/
COPY packages/domain/package.json         packages/domain/
COPY packages/emoji/package.json          packages/emoji/
COPY packages/gateway-client/package.json packages/gateway-client/
COPY packages/markdown/package.json       packages/markdown/
COPY packages/protocol/package.json       packages/protocol/
COPY packages/session/package.json        packages/session/
COPY packages/state/package.json          packages/state/
COPY tools/load-test/package.json         tools/load-test/

# @cytale/web plus its workspace dependencies (source-exported packages —
# no intermediate build outputs needed). The store is a BuildKit cache
# mount, so repeated builds on one host skip re-downloading every package;
# node_modules still lands in the image layer.
ENV npm_config_store_dir=/pnpm/store
RUN --mount=type=cache,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @cytale/web...

COPY apps/web apps/web
COPY packages packages

# Build identity for the rail's version badge. The SPA has to be TOLD what it
# is building: `.git` is excluded from the context (.dockerignore) and the node
# image ships no git, so vite.config.ts's own resolution finds no commit here
# and the badge reads "vdev" on every image-built deploy. Callers pass it —
# compose forwards CYTALE_VERSION, and a manual build passes:
#   docker build --build-arg CYTALE_VERSION=$(git rev-parse --short=7 HEAD) .
ARG CYTALE_VERSION=""
ENV CYTALE_VERSION=${CYTALE_VERSION}

RUN pnpm --filter @cytale/web run build

# ---------------------------------------------------------------------------
# Stage 2 — releasebuild
# ---------------------------------------------------------------------------
# Debian bookworm base (verified: /etc/os-release → Debian 12), matching the
# bookworm-slim runtime stage so the bundled ERTS binaries run unchanged.
FROM elixir:1.18.4-otp-27 AS releasebuild

ENV MIX_ENV=prod

# rustup with pinned homes: CARGO_HOME must NOT be /root/.cargo when the
# cache mounts below cover /usr/local/cargo subdirs — a cache mount masks
# its target, and masking the default cargo home would hide the rustup
# proxy binaries that PATH points at. Subdir mounts (registry/, git/db/)
# leave bin/ (the toolchain) in the real layer.
ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:$PATH

# build-essential + make: argon2_elixir / ezstd native builds; Rust: muninn
# (Tantivy) NIFs (rustler toolchain >= 1.92).
# Voice (U2): ex_webrtc's NIF chain — ex_dtls builds against OpenSSL via
# pkg-config (libssl-dev); ex_libsrtp prefers Membrane's precompiled static
# libsrtp2 but falls back to the system lib via pkg-config (libsrtp2-dev
# keeps the image build hermetic if the precompiled CDN is unreachable).
RUN apt-get update -qq \
 && apt-get install -y --no-install-recommends build-essential ca-certificates curl \
      pkg-config libssl-dev libsrtp2-dev \
 && rm -rf /var/lib/apt/lists/*
RUN curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable --no-modify-path
ENV PATH=/root/.cargo/bin:$PATH

WORKDIR /repo/apps/server
RUN mix local.hex --force && mix local.rebar --force

# Dependency layer: only manifests — `mix deps.get` re-runs when the lock
# changes, not on every source edit.
COPY apps/server/mix.exs apps/server/mix.lock ./
RUN mix deps.get

COPY apps/server/config ./config
COPY apps/server/lib ./lib
COPY apps/server/priv ./priv
# _build is the whole point of these mounts: without it every source change
# recompiles ALL deps from scratch (muninn's Rust build alone is tens of
# minutes). With it, redeploys on the same host recompile only changed
# modules. The mount is per-RUN — the release step below must repeat it to
# see the compiled artifacts. (Ignored by kaniko/CI — the CI path builds
# the release natively and never runs these stages.)
RUN --mount=type=cache,target=_build \
    --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git/db \
    mix compile

# The built SPA becomes the release's served priv/static.
COPY --from=webbuild /repo/apps/web/dist ./priv/static
RUN --mount=type=cache,target=_build \
    --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git/db \
    mix release && mv _build/prod/rel/cytale /release

# ---------------------------------------------------------------------------
# Stage 3 — runtime
# ---------------------------------------------------------------------------
FROM debian:bookworm-slim AS runtime

# ca-certificates: outbound TLS · libssl3: Erlang crypto (libcrypto.so.3) ·
# libstdc++6: native NIFs · ncurses-base: erl terminfo · curl: healthcheck.
RUN apt-get update -qq \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl libssl3 libstdc++6 ncurses-base \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=releasebuild /release ./

# Runtime layout: the release keeps `priv/*` under lib/cytale-<vsn>/priv, but
# the server reads two of them CWD-relative (Plug.Static "priv/static",
# Cytale.Migrations "priv/scylla_schema.cql") — mirror them at /app/priv.
# attachments/ and search/ are volume mount points (compose.yaml).
# /etc/cytale (#121): the server config + secrets mount point — owned by the
# runtime user so the named volume initializes writable (docker copies the
# image dir's ownership into a fresh named volume) and the first-boot
# migration + the Server Settings save can write there.
# backups/ (hardening plan 1.5): same contract for the archive volume — the app
# runs as USER cytale, so a mount point missing from the image is created
# ROOT-owned by docker and every backup write fails with EACCES.
RUN mkdir -p priv/attachments priv/search backups /etc/cytale \
 && cp -r lib/cytale-*/priv/static priv/static \
 && cp lib/cytale-*/priv/scylla_schema.cql priv/scylla_schema.cql \
 && useradd --system --create-home --home-dir /home/cytale --shell /usr/sbin/nologin cytale \
 && chown -R cytale:cytale /app \
 && chown cytale:cytale /etc/cytale

USER cytale
ENV HOME=/home/cytale \
    PORT=4000

EXPOSE 4000
# Liveness via the release's own node — NOT curl: kaniko's snapshotting in a
# CI sandbox has been seen to drop the apt layer, so curl/wget are absent at runtime (the
# installed-curl assumption was wrong for every CI-built image). compose.yaml
# carries the same probe so a stale image cannot report unhealthy either.
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD /app/bin/cytale pid || exit 1

ENTRYPOINT ["/app/bin/cytale"]
CMD ["start"]
