import { describe, expect, it } from 'vitest';
import {
  ACCENT_PRESETS,
  accentVariables,
  contrast,
  DEFAULT_ACCENT,
  LIGHT_SURFACE,
  readableOn,
  THEME_BACKGROUND,
  themedColor,
} from './theme.ts';

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

describe('light theme', () => {
  it('leaves Hotline Pink to the stylesheet', () => {
    expect(accentVariables(DEFAULT_ACCENT, 'light')).toEqual({});
  });

  it('deepens every preset until small text in it reads on the pale ground', () => {
    for (const { color } of ACCENT_PRESETS.slice(1)) {
      const v = accentVariables(color, 'light');
      const surface = v['--color-surface']!;
      expect(contrast(v['--color-primary']!, surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(v['--color-highlight']!, surface)).toBeGreaterThan(
        contrast(v['--color-primary']!, surface),
      );
      expect(contrast(v['--color-text']!, surface)).toBeGreaterThan(14);
      expect(contrast(v['--color-muted']!, surface)).toBeGreaterThan(6);
      expect(contrast(v['--color-index']!, surface)).toBeGreaterThan(4.5);
      expect(contrast(v['--color-on-primary']!, v['--color-primary']!)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('keeps an accent that is already dark enough', () => {
    expect(accentVariables('#1d2fa8', 'light')['--color-primary']).toBe('#1d2fa8');
  });
});

describe('readableOn', () => {
  it('darkens faint colours and keeps the rest', () => {
    const cyan = readableOn('#2de2e6', LIGHT_SURFACE);
    expect(cyan).not.toBe('#2de2e6');
    expect(contrast(cyan, LIGHT_SURFACE)).toBeGreaterThanOrEqual(3);
    expect(readableOn('#8e7985', LIGHT_SURFACE)).toBe('#8e7985');
    expect(readableOn('var(--color-muted)', LIGHT_SURFACE)).toBe('var(--color-muted)');
  });

  it('only changes data colours in the light theme', () => {
    expect(themedColor('#facc15', 'dark')).toBe('#facc15');
    expect(contrast(themedColor('#facc15', 'light'), LIGHT_SURFACE)).toBeGreaterThanOrEqual(3);
  });
});
