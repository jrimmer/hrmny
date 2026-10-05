# Hrmny brand — icon standard, color scheme, and usage

Everything visual that carries the product's identity: the mark, the icon
assets derived from it, the color tokens they must live inside, and the rules
for using both. Established 2026-09-18 when the app was renamed Hrmny and the
current artwork was supplied.

Authoritative sources (committed here so the originals can't be lost):

| source | file | what it is |
|---|---|---|
| app icon | `docs/design/assets/hrmny-app-icon.png` | glyph on solid black, 1254×1254, **RGB (opaque)** |
| favicon / mark | `docs/design/assets/hrmny-favicon.png` | glyph on transparency, 1254×1254, RGBA |

The glyph fills ~76% of the source canvas. Its palette, measured: **cyan
`#00e0e0` ramp ≈ 26%** of the glyph (the dominant hue), magenta/violet
`#e000e0`–`#6020e0` ≈ 8.5%, **amber `#e0a020` ≈ 5.5%**, on a black field.

---

## 1. Icon standard

One mark, three surfaces. Every derivative regenerates from the sources above
— never hand-edit a generated asset (the same CNG lesson as the Android
signing config: hand edits survive exactly one regeneration).

### 1.1 Mobile — `apps/mobile/assets/` (consumed by `expo prebuild`)

| file | spec | derivation |
|---|---|---|
| `icon.png` | 1024×1024, **opaque** | app icon resized; iOS requires no alpha |
| `android-icon-foreground.png` | 1024×1024, transparent | glyph scaled to **60%** of the canvas (inside the adaptive-icon safe zone) |
| `android-icon-background.png` | 1024×1024, opaque | solid black `#000000` (matches the mark's field) |
| `android-icon-monochrome.png` | 1024×1024, transparent | white silhouette — glyph alpha used as a mask, filled white |

Rules:

- iOS icon: content stays inside ~80% of the canvas; Apple rounds the corners.
- Android monochrome is a SILHOUETTE, not a recolor — derive it from the
  alpha, never by hue-shifting the artwork.
- Bump `ios.buildNumber` / `android.versionCode` before every upload
  (`scripts/ios-release.sh --bump-build-number` does the iOS side).
- Android picks up new assets on its next `scripts/android-release.sh` run;
  iOS needs a `scripts/ios-release.sh` run to carry them.

### 1.2 Desktop — `apps/desktop/src-tauri/icons/`

Regenerate the whole set with:

```bash
cd apps/desktop && pnpm tauri icon <1024×1024 transparent source>
```

- Source convention: the transparent GLYPH (not the black field), scaled to
  ~78% of the canvas — desktop icons sit on OS-drawn backgrounds.
- `tauri.conf.json` references exactly five files: `32x32.png`,
  `128x128.png`, `128x128@2x.png`, `icon.icns`, `icon.ico`.
- The tool also emits `64x64.png`, `Square*Logo.png`, `StoreLogo.png` and
  `android/` + `ios/` subfolders that this config does NOT reference — delete
  them instead of committing.

### 1.3 Web — `apps/web/public/icons/`

| file | spec | usage |
|---|---|---|
| `icon-192.png` | 192×192, transparent | favicon + apple-touch (`index.html`), manifest `any` |
| `icon-512.png` | 512×512, transparent | manifest `any` — glyph at 80% of canvas |
| `maskable-512.png` | 512×512, black field | manifest `maskable` — glyph at 60% (inside the 66% safe circle) |
| `hrmny-mark.svg` | vector | in-app vector mark |

**Gotcha — `/icons/*` is Phoenix-served, not web-served.** Dev proxies
`/icons` and `/manifest.json` to `:4000`, and the Docker build stages the SPA
`dist/` into the server's `priv/static` for production. `apps/web/public/`
is the committed SOURCE, but the local dev server reads the server's staged
copy — refresh `apps/server/priv/static/icons/` (gitignored) or dev keeps
showing stale icons no matter what you commit.

---

## 2. Color scheme

### 2.1 Token architecture — `apps/web/src/app/theme/tokens.css`

Three layers, in dependency order:

1. **Raw values** (`--tk-*`, on `:root[data-theme='dark']`) — the only place
   a hex literal may live.
2. **Semantic aliases** (`--color-*`) — what shell.css and components
   consume. No component reads a `--tk-*` directly.
3. **Tailwind bridge** (`@theme`) — generates the `bg-*`/`text-*` utilities.

Shell.css's header states the escalation rule this enforces: surfaces step at
most one level, color is reserved for meaning (unread, mentions, presence) —
never decoration.

### 2.2 Surfaces (dark is the only theme; light mirrors dark today)

| token | value | role |
|---|---|---|
| `--tk-surface-strong` | `#070709` | deepest chrome: popovers, mobile topbar, input wells |
| `--tk-background-deep` | `#0e0e11` | rail's step; the phone pane wash lands here |
| `--tk-background` | `#131416` | app background / member rail |
| `--tk-surface-emphasized` | `#1a1a1e` | **message pane** |
| `--tk-surface-hover-quiet` | `#24262a` | hover on rows that also carry a selected state |
| `--tk-surface-hover` | `#2e3035` | hover |
| `--tk-surface` / `--tk-border` | `#2e2e34` | sidebar/rail surface and lines |
| `--tk-surface-selected` | `#35373c` | selection pill |
| `--tk-line-inset` | `#111216` | dock seams (sunken look) |

Text: `--tk-text-top #f2f3f5` (primary) · `--tk-text #dbdee1` (content) ·
`--tk-text-muted #949ba4`.

### 2.3 Accent + the highlight

| token | value | notes |
|---|---|---|
| `--tk-action` | `#5865f2` | blurple — buttons, links, accent utilities |
| `--tk-action-hover` | `#4752c4` | pressed/hover step |
| `--tk-on-action` | `#ffffff` | text/glyph on any action-colored plate |
| `--tk-focus-ring` | `#8ea1ff` | keyboard focus ring |
| `--tk-highlight` | `#00808c` | **NEW 2026-09-18** — see below |

**Highlight (the logo cyan).** Chosen from the mark's dominant hue and first
applied to the rail Home icon's mouseover plate (`shell.css`
`.rail-home:hover`), replacing the blurple there. `#00808c` is a deep step of
the glyph's `#00e0e0` ramp: deep enough that white-on-it passes AA at
**4.70:1** (the blurple it replaced measured 4.61:1), saturated enough to
read as a highlight against the rail's near-black chrome.

Why cyan over the other logo hues:

- **amber `#e0a020`** — rejected: amber is `--tk-warning` AND
  `--tk-presence-idle`; it already means "something needs attention".
- **green** — rejected: the logo has almost none, and green is
  `--tk-success` / `--tk-presence-online`.
- **magenta/violet** — rejected: it is the blurple family we are moving away
  from, and low-share in the mark (~8.5%).
- **cyan** — the mark's single largest hue, unclaimed by any semantic token,
  and the highest-contrast option on the dark chrome.

Rollout is deliberately scoped to the Home hover first; widening `highlight`
to more surfaces (or eventually replacing `action`) is a separate decision,
but the token exists so that change is one line per surface.

### 2.4 Reserved colors — never decorative

| token | value | means |
|---|---|---|
| `--tk-success` / `--tk-presence-online` | `#23a55a` | success, online |
| `--tk-warning` / `--tk-presence-idle` | `#f0b232` | warning, idle |
| `--tk-danger` / `--tk-presence-dnd` | `#f23f43` | danger, do-not-disturb |
| `--tk-presence-offline` | `#80848e` | offline |

---

## 3. Usage rules

1. **No raw hex outside tokens.css.** Add a `--tk-*` raw + `--color-*` alias,
   then consume the alias. (The one sanctioned exception is shell.css's
   corpus-measured values, which are tokenized anyway.)
2. **Contrast bar:** white-on-color text and glyphs must clear **4.5:1**
   (the house standard; the blurple action and the cyan highlight were both
   picked against it). Graphical boundaries need 3:1. Check before proposing
   a color, not after.
3. **Reserved colors carry meaning only** — success/warning/danger/presence
   never decorate chrome. A new "highlight" use case takes `--tk-highlight`,
   not an existing semantic.
4. **The mark is never recolored or re-composed.** Derivatives are geometry
   (scale + safe zone) and, for Android monochrome, a white silhouette from
   the alpha channel.
5. **Safe zones:** adaptive-icon foreground/maskable content at ≤60% of the
   canvas; plain "any" icons at ~80%; iOS inside 80%.
6. **Regenerate, don't retouch.** Every generated asset documents its
   generation command above; if a generated file drifts from its source, the
   source wins.

---

*Provenance: rename + artwork supplied 2026-09-18; icon
derivation and the highlight token landed in `3d29d08` and the commit that
added this file. The workspace avatar tiles are NOT brand assets — their
hues come from `avatarHue(id)` and are intentionally per-workspace.*
