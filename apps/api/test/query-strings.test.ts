import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Client, signup, testApp } from './helpers.ts';

let app: FastifyInstance;
let owner: Client;
const ws = '/api/w/qs';

beforeAll(async () => {
  app = await testApp();
  owner = (await signup(app, 'Quinn Query')).client;
  await owner.post('/api/workspaces', { name: 'QS', slug: 'qs', teamName: 'Eng', teamKey: 'ENG' });
});

afterAll(async () => {
  await app.close();
});

describe('query strings', () => {
  it('parses search terms and rejects anything but one string', async () => {
    expect((await owner.get(`${ws}/search?q=anything`)).statusCode).toBe(200);
    expect((await owner.get(`${ws}/search`)).data).toEqual({ issues: [], projects: [] });
    // Repeating a key gives an array, which used to be cast to a string.
    const res = await owner.get(`${ws}/search?q=a&q=b`);
    expect(res.statusCode).toBe(400);
    expect(res.data.message).toMatch(/^q: /);
  });

  it('accepts only the documented snoozed flag', async () => {
    expect((await owner.get(`${ws}/notifications?snoozed=1`)).statusCode).toBe(200);
    expect((await owner.get(`${ws}/notifications`)).statusCode).toBe(200);
    expect((await owner.get(`${ws}/notifications?snoozed=yes`)).statusCode).toBe(400);
  });

  it('bounds the webhook delivery limit', async () => {
    const hook = await owner.post(`${ws}/webhooks`, { url: 'https://example.com/hook' });
    const deliveries = `${ws}/webhooks/${hook.data.webhook.id}/deliveries`;
    expect((await owner.get(`${deliveries}?limit=10`)).statusCode).toBe(200);
    expect((await owner.get(deliveries)).statusCode).toBe(200);
    expect((await owner.get(`${deliveries}?limit=lots`)).statusCode).toBe(400);
    expect((await owner.get(`${deliveries}?limit=1000`)).statusCode).toBe(400);
  });
});
