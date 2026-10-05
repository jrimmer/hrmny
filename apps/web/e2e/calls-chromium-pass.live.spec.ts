/**
 * #46 — the Chromium second-engine pass + visible-state pixel captures for
 * Calls V2.
 *
 * Two members, two browser contexts, fake camera + microphone devices, real
 * server: the second-engine pass the calls V2 work asked for (its primary
 * verification ran in WebKit alone — ticket #46 Pass 1).
 *
 * The rig:
 *   * Chromium launches with `--use-fake-ui-for-media-stream` and
 *     `--use-fake-device-for-media-stream`, so both "cameras" are a moving
 *     green pattern and both "mics" emit a tone — no hardware needed;
 *   * an init script records every RTCPeerConnection in `window.__pcs`, so
 *     the spec can read live getStats off the app's real peer connections;
 *   * A mints an invite; B joins through it (API, before B's session boots);
 *   * A starts a SILENT call from the channel header; B joins from the same
 *     header — both land connected (`data-voice-status=connected`);
 *   * the V2 PUBLISH path is then driven for real, both ways: A toggles the
 *     camera (op-22 publish → SFU negotiation → roster glyph on BOTH sides),
 *     then B does the same, and each side's getStats shows inbound video
 *     frames actually DECODING — the headless stand-in for the walkthrough's
 *     step-10 "frames visibly decode";
 *   * the sender-shape read records the rid encodings (q/h/f) and the
 *     transceiver direction on the camera ingest m-line — the step-9
 *     rid-encoding observation WKWebView could not expose (W4/W5);
 *   * captures: the two-camera panel, the muted state, and the post-leave
 *     roster, at 1x and 4x.
 *
 * HONESTY NOTE (the 2026-09-18 diagnosis): the first draft of this spec
 * expected `roster-source` glyphs after the SILENT joins and stalled. That
 * expectation contradicted the protocol — microphone audio is the V1 call
 * itself, never a roster `sources[]` entry (packages/protocol payloads.ts
 * CALL_SOURCE_KINDS) — and NOTHING was stalled: voice connected, and the
 * camera publish path worked the moment it was actually driven. The silent
 * joins therefore assert ROSTER ROWS; the source glyphs are asserted on the
 * real camera publishes.
 */
import { test, expect, chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  accessToken,
  API,
  apiRegister,
  CAPTURE_4X,
  CAPTURE_4X_SKIPPED,
  makeE2EUser,
  openSeededChannel,
  registerVerifiedUser,
  uiLogin,
  verifyViaMailbox,
} from './helpers';

const OUT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'docs',
  'research',
  'screenshots',
  '2026-09-15-calls-chromium-pass',
);

/** Record every RTCPeerConnection the app creates (getStats seam for e2e). */
const PC_RECORDER = `
  (() => {
    const Orig = window.RTCPeerConnection;
    if (!Orig) return;
    const pcs = [];
    window.__pcs = pcs;
    window.RTCPeerConnection = class extends Orig {
      constructor(...args) {
        super(...args);
        pcs.push(this);
      }
    };
  })();
`;

interface RTCStatsReportLike {
  type: string;
  kind?: string;
  framesDecoded?: number;
}

/** Summed `framesDecoded` over every live inbound video stream (all PCs). */
async function inboundVideoFrames(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(async () => {
    const pcs = (window as unknown as { __pcs?: RTCPeerConnection[] }).__pcs ?? [];
    let frames = 0;
    for (const pc of pcs) {
      try {
        const stats = await pc.getStats();
        stats.forEach((raw) => {
          const r = raw as unknown as RTCStatsReportLike;
          if (r.type === 'inbound-rtp' && r.kind === 'video') frames += r.framesDecoded ?? 0;
        });
      } catch {
        // a closed leg's PC — its frames are gone, not failed
      }
    }
    return frames;
  });
}

/**
 * The step-9 sender shape: rid encodings visible on the camera ingest m-line
 * (the server's rid-munged offer → the client's senders) plus the camera
 * transceiver's direction (W5 — the `sendonly` declaration WebKit demanded
 * and Chrome tolerated).
 */
async function cameraSenderShape(page: import('@playwright/test').Page): Promise<{
  rids: string[];
  directions: string[];
}> {
  return page.evaluate(() => {
    const pcs = (window as unknown as { __pcs?: RTCPeerConnection[] }).__pcs ?? [];
    const rids: string[] = [];
    const directions: string[] = [];
    for (const pc of pcs) {
      for (const sender of pc.getSenders()) {
        const params = sender.getParameters();
        for (const encoding of params.encodings ?? []) {
          if (encoding.rid) rids.push(encoding.rid);
        }
      }
      for (const transceiver of pc.getTransceivers()) {
        if (
          transceiver.sender.track?.kind === 'video' ||
          transceiver.receiver.track.kind === 'video'
        ) {
          directions.push(transceiver.direction);
        }
      }
    }
    return { rids, directions };
  });
}

