import { describe, expect, it } from 'vitest';
import { isSingleEmoji } from './schemas.ts';

describe('isSingleEmoji', () => {
  it('accepts one emoji, however it is composed', () => {
    for (const e of ['👍', '❤️', '👍🏽', '👨‍👩‍👧', '🇸🇪', '1️⃣'])
      expect(isSingleEmoji(e), e).toBe(true);
  });
  it('rejects text, several emoji and padding', () => {
    for (const e of ['', 'a', '1', ' ', '👍👍', '👍 ', ':+1:', '<b>'])
      expect(isSingleEmoji(e), e).toBe(false);
  });
});
