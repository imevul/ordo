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

/** The background accents sit on. Accents below 3:1 against it are hard to see. */
export const THEME_BACKGROUND = '#09090b';

/**
 * CSS custom properties for an accent, or {} for Hotline Pink (app.css already has it). Keys are
 * the variable names set on the document root.
 */
export function accentVariables(color: string | null | undefined): Record<string, string> {
  if (!color || !HEX_COLOR.test(color) || color.toLowerCase() === DEFAULT_ACCENT) return {};
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
