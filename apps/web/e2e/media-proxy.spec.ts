/**
 * External images through the media proxy, in a real browser.
 *
 * The app's CSP (`img-src 'self'`) admits no third-party image, so a bot's
 * embed image and a person's Markdown `![alt](url)` both load the SERVER's
 * copy: the embed's `proxy_url`, and the message's `content_proxy_urls`
 * entry. This spec serves a timeline carrying both, answers the proxy route
 * with a real PNG, and checks that each renders from the proxy (never the
 * source URL), that a failed proxy answer hides quietly, and that the images
 * pass axe.
 *
 * Fixture-backed (ux-world.ts): no server, no database.
 */
import { expect, test, type Page } from '@playwright/test';

import { BOT, CH, ME, mockApi, openChannel, signIn } from './ux-world';

// A real 320×160 PNG (diagonal colour bands): the proxy serves image bytes.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAUAAAACgCAIAAADywSLLAAAD4klEQVR42u3TMQ1CAQDFwJrACSLwgQmsoAMbSIGVgQkZP49cUgeXdr59Dun6eB/S93k6pNflfkh8/9s3uu7lu+sbXffy3fWNrnv57vpG1718d32j616+u77RdS/fXd/oupfvrm903ct31ze67uW76xtd9/Ld9Y2ue/nu+kbXvXx3faPrXr67vtF1L99d3+i6l++ub3Tdy3fXN7ru5bvrG1338t31ja57+e76Rte9fHd9o+tevru+0XUv313f6LqX765vdN3Ld9c3uu7lu+sbXffy3fWNrnv57vpG1718d32j616+u77RdS/fXd/oupfvrm903ct31ze67uW76xtd9/Ld9Y2ue/nu+kbXvXx3faPrXr67vtF1L99d3+i6l++ub3Tdy3fXN7ru5bvrG1338t31ja57+e76Rte9fHd9o+tevru+0XUv313f6LqX765vdN3Ld9c3uu7lu+sbXffy3fWNrnv57vpG1718d32j616+u77RdS/fXd/oupfvrm903ct31ze67uW76xtd9/Ld9Y2ue/nu+kbXvXx3faPrXr67vtF1L99d3+i6l++ub3Tdy3fXN7ru5bvrG1338t31ja57+e76Rte9fHd9o+tevru+0XUv313f6LqX765vdN3Ld9c3uu7lu+sbXffy3fWNrnv57vpG1718d32j616+u77RdS/fXd/oupfvrm903ct31ze67uW76xtd9/Ld9Y2ue/nu+kbXvXx3faPrXr67vtF1L99d3+i6l++ub3Tdy3fXN7ru5bvrG1338t31ja57+e76Rte9fHd9o+tevru+0XUv313f6LqX765vdN3Ld9c3uu7lu+sbXffy3fWNrnv57vpG1718d32j616+u77RdS/fXd/oupfvrm903ct31ze67uW76xtd9/Ld9Y2ue/nu+kbXvXx3faPrXr67vtF1L99d3+i6l++ub3Tdy3fXN7ru5bvrG1338t31ja57+e76Rte9fHd9o+tevru+0XUv313f6LqX765vdN3Ld9c3uu7lu+sbXffy3fWNrnv57vpG1718d32j616+u77RdS/fXd/oupfvrm903ct31ze67uW76xtd9/Ld9Y2ue/nu+kbXvXx3faPrXr67vtF1L99d3+i6l++ub3Tdy3fXN7ru5bvrG1338t31ja57+e76Rte9fHd9o+tevru+0XUv313f6LqX765vdN3Ld9c3uu7lu+sbXffy3fWNrnv57vpG1718d32j616+u77RdS/fXd/oupfvrm903ct31ze67uW76xtd9/Ld9Y2ue/nu+kbXvXx3faPrXr67vtF1L99d3+i6l++u7w9r3h9kSqLjvQAAAABJRU5ErkJggg==',
  'base64',
);

const EMBED_SRC = 'https://images.example.org/deploy-card.png';
const MD_SRC = 'https://img.example.com/whiteboard.png';
const BROKEN_SRC = 'https://img.example.com/gone.png';
const proxied = (name: string) => `/api/v1/media/proxy?u=${name}&e=1900000000&s=sig-${name}`;

const at = (mins: number) => new Date(Date.now() - mins * 60_000).toISOString();

