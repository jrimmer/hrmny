#!/usr/bin/env node
/**
 * Build-time Tauri configuration for a DEPLOYMENT's desktop build.
 *
 * `src-tauri/tauri.conf.json` names no server and no update feed: the public
 * source must not point every fork's shell at one deployment's server, nor
 * let it auto-update from that deployment's feed. A deployment supplies them
 * at build time instead, through the environment, and this script turns them
 * into a config that `tauri build --config <file>` merges over the base
 * (JSON Merge Patch, in the order the --config flags are given):
 *
 *   DESKTOP_SERVER_ORIGINS     comma-separated origins the shell may talk to.
 *                              Each is added to the CSP's `connect-src`
 *                              (https + wss, or http + ws) and `img-src`
 *                              (https/http), in the order given. Default: the
 *                              build's VITE_CYTALE_ORIGIN, then
 *                              VITE_CYTALE_HOSTED_ORIGIN (deduplicated).
 *   DESKTOP_UPDATER_ENDPOINTS  comma-separated updater feed URLs (Tauri's
 *                              static `latest.json`). Setting any turns on
 *                              `bundle.createUpdaterArtifacts`, which needs
 *                              TAURI_SIGNING_PRIVATE_KEY at build time.
 *   DESKTOP_UPDATER_PUBKEY     the minisign public key the updater verifies
 *                              against (replaces the one in tauri.conf.json —
 *                              a fork signing with its own key must set it).
 *
 * With none of them set the output is `{}`: the build is the plain base
 * config (same-origin CSP only, no update feed).
 *
 * Usage: node scripts/release-config.mjs [--out <file>]   (default: stdout)
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE_CONFIG = join(dirname(fileURLToPath(import.meta.url)), '..', 'src-tauri', 'tauri.conf.json');

/** Split a comma-separated env value into trimmed, non-empty entries. */
export function list(value) {
  return String(value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

/** An origin (`scheme://host[:port]`), or a thrown error naming the bad value. */
export function toOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`not a URL: ${JSON.stringify(value)}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`not an http(s) origin: ${JSON.stringify(value)}`);
  }
  return url.origin;
}

/**
 * The CSP with each origin appended to `connect-src` (the origin and its
 * WebSocket twin) and `img-src` (the origin), in order. Directives keep their
 * order and are re-joined with "; ", the base config's own formatting.
 */
export function cspWithOrigins(csp, origins) {
  const connect = origins.flatMap((origin) => [origin, origin.replace(/^http/, 'ws')]);
  return csp
    .split(';')
    .map((directive) => directive.trim())
    .filter((directive) => directive !== '')
    .map((directive) => {
      const name = directive.split(/\s+/, 1)[0];
      if (name === 'connect-src' && connect.length > 0) return [directive, ...connect].join(' ');
      if (name === 'img-src' && origins.length > 0) return [directive, ...origins].join(' ');
      return directive;
    })
    .join('; ');
}

/** The merge config for this environment (`{}` when it configures nothing). */
export function releaseConfig(env = process.env, base = JSON.parse(readFileSync(BASE_CONFIG, 'utf8'))) {
  const explicit = list(env.DESKTOP_SERVER_ORIGINS);
  const origins = [
    ...new Set(
      (explicit.length > 0 ? explicit : [env.VITE_CYTALE_ORIGIN, env.VITE_CYTALE_HOSTED_ORIGIN])
        .filter((value) => typeof value === 'string' && value.trim() !== '')
        .map((value) => toOrigin(value.trim())),
    ),
  ];
  const endpoints = list(env.DESKTOP_UPDATER_ENDPOINTS);
  const pubkey = String(env.DESKTOP_UPDATER_PUBKEY ?? '').trim();

  const config = {};
  if (origins.length > 0) {
    const csp = base?.app?.security?.csp;
    if (typeof csp !== 'string') throw new Error('tauri.conf.json has no app.security.csp to extend');
    config.app = { security: { csp: cspWithOrigins(csp, origins) } };
  }
  if (endpoints.length > 0 || pubkey !== '') {
    config.plugins = { updater: {} };
    if (endpoints.length > 0) {
      for (const endpoint of endpoints) toOrigin(endpoint);
      config.plugins.updater.endpoints = endpoints;
      config.bundle = { createUpdaterArtifacts: true };
    }
    if (pubkey !== '') config.plugins.updater.pubkey = pubkey;
  }
  return config;
}

function main() {
  const i = process.argv.indexOf('--out');
  const out = i > -1 ? process.argv[i + 1] : undefined;
  const json = JSON.stringify(releaseConfig(), null, 2) + '\n';
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, json);
  } else {
    process.stdout.write(json);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
