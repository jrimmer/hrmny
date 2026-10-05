/**
 * #111 — the assertion every "live" spec has been missing: an OPEN page
 * observing a gateway dispatch in real time.
 *
 * Two members, two contexts, real server. A posts a message via REST on a
 * channel both belong to; B's page — open on that channel, gateway READY,
 * watermark seeded — must observe the LIVE dispatch with no reload: the
 * store's dispatch watermark (`lastSeq`) advances and the message renders.
 * The no-reload property is proven positively (a marker set in the page's
 * JS context survives through the assertion), not assumed.
 *
 * The second pass forces the negotiated fallback: the documented rig hook
 * (`localStorage['cytale.gateway.compression'] = 'zlib_stream'`, read by the
 * web composition root) pins the gateway codec, and the spec asserts the
 * Identify actually went out with `compress:"zlib_stream"` — the path a
 * browser WITHOUT native zstd rides (Safari-class; on this rig the default
 * Chromium build is itself zstd-less, so pass one already exercises the
 * same fallback — pass two proves the pinning plumbing end to end).
 */
import { test, expect, type APIRequestContext, type Browser, type Page } from '@playwright/test';

import {
  accessToken,
  API,
  apiRegister,
  makeE2EUser,
  registerVerifiedUser,
  seedWorkspaceWithChannel,
  uiLogin,
  verifyViaMailbox,
} from './helpers';


/** Recorder init script: capture the gateway Identify's negotiated codec. */
const IDENTIFY_RECORDER = `
  (() => {
    const Orig = window.WebSocket;
    window.__identify = [];
    window.WebSocket = class extends Orig {
      send(data) {
        try {
          if (typeof data === 'string' && data.indexOf('"op":2,') !== -1) {
            const frame = JSON.parse(data);
            if (frame.op === 2) window.__identify.push(frame.d?.compress ?? 'absent');
          }
        } catch {}
        super.send(data);
      }
    };
  })();
`;

/** Pin the negotiated codec before any app code runs (#111 rig hook). */
const PIN_ZLIB = `localStorage.setItem('cytale.gateway.compression', 'zlib_stream');`;

/** B's store watermark + liveness marker, read from the dev debug handle. */
async function bState(page: Page): Promise<{ lastSeq: number; epoch: number }> {
  return page.evaluate(() => {
    const st = (globalThis as { __cytaleStore?: { getState: () => { lastSeq: number } } }).__cytaleStore;
    return {
      lastSeq: st ? st.getState().lastSeq : -1,
      epoch: (globalThis as { __pageEpoch?: number }).__pageEpoch ?? 0,
    };
  });
}

/** Open B on the channel, riding out the known workspace-hydrate race. */
async function openBOnChannel(page: Page, wsId: string, chId: string): Promise<void> {
  await page.goto(`/#/workspace/${wsId}/channel/${chId}`);
  await page.waitForSelector('[data-testid="message-item"]', { timeout: 20_000 }).catch(async () => {
    // The hydrate race: the reload re-runs the boot hydrate so the rail and
    // channel appear; a second reload covers the observed double-miss.
    await page.reload();
    await page.waitForSelector('[data-testid="message-item"]', { timeout: 20_000 }).catch(async () => {
      await page.reload();
      await page.waitForSelector('[data-testid="message-item"]', { timeout: 20_000 });
    });
  });
  // Liveness marker: if a reload/navigation ever happened below, this would
  // be gone and the live-observation claim would be false.
  await page.evaluate(() => {
    (globalThis as { __pageEpoch?: number }).__pageEpoch = 1;
  });
}

