import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testApp } from './helpers.ts';

const PAGE = '<!doctype html><script src="/assets/index-abc123.js"></script>';

let app: FastifyInstance;
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ordo-test-static-'));
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'index.html'), PAGE);
  writeFileSync(join(dir, 'sw.js'), '// service worker');
  writeFileSync(join(dir, 'assets', 'index-abc123.js'), '// bundle');
  app = await testApp({ staticDir: dir });
});

afterAll(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('files of earlier builds', () => {
  // A tab left open across a deploy asks for these; the page in their place would be run as a script.
  it.each(['/assets/gone-abc.js', '/assets/gone-abc.css', '/assets/gone-abc.js?v=1'])(
    'answers 404 for %s',
    async (url) => {
      const res = await app.inject({ url });
      expect(res.statusCode).toBe(404);
      expect(res.headers['content-type']).toContain('application/json');
      expect(res.json().error).toBe('not_found');
    },
  );

  // Workspace slugs aren't reserved, so a workspace can be called "assets".
  it.each([
    '/haxnet/settings/agents',
    '/assets',
    '/assets/',
    '/assets/inbox',
    '/assets/team/ENG/all',
    '/assets/issue/ENG-1?comment=abc.def',
  ])('still serves the page for the client-side route %s', async (url) => {
    const res = await app.inject({ url });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(PAGE);
  });
});

describe('web client caching', () => {
  // A browser that reuses the page keeps running the old bundle after a deploy.
  it.each(['/', '/index.html', '/haxnet/settings/agents'])(
    'revalidates the page at %s',
    async (url) => {
      const res = await app.inject({ url });
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe(PAGE);
      expect(res.headers['cache-control']).toBe('no-cache');
      expect(res.headers.etag).toBeTruthy();

      const again = await app.inject({
        url,
        headers: { 'if-none-match': String(res.headers.etag) },
      });
      expect(again.statusCode).toBe(304);
      expect(again.headers['cache-control']).toBe('no-cache');
    },
  );

  it('revalidates the service worker', async () => {
    const res = await app.inject({ url: '/sw.js' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-cache');
  });

  it('keeps caching hashed files', async () => {
    const res = await app.inject({ url: '/assets/index-abc123.js' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=3600');
  });

  it('does not serve the page for API paths', async () => {
    const res = await app.inject({ url: '/api/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('not_found');
  });
});