test.describe.configure({ mode: 'serial' });

test.describe('#46 — calls on Chromium (second engine)', () => {
  for (const scale of [1, 4] as const) {
    test(`two members join, publish cameras, and leave — captures at ${scale}x`, async () => {
      test.skip(scale === 4 && !CAPTURE_4X, CAPTURE_4X_SKIPPED);
      // Fake camera + microphone: headless Chromium has no real devices, and
      // the pass is about the CLIENT states (join, publish, roster, mute,
      // leave), not media quality.
      const browser = await chromium.launch({
        args: [
          '--use-fake-ui-for-media-stream',
          '--use-fake-device-for-media-stream',
          '--autoplay-policy=no-user-gesture-required',
        ],
      });
      test.setTimeout(300_000);
      mkdirSync(OUT, { recursive: true });
      const label = `${scale}x`;

      const ctxA = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: scale,
        permissions: ['camera', 'microphone'],
      });
      const ctxB = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: scale,
        permissions: ['camera', 'microphone'],
      });
      // The getStats seam must be in place before any app code runs.
      await ctxA.addInitScript(PC_RECORDER);
      await ctxB.addInitScript(PC_RECORDER);
      const pageA = await ctxA.newPage();
      const pageB = await ctxB.newPage();
      const api = pageA.request;

      // A owns the workspace; B joins through an invite (API, pre-boot).
      await registerVerifiedUser(pageA, `calls${scale}`);
      const tokenA = await accessToken(pageA);
      const a = { authorization: `Bearer ${tokenA}` };
      const wsName = `calls-${label}-${Date.now().toString(36)}`;
      const wsRes = await api.post(`${API}/workspaces`, {
        headers: a,
        data: { name: wsName },
      });
      expect(wsRes.status()).toBe(201);
      const wsId = (await wsRes.json()).workspace.id as string;
      const chRes = await api.post(`${API}/workspaces/${wsId}/channels`, {
        headers: a,
        data: { name: 'general' },
      });
      expect(chRes.status()).toBe(201);
      const chId = (await chRes.json()).channel.id as string;

      const userB = makeE2EUser();
      await apiRegister(userB);
      await verifyViaMailbox(userB);
      const loginB = await api.post(`${API}/auth/login`, {
        data: { identifier: userB.username, password: userB.password },
      });
      const tokenB0 = (await loginB.json()).access_token as string;
      const inv = await api.post(`${API}/workspaces/${wsId}/invites`, {
        headers: a,
        data: {},
      });
      const invBody = await inv.json();
      const code = (invBody.invite?.code ?? invBody.code ?? invBody.invite?.id) as string;
      expect(
        (
          await api.post(`${API}/invites/${code}`, {
            headers: { authorization: `Bearer ${tokenB0}` },
            data: {},
          })
        ).ok(),
      ).toBe(true);

      await uiLogin(pageB, userB);

      // A starts a SILENT call from the channel header. A's session booted
      // before the workspace existed — a reload re-runs the boot hydrate so
      // the rail and channel appear (the #111 no-live-dispatch class).
      await openSeededChannel(pageA, wsName, chId);
      await pageA.getByTestId('header-start-call').waitFor({ state: 'visible', timeout: 20_000 });
      await pageA.getByTestId('header-start-call').click();
      await expect(pageA.getByTestId('call-panel')).toBeVisible({ timeout: 20_000 });
      await expect(pageA.getByTestId('call-panel')).toHaveAttribute('data-voice-status', 'connected', {
        timeout: 20_000,
      });

      // B joins from the same header. A's call is live, so B's header offers
      // JOIN (not Start); the header control is the one this pass exercises.
      await pageB.getByTestId(`channel-${chId}`).click();
      await pageB.getByTestId('header-join-call').click();
      await expect(pageB.getByTestId('call-panel')).toBeVisible({ timeout: 20_000 });
      await expect(pageB.getByTestId('call-panel')).toHaveAttribute('data-voice-status', 'connected', {
        timeout: 20_000,
      });

      // Both rosters show TWO PARTICIPANTS (the join is real, both engines).
      // The mic is not a roster source (protocol: sources are camera/screen/
      // screen_audio only), so a silent join correctly renders zero
      // roster-source glyphs — rows, not glyphs, are the join's proof.
      await expect(pageA.getByTestId('call-roster-row')).toHaveCount(2, { timeout: 20_000 });
      await expect(pageB.getByTestId('call-roster-row')).toHaveCount(2, { timeout: 20_000 });

      // --- V2 publish, leg one (walkthrough step 9): A turns the camera on.
      // The glyph must appear on A's own roster AND on B's (op-22 → server
      // roster → both clients) — the wire-level publish, both engines.
      await pageA.getByTestId('call-camera-panel').click();
      await expect(
        pageA.locator('[data-testid="roster-source"][data-source="camera"]'),
      ).toHaveCount(1, { timeout: 20_000 });
      await expect(
        pageB.locator('[data-testid="roster-source"][data-source="camera"]'),
      ).toHaveCount(1, { timeout: 20_000 });

      // --- V2 publish, leg two (step 10): B turns the camera on too. Each
      // roster now carries TWO camera glyphs (own + remote).
      await pageB.getByTestId('call-camera-panel').click();
      await expect(
        pageA.locator('[data-testid="roster-source"][data-source="camera"]'),
      ).toHaveCount(2, { timeout: 20_000 });
      await expect(
        pageB.locator('[data-testid="roster-source"][data-source="camera"]'),
      ).toHaveCount(2, { timeout: 20_000 });

      // Media honesty (step 10, headless form): each side DECODES the other's
      // fake-camera video — inbound-rtp framesDecoded climbs past zero.
      await expect.poll(() => inboundVideoFrames(pageA), { timeout: 30_000 }).toBeGreaterThan(0);
      await expect.poll(() => inboundVideoFrames(pageB), { timeout: 30_000 }).toBeGreaterThan(0);

      // Step 9's rid-encoding observation (WKWebView couldn't expose it):
      // the camera sender carries the server-munged q/h/f encodings, and the
      // video m-line answers sendonly (W5). Recorded as the evidence read —
      // a shape regression shows up as empty arrays.
      const shapeA = await cameraSenderShape(pageA);
      console.log(
        `[#46 ${label}] Chromium camera sender shape: rids=${JSON.stringify(shapeA.rids)} ` +
          `video directions=${JSON.stringify(shapeA.directions)} chromium=${browser.version()}`,
      );
      expect(shapeA.rids.sort()).toEqual(['f', 'h', 'q']);
      expect(shapeA.directions).toContain('sendonly');

      // Captures: the two-camera panel, on BOTH sides (cross-engine pixels).
      await pageA.screenshot({ path: join(OUT, `call-two-participants-${label}.png`) });
      await pageB.screenshot({ path: join(OUT, `call-two-participants-b-${label}.png`) });

      // A mutes; the mark flips on A's own row AND propagates to B's roster
      // (step 4's live glyph propagation, on already-mounted DOM).
      await pageA.getByTestId('call-mute-panel').click();
      await expect(pageA.getByTestId('roster-muted')).toBeVisible({ timeout: 15_000 });
      await expect(pageB.getByTestId('roster-muted')).toBeVisible({ timeout: 15_000 });
      await pageA.screenshot({ path: join(OUT, `call-muted-${label}.png`) });

      // A unmutes — the WebKit walkthrough's F4 observation (an unmute not
      // clearing the peer's already-mounted glyph) reads clean here: the
      // glyph must vanish from B's live roster, not just a fresh sync.
      // Paced over the gateway's 900 ms human-paced op-22 window
      // (`@call_op_throttle_ms` — a faster second `state` op is swallowed
      // silently BY DESIGN, and the roster renders server truth).
      await pageA.waitForTimeout(1_000);
      await pageA.getByTestId('call-mute-panel').click();
      await expect(pageA.getByTestId('roster-muted')).toBeHidden({ timeout: 15_000 });
      await expect(pageB.getByTestId('roster-muted')).toBeHidden({ timeout: 15_000 });

      // B leaves; A's roster drops to one row and B's camera glyph goes with
      // B's leg — A's own camera glyph remains.
      await pageB.getByTestId('call-leave-panel').click();
      await expect(pageB.getByTestId('call-panel')).toBeHidden({ timeout: 20_000 });
      await expect(pageA.getByTestId('call-roster-row')).toHaveCount(1, { timeout: 20_000 });
      await expect(
        pageA.locator('[data-testid="roster-source"][data-source="camera"]'),
      ).toHaveCount(1, { timeout: 20_000 });
      await pageA.screenshot({ path: join(OUT, `call-after-leave-${label}.png`) });

      // A leaves; the call ends.
      await pageA.getByTestId('call-leave-panel').click();
      await expect(pageA.getByTestId('call-panel')).toBeHidden({ timeout: 20_000 });

      await ctxA.close();
      await ctxB.close();
      // The browser is this test's own launch, not the runner's fixture: left
      // open, the 1x pass's Chromium (two WebRTC pages) stays resident while
      // the next test runs.
      await browser.close();
    });
  }
});
