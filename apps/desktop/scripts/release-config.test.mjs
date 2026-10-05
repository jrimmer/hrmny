import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { cspWithOrigins, list, releaseConfig, toOrigin } from './release-config.mjs';

const BASE = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src-tauri', 'tauri.conf.json'), 'utf8'),
);

describe('the public base config', () => {
  it('names no server and no update feed', () => {
    expect(BASE.app.security.csp).not.toMatch(/https?:\/\/|wss?:\/\//);
    expect(BASE.plugins.updater.endpoints).toEqual([]);
    expect(BASE.bundle.createUpdaterArtifacts).toBe(false);
  });
});

describe('releaseConfig', () => {
  it('is empty when the environment configures nothing (a plain build)', () => {
    expect(releaseConfig({}, BASE)).toEqual({});
  });

  it('adds each server origin to connect-src (with its ws twin) and img-src, in order', () => {
    const config = releaseConfig(
      { DESKTOP_SERVER_ORIGINS: 'https://a.example.com, https://b.example.com/,http://127.0.0.1:4000' },
      BASE,
    );
    const csp = config.app.security.csp;
    expect(csp).toContain(
      "connect-src 'self' https://a.example.com wss://a.example.com https://b.example.com wss://b.example.com http://127.0.0.1:4000 ws://127.0.0.1:4000;",
    );
    expect(csp).toContain(
      "img-src 'self' data: blob: https://a.example.com https://b.example.com http://127.0.0.1:4000;",
    );
    // Every other directive survives unchanged, in the base's order and format.
    expect(csp.replace(/ (?:https?|wss?):\/\/[^ ;]+/g, '')).toBe(BASE.app.security.csp);
  });

  it('defaults the origins to the baked VITE_ origins, deduplicated', () => {
    const config = releaseConfig(
      { VITE_CYTALE_ORIGIN: 'https://a.example.com', VITE_CYTALE_HOSTED_ORIGIN: 'https://a.example.com/' },
      BASE,
    );
    expect(config.app.security.csp).toContain("connect-src 'self' https://a.example.com wss://a.example.com;");
  });

  it('turns on signed updater artifacts only when a feed is named', () => {
    const config = releaseConfig(
      { DESKTOP_UPDATER_ENDPOINTS: 'https://updates.example.com/latest.json', DESKTOP_UPDATER_PUBKEY: 'cHVia2V5' },
      BASE,
    );
    expect(config).toEqual({
      plugins: { updater: { endpoints: ['https://updates.example.com/latest.json'], pubkey: 'cHVia2V5' } },
      bundle: { createUpdaterArtifacts: true },
    });
  });

  it('refuses a value that is not an http(s) URL', () => {
    expect(() => releaseConfig({ DESKTOP_SERVER_ORIGINS: 'chat.example.com' }, BASE)).toThrow(/not a URL/);
    expect(() => toOrigin('ftp://x.example')).toThrow(/not an http\(s\) origin/);
  });
});

describe('helpers', () => {
  it('list splits and trims', () => {
    expect(list(' a, ,b ')).toEqual(['a', 'b']);
    expect(list(undefined)).toEqual([]);
  });

  it('cspWithOrigins leaves a CSP alone when there are no origins', () => {
    expect(cspWithOrigins(BASE.app.security.csp, [])).toBe(BASE.app.security.csp);
  });
});
