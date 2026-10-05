/**
 * Responsive matrix (#86) — the band gate plan 003 U7 did not have.
 *
 * plan 003 shipped ONE mobile leg (390×844, `mobile.live.spec.ts`) and no tablet
 * leg, so the 768–1279px band has never had a test — and it is broken: the
 * shell's grid drops its 4th track below 1280px (`shell.css`'s
 * `@media (max-width: 1279px)`) while AppShell still renders the members
 * aside (`AppShell.tsx`'s `membersHidden || (isMobile && memberListCollapsible)`
 * guard only unmounts it below 768px). The aside is therefore a 4th grid
 * child with no track, and auto-placement puts it in the shell's second ROW:
 * measured 72×306 at (0,462) in a 1024×768 viewport — the "member list
 * collapsed into a bottom strip" in the ticket's iPad screenshot.
 *
 * This spec sweeps the four target bands, asserts the shell's REGION
 * CONTRACT for each, and writes screenshots to the untracked research
 * evidence dir so the ticket can carry a width × surface table instead of
 * prose.
 *
 * The contract (per band):
 *   - every region that is in flow sits side by side: y == 0 and full height
 *   - the members rail, when rendered as a rail, is at least MEMBERS_MIN wide
 *   - the pane never starves below PANE_MIN (a conversation needs it)
 *   - phone: the topbar is the chrome (no left cluster, no in-flow rail);
 *     the pane starts at the topbar's bottom edge
 *   - no two regions overlap
 *
 * The numbers are the shell's own ratified bounds (AppShell.tsx):
 * SIDEBAR_MIN/MAX 220/480, MEMBERS_MIN/MAX 220/480, rail 72px.
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  accessToken,
  registerVerifiedUser,
  reloadIntoFirstWorkspace,
  seedMessage,
  seedWorkspaceWithChannel,
} from './helpers';

/** Untracked by policy (.gitignore: /docs/research/screenshots/). */
const EVIDENCE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'docs',
  'research',
  'screenshots',
  '2026-09-12-responsive-matrix',
);

const RAIL = 72;
const MEMBERS_MIN = 220;
const PANE_MIN = 360;

type BandKind = 'phone' | 'tablet' | 'desktop';

interface Band {
  name: string;
  width: number;
  height: number;
  kind: BandKind;
}

/**
 * The four target bands. Phone landscape is included deliberately: 844×390 is
 * wider than the mobile breakpoint, so it takes the DESKTOP branch on a
 * 390px-tall screen — a band nobody has ever looked at.
 */
const BANDS: Band[] = [
  { name: 'phone-portrait-390x844', width: 390, height: 844, kind: 'phone' },
  { name: 'phone-landscape-844x390', width: 844, height: 390, kind: 'tablet' },
  { name: 'ipad-portrait-768x1024', width: 768, height: 1024, kind: 'tablet' },
  { name: 'ipad-landscape-1024x768', width: 1024, height: 768, kind: 'tablet' },
  // The owner's two reference captures (Discord on an 11" iPad Pro, 2×):
  // 1210×834 landscape and 834×1210 portrait. Paired like-for-like at the
  // exact widths the reference was measured at.
  { name: 'ipad11-landscape-1210x834', width: 1210, height: 834, kind: 'tablet' },
  { name: 'ipad11-portrait-834x1210', width: 834, height: 1210, kind: 'tablet' },
  { name: 'desktop-1440x900', width: 1440, height: 900, kind: 'desktop' },
];

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface BandGeometry {
  vw: number;
  vh: number;
  display: string | null;
  regions: Record<string, Rect | null>;
  paneMinWidthCss: string | null;
  /** The three-mode icons at the window's top right (hidden at phone until U3). */
  railIcons: string[];
  /** True while the 4th column holds a mode (the aside at desktop, the pane at tablet). */
  railOpen: boolean;
  /** Which mode is pressed, or null. */
  railPressed: string | null;
}

