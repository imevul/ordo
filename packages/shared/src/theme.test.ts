import { describe, expect, it } from 'vitest';
import { accentVariables, contrast, DEFAULT_ACCENT, THEME_BACKGROUND } from './theme.ts';

describe('accentVariables', () => {
  it('leaves Hotline Pink and bad input to the stylesheet', () => {
    expect(accentVariables(null)).toEqual({});
    expect(accentVariables(DEFAULT_ACCENT)).toEqual({});
    expect(accentVariables('#FF1493')).toEqual({});
    expect(accentVariables('blue')).toEqual({});
  });

  it('derives a palette around the accent', () => {
    const v = accentVariables('#3b82f6');
    expect(v['--color-primary']).toBe('#3b82f6');
    for (const value of Object.values(v)) expect(value).toMatch(/^#[0-9a-f]{6}$/);
    // Lighter highlight, deeper deep, readable neutrals.
    expect(contrast(v['--color-highlight']!, THEME_BACKGROUND)).toBeGreaterThan(
      contrast('#3b82f6', THEME_BACKGROUND),
    );
    expect(contrast(v['--color-deep']!, THEME_BACKGROUND)).toBeLessThan(
      contrast('#3b82f6', THEME_BACKGROUND),
    );
    expect(contrast(v['--color-muted']!, THEME_BACKGROUND)).toBeGreaterThan(7);
    expect(contrast(v['--color-index']!, THEME_BACKGROUND)).toBeGreaterThan(4.5);
  });

  it('picks readable text for buttons', () => {
    expect(accentVariables('#a3e635')['--color-on-primary']).toBe(THEME_BACKGROUND);
    expect(accentVariables('#1d2fa8')['--color-on-primary']).toBe('#ffffff');
  });
});