async function rigTwoMembers(
  browser: Browser,
  request: APIRequestContext,
  label: string,
  initScripts: string[],
): Promise<{ pageA: Page; pageB: Page; chId: string; tokenA: string }> {
  const ctxA = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const ctxB = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  for (const script of initScripts) await ctxB.addInitScript(script);

  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  // A owns the workspace; B joins through an invite BEFORE B's session
  // boots, so B's READY hydration carries the membership.
  await registerVerifiedUser(pageA, `ld${label}`);
  const tokenA = await accessToken(pageA);
  const a = { authorization: `Bearer ${tokenA}` };
  const { wsId, chId } = await seedWorkspaceWithChannel(request, tokenA, `ld-${label}-${Date.now().toString(36)}`);

  const userB = makeE2EUser();
  await apiRegister(userB);
  await verifyViaMailbox(userB);
  const loginB = await request.post(`${API}/auth/login`, {
    data: { identifier: userB.username, password: userB.password },
  });
  const tokenB0 = (await loginB.json()).access_token as string;
  const inv = await request.post(`${API}/workspaces/${wsId}/invites`, { headers: a, data: {} });
  const invBody = await inv.json();
  const code = (invBody.invite?.code ?? invBody.code ?? invBody.invite?.id) as string;
  expect(
    (await request.post(`${API}/invites/${code}`, {
      headers: { authorization: `Bearer ${tokenB0}` },
      data: {},
    })).ok(),
  ).toBe(true);

  // One seeded message so the page has an anchor before the LIVE post.
  await request.post(`${API}/channels/${chId}/messages`, {
    headers: a,
    data: { content: `anchor before live ${label}` },
  });

  await uiLogin(pageB, userB);
  await openBOnChannel(pageB, wsId, chId);
  return { pageA, pageB, chId, tokenA };
}

test.describe('#111 live gateway dispatch observation', () => {
  test('A posts via REST; B’s open page observes the dispatch (default negotiation)', async ({
    browser,
    request,
  }) => {
    const { pageA, pageB, chId, tokenA } = await rigTwoMembers(browser, request, 'default', []);
    const marker = `LIVE-DISPATCH-${Date.now().toString(36)}`;

    const before = await bState(pageB);
    expect(before.lastSeq, 'B’s watermark is seeded by READY hydration').toBeGreaterThan(0);

    await request.post(`${API}/channels/${chId}/messages`, {
      headers: { authorization: `Bearer ${tokenA}` },
      data: { content: marker },
    });

    // The live assertion the rig was missing: watermark advances and the
    // message renders — with NO reload (the epoch marker survives).
    await expect
      .poll(async () => (await bState(pageB)).lastSeq, { timeout: 15_000, intervals: [250, 500, 1_000] })
      .toBeGreaterThan(before.lastSeq);
    await expect(
      pageB.locator('[data-testid="message-item"]', { hasText: marker }),
    ).toBeVisible({ timeout: 10_000 });
    expect((await bState(pageB)).epoch, 'the observation happened on the same live page').toBe(1);
    void pageA;
  });

  test('forced fallback: pinned zlib_stream negotiation observes the live dispatch', async ({
    browser,
    request,
  }) => {
    const { pageB, chId, tokenA } = await rigTwoMembers(browser, request, 'zlibpin', [
      PIN_ZLIB,
      IDENTIFY_RECORDER,
    ]);
    const marker = `LIVE-DISPATCH-FB-${Date.now().toString(36)}`;

    // The Identify actually carried the pinned codec — negotiation honored
    // the hook end to end. Polled: the openOnChannel reloads re-run the init
    // scripts (resetting the recorder) and the post-restore gateway boots a
    // moment behind the page.
    await expect
      .poll(
        async () =>
          pageB.evaluate(
            () => ((globalThis as { __identify?: string[] }).__identify ?? []).join('\n'),
          ),
        { timeout: 10_000 },
      )
      .toContain('zlib_stream');

    const before = await bState(pageB);
    expect(before.lastSeq).toBeGreaterThan(0);

    await request.post(`${API}/channels/${chId}/messages`, {
      headers: { authorization: `Bearer ${tokenA}` },
      data: { content: marker },
    });

    await expect
      .poll(async () => (await bState(pageB)).lastSeq, { timeout: 15_000, intervals: [250, 500, 1_000] })
      .toBeGreaterThan(before.lastSeq);
    await expect(
      pageB.locator('[data-testid="message-item"]', { hasText: marker }),
    ).toBeVisible({ timeout: 10_000 });
    expect((await bState(pageB)).epoch).toBe(1); // still the same live page
  });
});