async function measure(page: Page): Promise<BandGeometry> {
  return page.evaluate(() => {
    const shell = document.querySelector('[data-testid="app-shell"]') as HTMLElement | null;
    const rect = (sel: string) => {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (!el) return null;
      const b = el.getBoundingClientRect();
      if (b.width === 0 || b.height === 0) return null;
      return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) };
    };
    const visible = (sel: string) => {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (!el) return false;
      const b = el.getBoundingClientRect();
      return b.width > 0 && b.height > 0;
    };
    return {
      vw: window.innerWidth,
      vh: window.innerHeight,
      display: shell ? getComputedStyle(shell).display : null,
      paneMinWidthCss: shell ? getComputedStyle(shell).gridTemplateColumns : null,
      railIcons: ['members', 'calls', 'threads'].filter((m) =>
        visible(`[data-testid="rail-icon-${m}"]`),
      ),
      // Presentation-agnostic: the rail's own body is mounted iff a mode is
      // open — in the desktop aside, the tablet pane replacement, or the phone
      // drawer. One signal for three presentations, so no band needs its own
      // definition of "open".
      railOpen: !!document.querySelector('[data-testid^="context-rail-body-"]'),
      railPressed:
        ['members', 'calls', 'threads'].find(
          (m) =>
            document
              .querySelector(`[data-testid="rail-icon-${m}"]`)
              ?.getAttribute('aria-pressed') === 'true',
        ) ?? null,
      regions: {
        'left-cluster': rect('[data-testid="left-cluster"]'),
        'message-pane': rect('[data-testid="message-pane"]'),
        'member-list': rect('[data-testid="member-list"]'),
        'mobile-topbar': rect('[data-testid="mobile-topbar"]'),
      },
    };
  });
}

function overlaps(a: Rect, b: Rect): boolean {
  const TOL = 1; // subpixel rounding
  return (
    a.x + a.w > b.x + TOL &&
    b.x + b.w > a.x + TOL &&
    a.y + a.h > b.y + TOL &&
    b.y + b.h > a.y + TOL
  );
}

/** Assert the shell's region contract for a band. Returns a human summary. */
function assertBandContract(band: Band, geo: BandGeometry): string[] {
  const lines: string[] = [];
  const inFlow = Object.entries(geo.regions).filter(([, r]) => r !== null) as Array<[string, Rect]>;

  if (band.kind === 'phone') {
    const bar = geo.regions['mobile-topbar'];
    const pane = geo.regions['message-pane'];
    expect(bar, `${band.name}: the topbar is the phone chrome`).not.toBeNull();
    expect(pane, `${band.name}: the pane renders`).not.toBeNull();
    expect(bar!.y, `${band.name}: topbar rides the top edge`).toBe(0);
    expect(bar!.w, `${band.name}: topbar spans the viewport`).toBe(geo.vw);
    expect(bar!.h, `${band.name}: topbar is a bounded 44px+ control band`).toBeGreaterThanOrEqual(44);
    expect(pane!.y, `${band.name}: the pane starts under the topbar`).toBe(bar!.y + bar!.h);
    expect(geo.regions['left-cluster'], `${band.name}: no desktop left cluster`).toBeNull();
    lines.push(`topbar ${bar!.h}px at y0; pane y${pane!.y} ${pane!.w}×${pane!.h}`);
  } else {
    // Tablet + desktop: the shell is a ROW of full-height regions.
    expect(
      geo.regions['mobile-topbar'],
      `${band.name}: the mobile topbar must not render above the phone band`,
    ).toBeNull();
    expect(geo.regions['left-cluster'], `${band.name}: the desktop left cluster renders`).not.toBeNull();

    // The invariant the tablet band violates: every region stays in the
    // shell's FIRST row and spans its full height. A region pushed into a
    // second row is a leftover strip, not a column.
    for (const [name, r] of inFlow) {
      expect(r.y, `${band.name}: ${name} sits in the shell's first row (y=0), not stacked`).toBe(0);
      expect(r.h, `${band.name}: ${name} spans the full shell height`).toBe(geo.vh);
    }
  }

  const pane = geo.regions['message-pane'];
  if (pane) {
    expect(pane.w, `${band.name}: the pane is not starved (>= ${PANE_MIN}px)`).toBeGreaterThanOrEqual(PANE_MIN);
  }

  const members = geo.regions['member-list'];
  if (members && band.kind !== 'phone') {
    // A members RAIL must be a usable column, not a leftover strip.
    expect(members.w, `${band.name}: the members rail is a usable column (>= ${MEMBERS_MIN}px)`).toBeGreaterThanOrEqual(MEMBERS_MIN);
    lines.push(`members rail ${members.w}×${members.h} at (${members.x},${members.y})`);
  } else {
    lines.push('members rail: not rendered as a column');
  }

  for (let i = 0; i < inFlow.length; i++) {
    for (let j = i + 1; j < inFlow.length; j++) {
      const [an, a] = inFlow[i]!;
      const [bn, b] = inFlow[j]!;
      expect(overlaps(a, b), `${band.name}: ${an} and ${bn} must not overlap`).toBe(false);
    }
  }

  const paneInfo = pane ? `pane ${pane.w}×${pane.h} at (${pane.x},${pane.y})` : 'pane: absent';
  const cluster = geo.regions['left-cluster'];
  lines.unshift(
    `columns: ${geo.paneMinWidthCss ?? 'n/a'} | ${paneInfo}` +
      (cluster ? ` | left cluster ${cluster.w}×${cluster.h} at (${cluster.x},${cluster.y})` : ''),
  );
  lines.push(`rail reserve: ${RAIL}px`);
  return lines;
}

