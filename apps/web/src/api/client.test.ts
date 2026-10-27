import { afterEach, describe, expect, it } from 'vitest';
import { setLocale } from '../i18n/index.ts';
import { errorMessage } from './client.ts';

afterEach(() => setLocale('en'));

describe('errorMessage', () => {
  const wrong = {
    error: 'unauthorized',
    message: 'Wrong email or password',
    messageKey: 'wrong_credentials',
  };

  it("keeps the API's English message in English", () => {
    expect(errorMessage(401, wrong)).toBe('Wrong email or password');
    expect(errorMessage(404, { message: 'Issue not found', messageKey: 'not_found' })).toBe(
      'Issue not found',
    );
  });

  it('translates keyed errors, with their params', async () => {
    await setLocale('sv');
    expect(errorMessage(401, wrong)).toBe('Fel e-postadress eller lösenord');
    expect(
      errorMessage(413, {
        message: 'Attachments can be up to 25 MB',
        messageKey: 'attachment_too_large',
        params: { maxMb: 25 },
      }),
    ).toBe('Bilagor får vara högst 25 MB');
    // Without a key, or with one this version doesn't know, the API's message is shown.
    expect(errorMessage(400, { message: 'Set ORDO_SECRET_KEY first' })).toBe(
      'Set ORDO_SECRET_KEY first',
    );
    expect(errorMessage(400, { message: 'Newer', messageKey: 'from_the_future' })).toBe('Newer');
  });

  it('words rate limits and server failures itself', async () => {
    await setLocale('nb');
    expect(errorMessage(429, { error: 'error', message: 'Rate limit exceeded' })).toMatch(
      /For mange/,
    );
    expect(errorMessage(500, { error: 'error', message: 'Internal server error' })).toMatch(
      /serveren/,
    );
    expect(errorMessage(502, null, 'Bad Gateway')).toMatch(/serveren/);
    // A specific failure from an upstream service keeps its message.
    expect(errorMessage(502, { error: 'ai_failed', message: 'Claude API: overloaded' })).toBe(
      'Claude API: overloaded',
    );
  });
});
