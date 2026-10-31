import { describe, expect, it } from 'vitest';
import { redactUrl } from '../src/lib/redact.ts';
import { safeRedirect } from '../src/services/sso.ts';

describe('redactUrl', () => {
  it('keeps secrets in URLs out of the logs', () => {
    expect(redactUrl('/api/invites/abc123/accept')).toBe('/api/invites/…/accept');
    expect(redactUrl('/api/calendar/ordo_cal_s3cret.ics')).toBe('/api/calendar/….ics');
    expect(redactUrl('/api/hooks/gitlab/inbound-key')).toBe('/api/hooks/gitlab/…');
    expect(redactUrl('/api/hooks/github/app-1234')).toBe('/api/hooks/github/app-1234');
    expect(redactUrl('/api/files/f1?exp=99&sig=s3cret')).toBe('/api/files/f1?exp=99&sig=…');
    expect(redactUrl('/api/auth/oidc/callback?code=c&state=s&iss=x')).toBe(
      '/api/auth/oidc/callback?code=…&state=…&iss=x',
    );
    expect(redactUrl('/api/w/acme/issues?team=ENG')).toBe('/api/w/acme/issues?team=ENG');
  });
});

describe('safeRedirect', () => {
  it('only allows paths on this site', () => {
    expect(safeRedirect('/acme/settings')).toBe('/acme/settings');
    expect(safeRedirect('/')).toBe('/');
    for (const bad of [
      '//evil.com',
      '/\\evil.com',
      '/\\/evil.com',
      '/a\\b',
      'https://evil.com',
      '/\t/evil.com',
      '',
    ])
      expect(safeRedirect(bad)).toBeNull();
    expect(safeRedirect(undefined)).toBeNull();
  });
});