const messages = [
  {
    id: '95000000901', channel_id: CH, thread_id: null, author_id: BOT, content: '', created_at: at(30), edited_at: null, attachments: null,
    embeds: [
      {
        title: 'Deploy OK',
        description: 'prod is green',
        image: { url: EMBED_SRC, proxy_url: proxied('card'), width: 640, height: 320 },
      },
    ],
  },
  {
    id: '95000000902', channel_id: CH, thread_id: null, author_id: ME, content: `The plan: ![the whiteboard](${MD_SRC}) — thoughts?`,
    created_at: at(20), edited_at: null, attachments: null,
    content_proxy_urls: { [MD_SRC]: proxied('wb') },
  },
  {
    id: '95000000903', channel_id: CH, thread_id: null, author_id: ME, content: `And this one is gone: ![old chart](${BROKEN_SRC})`,
    created_at: at(10), edited_at: null, attachments: null,
    content_proxy_urls: { [BROKEN_SRC]: proxied('gone') },
  },
];

async function setup(page: Page): Promise<{ proxyHits: string[]; externalHits: string[] }> {
  await page.setViewportSize({ width: 1280, height: 860 });
  await mockApi(page);
  const proxyHits: string[] = [];
  const externalHits: string[] = [];
  // Registered after mockApi, so these win for their paths.
  await page.route(`**/api/v1/channels/${CH}/messages**`, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ messages, oldest_id: null }) });
  });
  await page.route('**/api/v1/media/proxy**', async (route) => {
    const u = new URL(route.request().url()).searchParams.get('u') ?? '';
    proxyHits.push(u);
    if (u === 'gone') {
      await route.fulfill({
        status: 502,
        contentType: 'application/json',
        body: JSON.stringify({ error: { key: 'media_fetch_failed', code: 50201, message: 'The image could not be fetched.' } }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'image/png',
      headers: { 'x-content-type-options': 'nosniff', 'cache-control': 'private, max-age=3600, immutable' },
      body: PNG,
    });
  });
  // The source hosts must never be contacted by the browser.
  await page.route(/https:\/\/(images\.example\.org|img\.example\.com)\//, async (route) => {
    externalHits.push(route.request().url());
    await route.abort();
  });
  await signIn(page);
  await openChannel(page);
  return { proxyHits, externalHits };
}

async function loaded(page: Page, testId: string, index = 0): Promise<boolean> {
  return page
    .getByTestId(testId)
    .nth(index)
    .evaluate((img) => (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth > 0);
}

test.describe('media proxy: external images render from our own origin', () => {
  test('an embed image and a Markdown image both load their proxy copies; the source hosts are never hit', async ({ page }) => {
    const { proxyHits, externalHits } = await setup(page);

    const embed = page.getByTestId('embed-image');
    await expect(embed).toBeVisible();
    await expect(embed).toHaveAttribute('src', proxied('card'));
    await expect.poll(() => loaded(page, 'embed-image')).toBe(true);
    // "Open original" keeps the source one click away.
    await expect(page.getByTestId('embed-image-box')).toHaveAttribute('href', EMBED_SRC);

    const md = page.getByTestId('markdown-image').first();
    await expect(md).toBeVisible();
    await expect(md).toHaveAttribute('src', proxied('wb'));
    await expect(md).toHaveAttribute('alt', 'the whiteboard');
    await expect(md).toHaveAttribute('referrerpolicy', 'no-referrer');
    await expect.poll(() => loaded(page, 'markdown-image')).toBe(true);
    // The body reads as text + picture, never as raw `![…](…)` syntax.
    await expect(page.getByTestId('message-item').filter({ hasText: 'The plan:' })).not.toContainText('![');

    expect(proxyHits).toEqual(expect.arrayContaining(['card', 'wb']));
    expect(externalHits).toEqual([]);
  });

  test('a proxy failure hides the image quietly (no broken icon, no empty frame)', async ({ page }) => {
    await setup(page);
    const row = page.getByTestId('message-item').filter({ hasText: 'And this one is gone' });
    await expect(row).toBeVisible();
    await expect(row.getByTestId('markdown-image-box')).toBeHidden();
    await expect(row).toContainText('And this one is gone:');
  });

  test('the timeline with proxied images passes axe (WCAG 2.1 AA)', async ({ page }) => {
    await setup(page);
    await expect.poll(() => loaded(page, 'markdown-image')).toBe(true);
    await page.addScriptTag({ path: 'node_modules/axe-core/axe.min.js' });
    const violations = await page.evaluate(async () => {
      const axe = (window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: { id: string; nodes: unknown[] }[] }> } }).axe;
      const result = await axe.run(
        { include: [['[data-testid="embed-card"]'], ['[data-testid="message-content"]']] },
        { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } },
      );
      return result.violations.map((v) => `${v.id} (${v.nodes.length})`);
    });
    expect(violations).toEqual([]);
  });
});
