# Design system: Hotline Pink in Ordo

Ordo's UI uses the **Hotline Pink** design system — a dark synthwave palette with a clean, digital HUD feel.
Professional first; the neon is an accent, not the wallpaper. Tokens and component classes live in
[`apps/web/src/styles/app.css`](../apps/web/src/styles/app.css). Ordo adds a [light theme](#light-theme) built from
the same tokens.

## Balance

**~80% charcoal, ~17% pink, ~3% cyan.** If a screen looks pink, it's too pink.

| Token                           | Value                             | Used for                                                                       |
| ------------------------------- | --------------------------------- | ------------------------------------------------------------------------------ |
| `bg`                            | `#09090b`                         | Page ground; text on pink fills                                                |
| `surface`                       | `#121214`                         | Sidebar, panels, sticky group headers                                          |
| `raised`                        | `#1c191c`                         | Popovers, modals, active nav item                                              |
| `primary`                       | `#ff1493`                         | Primary buttons, section labels, kickers, selection, unread dots, active icons |
| `highlight`                     | `#ff5cb8`                         | Links, mentions, primary-button hover                                          |
| `deep`                          | `#c6006f`                         | Gradient ends only (brand bar, progress bars)                                  |
| `magenta`                       | `#ff00a8`                         | The faint top-right glow on HUD backgrounds only                               |
| `cyan`                          | `#2de2e6`                         | Focus rings, list bullets in markdown. Never a fill.                           |
| `text` / `muted` / `index`      | `#fff4fa` / `#b8aab2` / `#8e7985` | Body / secondary / identifiers and timestamps                                  |
| `border` / `border-soft`        | `#49313e` / `#2a1f26`             | Control and panel outlines / hairlines                                         |
| `success` / `warning` / `error` | `#22c55e` / `#f59e0b` / `#ef4444` | Done, in progress & urgent, errors & overdue                                   |

`index` (#8e7985, 5.0:1 on `bg`) replaces the system's `border`-as-text for identifiers, fixing the contrast
issue flagged in the design review.

### Workspace accents

Hotline Pink is the default. A workspace can pick another accent (Settings → General); `accentVariables()` in
`packages/shared/src/theme.ts` derives the rest from it the way Hotline Pink's tokens relate to each other —
`highlight` lighter, `deep` darker, `magenta` a touch warmer, the neutrals (`text`, `muted`, `index`, `border`,
`border-soft`, `raised`) faintly tinted with its hue — plus `on-primary`, the readable text colour on primary fills.
`useAccent` sets them on the document root while the workspace is open; sign-in pages stay pink. So: never hard-code
`#ff1493` or friends in components — use the tokens (`bg-primary`, `text-on-primary`, `accent-primary`,
`var(--color-primary)`), or the accent won't follow. Team colours are data and keep their own colour.

## Light theme

Hotline Pink is a dark system; the light theme is Ordo's own translation of it, not part of the original. Same
shapes, type and idioms; the balance becomes ~80% paper, and the pink gets deeper so it can carry small text.

| Token                           | Light value                       | Why                                                                  |
| ------------------------------- | --------------------------------- | -------------------------------------------------------------------- |
| `bg` / `surface` / `raised`     | `#fbf9fa` / `#f5f0f2` / `#ffffff` | Faintly pink paper; popovers and modals are white                    |
| `primary`                       | `#cc006f`                         | `#ff1493` is 3.2:1 on paper; this is 4.8:1 on `surface`, like labels |
| `highlight` / `deep`            | `#a30059` / `#7a0043`             | Links go _darker_ than primary on paper (lighter on charcoal)        |
| `on-primary`                    | `#ffffff`                         |                                                                      |
| `cyan`                          | `#0b8a8f`                         | Focus rings need 3:1; `#2de2e6` is 1.4:1 on paper                    |
| `text` / `muted` / `index`      | `#1d1117` / `#5d4c55` / `#6e5e67` | All ≥ 4.5:1 on `surface`                                             |
| `border` / `border-soft`        | `#d9c9d2` / `#ede3e8`             |                                                                      |
| `success` / `warning` / `error` | `#15803d` / `#c2610c` / `#dc2626` | Deeper, so status icons reach 3:1                                    |
| `chart-2`                       | `#2563eb`                         | Re-checked for color-blind separation from `primary` on paper        |
- The theme is a choice per browser — System (default), Light or Dark — stored as `ordo:theme` and applied by an
  inline script in `index.html` before the first paint, so there's no flash. `src/lib/theme.ts` owns it at runtime;
  the resolved theme is `data-theme="light|dark"` on `<html>`.
- Components never branch on the theme: the light values are the same tokens, overridden under
  `:root[data-theme="light"]`. Hover and selection washes are `--wash-1/2/3` (the text colour at a few percent) instead
  of `white/5`, so use `bg-text/5` or the washes, never `bg-white/…`.
- Glows are mostly put away in light (`--glow-chip: none`, softer brand and LED glows); glows on paper look like
  smudges.
- Workspace accents: `accentVariables(color, 'light')` deepens the accent until it reaches 4.5:1 on the surface and
  tints the paper and neutrals with its hue.
- User-chosen colours (statuses, projects) pass through `useThemedColor`, which darkens ones under 3:1 on paper —
  a cyan or yellow label picked against charcoal would vanish otherwise. Label dots get a faint outline instead.

## Shape

- **No rounded corners**, anywhere — enforced globally.
- Panels, cards, modals and popovers are **chamfered** with `clip-path` (top-right and bottom-left cut;
  14 px for panels, 8 px for buttons and small panels). The `panel` class paints the 1 px border on the
  outer layer and the fill on `::before`, so the border follows the cut.
- Status icons are **squares** that fill up with progress (dashed → outline → half → solid with check);
  triage is a diamond. Avatars are chamfered squares.
- HUD **brackets** (`.brackets`) frame empty states and the auth card.

## Type

- **Space Grotesk** (variable) for UI text and headings; **JetBrains Mono** for identifiers, labels, buttons,
  kickers, kbd and data. Both are bundled (Fontsource) — no external font requests.
- The website uses 17 px body text; Ordo is a dense tool, so lists use 13.5 px and body text 14 px. Headings
  keep the 700 weight and negative tracking.
- Mono labels are uppercase with wide tracking (`section-label`: `01 // SECTION ———`); data is lowercase
  (`> created 2 hours ago`).

## Idioms

- Page headers carry a mono **kicker** breadcrumb: `ENG // ACTIVE`.
- Empty states read like a terminal: `// nothing here▌` with a blinking cursor.
- Buttons use `→` that nudges right on hover.
- Glow is reserved for brand pink and LEDs: the brand bar, unread dots, the realtime LED.
- Focus is always a 2 px cyan outline (inset on list rows).
- All motion is 180 ms `cubic-bezier(0.2, 0.7, 0.2, 1)` and disabled under `prefers-reduced-motion`.

## Charts

Charts (`components/Charts.tsx`) follow the same rules: square ends, 2 px lines, a recessive grid in `border-soft`,
labels and values in text tokens (never the series color), a legend for two or more series and a hover readout. The
"completed" series is the accent; the context series (scope, created) is `--color-chart-2` (#4f8ff7) and dashed, so
it never depends on color alone. That pair passes color-blind separation checks against `bg`; re-check if you add a
series.

## Not adopted (yet)

- The website's scanline overlay — too busy behind dense lists.
- User-chosen colors (labels, teams, projects, workflow statuses) are data and may fall outside the palette;
  the defaults are drawn from it.