test.describe('responsive matrix (#86)', () => {
  for (const band of BANDS) {
    test(`${band.name} — shell region contract`, async ({ page, request }) => {
      test.setTimeout(120_000);
      mkdirSync(EVIDENCE_DIR, { recursive: true });

      await page.setViewportSize({ width: band.width, height: band.height });
      await registerVerifiedUser(page, `m${band.width}`);

      // Real data: a workspace, a channel, and a short conversation so the
      // pane has rows to lay out (a hero-only page would hide pane defects).
      const token = await accessToken(page);
      const wsName = `mtx-${band.width}-${Date.now().toString(36)}`;
      const { chId } = await seedWorkspaceWithChannel(request, token, wsName);
      await seedMessage(request, token, chId, 'responsive matrix: first row');
      await seedMessage(request, token, chId, 'responsive matrix: second row, wide enough to show a wrap');

      await page.setViewportSize({ width: band.width, height: band.height });
      // Boot into the seeded channel (a plain reload restores Home).
      await reloadIntoFirstWorkspace(page);
      await page.waitForSelector('[data-testid="app-shell"]', { timeout: 15_000 });
      await page.waitForTimeout(1200); // settle: hydration + reconcile

      const geo = await measure(page);
      // Report the measurement BEFORE asserting, so a failing band still
      // documents its geometry in the run output (and the ticket table).
      console.log(`[${band.name}] ${JSON.stringify(geo)}`);

      await page.screenshot({
        path: join(EVIDENCE_DIR, `${band.name}-messages.png`),
      });

      // The 4th column: OPEN on Members at desktop (owner direction 2026-09-13:
      // *"On desktop or viewports similarly wide, show the member list by
      // default"*), HIDDEN below 1280px — where opening it costs the
      // conversation (tablet replaces the pane, phone is a modal drawer) and
      // where the phone shell's `aria-hidden` contract needs it shut at rest.
      //
      // Both halves are asserted as hard as each other: at desktop the OPEN
      // default is the contract, and asserting only "an icon opens it" would
      // pass for a column that never started open.
      if (band.kind === 'desktop') {
        expect(geo.railOpen, `${band.name}: the 4th column starts OPEN`).toBe(true);
        expect(geo.railPressed, `${band.name}: Members is the pressed mode`).toBe('members');
      } else {
        expect(geo.railOpen, `${band.name}: the 4th column starts HIDDEN`).toBe(false);
        expect(geo.railPressed, `${band.name}: nothing pressed at rest`).toBeNull();
      }

      // Every band now: the owner's 2026-09-12 direction put all three icons in
      // the phone topbar too, and Home is an ordinary case.
      {
        expect(
          geo.railIcons,
          `${band.name}: members, calls and threads icons are all present`,
        ).toEqual(['members', 'calls', 'threads']);

        // The 2026-09-13 addition: while the column is OPEN at desktop its three
        // icons ride INSIDE it (its own header), and the message pane carries no
        // second set — the column arrived over the corner the icons sat in, and
        // the control that was pressed is in the header of what it opened. Two
        // sets would leave the pressed state ambiguous.
        if (band.kind === 'desktop') {
          const placement = await page.evaluate(() => ({
            inColumn: document.querySelectorAll(
              '[data-testid="member-list"] [data-testid^="rail-icon-"]',
            ).length,
            inPane: document.querySelectorAll(
              '[data-testid="message-pane"] [data-testid^="rail-icon-"]',
            ).length,
          }));
          expect(placement.inColumn, `${band.name}: the icons live in the column header`).toBe(3);
          expect(placement.inPane, `${band.name}: and are NOT duplicated in the pane header`).toBe(
            0,
          );
        }

        // Normalise to the CLOSED state first, so the "an icon opens it" half is
        // asserted from the same place in every band (desktop arrives open).
        if (geo.railOpen) {
          await page.getByTestId('rail-icon-members').click({ timeout: 15_000 });
          await page.waitForTimeout(400);
          expect(
            (await measure(page)).railOpen,
            `${band.name}: the same icon closes the column`,
          ).toBe(false);
        }

        const icon = page.getByTestId('rail-icon-members');
        await icon.waitFor({ state: 'visible' });
        await icon.click({ timeout: 15_000 });
        await page.waitForTimeout(600);
        const opened = await measure(page);
        expect(opened.railOpen, `${band.name}: the icon opens the column`).toBe(true);
        expect(opened.railPressed, `${band.name}: the pressed icon reflects the mode`).toBe(
          'members',
        );
        await page.screenshot({ path: join(EVIDENCE_DIR, `${band.name}-rail.png`) });

        // Escape closes it and returns focus to the icon that opened it — the
        // keyboard exit, which the first pass of this work shipped without.
        await page.keyboard.press('Escape');
        await page.waitForTimeout(400);
        const escaped = await measure(page);
        expect(escaped.railOpen, `${band.name}: Escape closes the column`).toBe(false);
        const focused = await page.evaluate(
          () => document.activeElement?.getAttribute('data-testid') ?? null,
        );
        // Focus returns to the icon that opened it — at tablet and desktop.
        //
        // The tablet half used to be a recorded limitation: down there the mode
        // REPLACES the pane, so the icons live inside the swapped-out content and
        // closing the column unmounted the very icon that opened it — focus fell
        // to the body, and this assertion pinned that as known behaviour. The
        // 2026-09-13 change (the icons ride inside the column's header at desktop
        // too) made that unmount the COMMON case, so RailIcons now falls back to a
        // live DOM query when the pressed set is detached — which fixes the old
        // tablet edge as a side effect.
        //
        // Phone is a different mechanism and stays as it was: the drawer is a
        // Radix dialog, RailIcons stands aside for `[role="dialog"]` by design,
        // and the drawer's own dismiss path owns focus — with no Dialog.Trigger to
        // restore to, it lands on <body>. The phone surface has its own controls.
        if (band.kind === 'phone') {
          expect(
            focused,
            `${band.name}: the modal drawer's own Escape path owns focus (unchanged)`,
          ).toBeNull();
        } else {
          expect(focused, `${band.name}: focus returns to the icon that opened it`).toBe(
            'rail-icon-members',
          );
        }

        // Same icon again closes it — the toggle contract, at EVERY band. This
        // is what forced the rail drawer below the topbar at phone: while it
        // covered the bar, no icon was reachable and the owner's model did not
        // hold there at all.
        await page.getByTestId('rail-icon-members').click({ timeout: 15_000 });
        await page.waitForTimeout(400);
        // At phone the SAME icon also rides the panel's own header, and that
        // copy is the pressable one: a modal drawer makes everything outside it
        // inert, so the topbar's copy cannot be clicked while the panel is open.
        // Scoped to the dialog for exactly that reason — two copies exist there,
        // and only one of them is reachable.
        const closeIcon =
          band.kind === 'phone'
            ? page.getByRole('dialog').getByTestId('rail-icon-members')
            : page.getByTestId('rail-icon-members');
        await closeIcon.click({ timeout: 15_000 });
        await page.waitForTimeout(400);
        const closed = await measure(page);
        expect(closed.railOpen, `${band.name}: the same icon closes the column`).toBe(false);

        // A DIFFERENT icon replaces the mode rather than stacking two — asserted
        // at EVERY band now, including phone, because the icons ride the panel
        // header there too and so stay reachable while it is open.
        // The FIRST click opens from CLOSED, so it targets the topbar copy; the
        // one that closes has to target the panel's copy at phone, where the
        // topbar is inert under the modal.
        const inPanel = (m: string) =>
          band.kind === 'phone'
            ? page.getByRole('dialog').getByTestId(`rail-icon-${m}`)
            : page.getByTestId(`rail-icon-${m}`);
        await page.getByTestId('rail-icon-calls').click({ timeout: 15_000 });
        await page.waitForTimeout(500);
        const swapped = await measure(page);
        expect(swapped.railOpen, `${band.name}: another icon opens the column`).toBe(true);
        expect(swapped.railPressed, `${band.name}: the mode is REPLACED, not stacked`).toBe('calls');
        await inPanel('calls').click({ timeout: 15_000 });
      }

      // Settings is one of the four B1–B4 surfaces and the worst squeeze at
      // tablet today; capture it per band too. Below the phone breakpoint the
      // gear lives INSIDE the navigation drawer (B4: settings is reachable
      // only through it), so the drawer has to be opened first.
      if (band.kind === 'phone') {
        await page.getByRole('button', { name: 'Open navigation' }).click();
        await page.waitForTimeout(400);
      }
      await page.getByTestId('user-settings-toggle').click();
      await page.waitForTimeout(700);
      await page.screenshot({
        path: join(EVIDENCE_DIR, `${band.name}-settings.png`),
      });

      // Assert LAST: the evidence above is the ticket's deliverable, so a
      // failing band must still produce its screenshots.
      const summary = assertBandContract(band, geo);
      // Surface the measurement in the report even on success.
      console.log(`[${band.name}]\n  ` + summary.join('\n  '));

      // The icons are the only way to open a mode, so they exist on every band:
      // the pane header at desktop, the RailPane header at tablet, the topbar at
      // phone. Asserted non-empty rather than === 3 in case a future band wants
      // a subset, but the three modes must all be reachable somewhere.
      expect(
        geo.railIcons.length,
        `${band.name}: the three modes are all reachable`,
      ).toBeGreaterThanOrEqual(3);
    });
  }
});
