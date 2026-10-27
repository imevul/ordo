/**
 * Workspace accent colours. Hotline Pink is the default and lives in app.css; any other accent is
 * one hex colour from which the rest of the palette is derived the way Hotline Pink's is: lighter
 * and deeper variants, glows, and neutrals (borders, muted text) faintly tinted with its hue.
 */

export const DEFAULT_ACCENT = '#ff1493';

export const ACCENT_PRESETS: { name: string; color: string }[] = [
  { name: 'Hotline Pink', color: DEFAULT_ACCENT },
  { name: 'Ember', color: '#ff5a1f' },
  { name: 'Amber', color: '#f5a524' },
  { name: 'Acid', color: '#a3e635' },
  { name: 'Mint', color: '#2dd4a7' },
  { name: 'Electric', color: '#3b82f6' },
  { name: 'Violet', color: '#9b6bff' },
];

export const HEX_COLOR = /^#[0-9a-f]{6}$/i;

type Rgb = [number, number, number];

const toRgb = (hex: string): Rgb =>
  [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)) as Rgb;

function toHsl([r, g, b]: Rgb): [number, number, number] {
  const [rn, gn, bn] = [r / 255, g / 255, b / 255];
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l * 100];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h =
    max === rn
      ? ((gn - bn) / d + (gn < bn ? 6 : 0)) * 60
      : max === gn
        ? ((bn - rn) / d + 2) * 60
        : ((rn - gn) / d + 4) * 60;
  return [h, s * 100, l * 100];
}

function hsl(h: number, s: number, l: number): string {
  const sn = Math.max(0, Math.min(100, s)) / 100;
  const ln = Math.max(0, Math.min(100, l)) / 100;
  const k = (n: number) => (n + (((h % 360) + 360) % 360) / 30) % 12;
  const a = sn * Math.min(ln, 1 - ln);
  const f = (n: number) => ln - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return `#${[f(0), f(8), f(4)]
    .map((v) =>
      Math.round(v * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

/** WCAG relative luminance. */
function luminance(hex: string) {
  const [r, g, b] = toRgb(hex).map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }) as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string) {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m) as [number, number];
  return (x + 0.05) / (y + 0.05);
}

/** Light or dark: the resolved theme, after "follow the system" is applied. */
export type ThemeMode = 'dark' | 'light';

/** The background accents sit on. Accents below 3:1 against it are hard to see. */
export const THEME_BACKGROUND = '#09090b';

/** The light theme's panel fill: the darkest ground text sits on, so contrast is checked here. */
export const LIGHT_SURFACE = '#f5f0f2';

const LIGHT_TEXT = '#1c1118';

/**
 * `color`, or the same hue made darker until it reaches `min`:1 against `background`. For
 * user-chosen colours (labels, statuses, projects) that were picked against the dark theme.
 * Anything that isn't a hex colour (a CSS variable, say) is returned as it is.
 */
export function readableOn(color: string, background: string, min = 3): string {
  if (!HEX_COLOR.test(color) || contrast(color, background) >= min) return color;
  const [h, s, l] = toHsl(toRgb(color));
  for (let next = l - 2; next > 0; next -= 2) {
    const candidate = hsl(h, s, next);
    if (contrast(candidate, background) >= min) return candidate;
  }
  return hsl(h, s, 0);
}

/** A data colour as it should be drawn in `mode`: the light theme deepens faint ones. */
export const themedColor = (color: string, mode: ThemeMode) =>
  mode === 'light' ? readableOn(color, LIGHT_SURFACE) : color;

/**
 * CSS custom properties for an accent, or {} for Hotline Pink (app.css already has it). Keys are
 * the variable names set on the document root.
 */
export function accentVariables(
  color: string | null | undefined,
  mode: ThemeMode = 'dark',
): Record<string, string> {
  if (!color || !HEX_COLOR.test(color) || color.toLowerCase() === DEFAULT_ACCENT) return {};
  if (mode === 'light') return lightAccentVariables(color.toLowerCase());
  const [h, s, l] = toHsl(toRgb(color));
  const onPrimary =
    contrast(color, THEME_BACKGROUND) >= contrast(color, '#ffffff') ? THEME_BACKGROUND : '#ffffff';
  return {
    '--color-primary': color.toLowerCase(),
    '--color-highlight': hsl(h, s, Math.min(l + 14, 86)),
    '--color-magenta': hsl(h - 8, s, Math.max(Math.min(l - 4, 60), 40)),
    '--color-deep': hsl(h, s, Math.max(l - 15, 18)),
    '--color-on-primary': onPrimary,
    // Hotline Pink's neutrals carry its hue at low saturation; do the same for this one.
    '--color-text': hsl(h, 100, 98),
    '--color-muted': hsl(h, 9, 69),
    '--color-index': hsl(h, 9, 52),
    '--color-border': hsl(h, 20, 24),
    '--color-border-soft': hsl(h, 15, 14),
    '--color-raised': hsl(h, 6, 10),
  };
}

/**
 * The light theme's palette for an accent. Pink text on a pale ground needs a deeper pink than
 * on charcoal, so the accent is darkened until small text in it reads (4.5:1); links go a step
 * deeper, and the neutrals carry the hue as they do in the dark theme.
 */
function lightAccentVariables(color: string): Record<string, string> {
  const [h] = toHsl(toRgb(color));
  // The paper is tinted with the accent's hue, so check the accent against that paper.
  const surface = hsl(h, 18, 95);
  const primary = readableOn(color, surface, 4.5);
  const [, s, l] = toHsl(toRgb(primary));
  return {
    '--color-primary': primary,
    '--color-highlight': hsl(h, s, Math.max(l - 8, 15)),
    '--color-magenta': hsl(h - 8, s, Math.max(Math.min(l + 6, 60), 40)),
    '--color-deep': hsl(h, s, Math.max(l - 16, 12)),
    '--color-on-primary': contrast(primary, '#ffffff') >= 4.5 ? '#ffffff' : LIGHT_TEXT,
    '--color-bg': hsl(h, 25, 98),
    '--color-surface': surface,
    '--color-text': hsl(h, 25, 9),
    '--color-muted': hsl(h, 10, 33),
    '--color-index': hsl(h, 8, 40),
    '--color-border': hsl(h, 18, 82),
    '--color-border-soft': hsl(h, 20, 91),
  };
}
