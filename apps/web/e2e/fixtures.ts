import { randomUUID } from 'node:crypto';
import { type APIRequestContext, test as base, expect, type Page } from '@playwright/test';
import { STATE } from './playwright.config.ts';

export { expect };

/** The seeded demo admin (apps/api/src/db/seed.ts). */
export const DEMO = { email: 'demo@ordo.test', password: 'ordo-demo-password' };

interface Team {
  id: string;
  key: string;
  states: { id: string; name: string; type: string }[];
}

export interface Issue {
  id: string;
  identifier: string;
  title: string;
  description: string;
  stateId: string;
  teamId: string;
}

/** The demo workspace's REST API, signed in as the demo admin, to set up and check what the UI did. */
export class Api {
  constructor(readonly request: APIRequestContext) {}

  async get<T>(path: string): Promise<T> {
    const res = await this.request.get(`/api/w/demo${path}`);
    expect(res.ok(), `GET ${path}: ${res.status()}`).toBe(true);
    return res.json();
  }

  async team(key: string): Promise<Team> {
    const { teams } = await this.get<{ teams: Team[] }>('/bootstrap');
    return teams.find((t) => t.key === key)!;
  }

  async state(teamKey: string, name: string) {
    return (await this.team(teamKey)).states.find((s) => s.name === name)!;
  }

  issue(idOrIdentifier: string) {
    return this.get<Issue>(`/issues/${idOrIdentifier}`);
  }

  async createIssue(teamKey: string, title: string, stateName?: string): Promise<Issue> {
    const team = await this.team(teamKey);
    const stateId = stateName ? team.states.find((s) => s.name === stateName)!.id : undefined;
    const res = await this.request.post('/api/w/demo/issues', {
      data: { id: randomUUID(), teamId: team.id, title, stateId },
    });
    expect(res.ok(), `create issue: ${res.status()}`).toBe(true);
    return res.json();
  }
}

/** A title no other test (or earlier run against the same preview) uses. */
export const unique = (what: string) => `${what} ${randomUUID().slice(0, 8)}`;

/** Waits for the workspace shell, i.e. the bootstrap and the local copy have loaded. */
export async function openWorkspace(page: Page, path = '') {
  await page.goto(`/demo${path}`);
  await expect(page.getByRole('main')).toBeVisible();
}

export const test = base.extend<{
  api: Api;
  /** Console errors matching this don't fail the test (e.g. requests made while offline). */
  allowConsoleErrors: RegExp | undefined;
}>({
  allowConsoleErrors: [undefined, { option: true }],
  api: async ({ playwright, baseURL }, use) => {
    const request = await playwright.request.newContext({ baseURL, storageState: STATE });
    await use(new Api(request));
    await request.dispose();
  },
  // Every page in the context, including second tabs: an error in the console fails the test.
  context: async ({ context, allowConsoleErrors }, use) => {
    const errors: string[] = [];
    const allowed = (text: string) => !!allowConsoleErrors?.test(text);
    context.on('console', (msg) => {
      // With where it came from: for failed requests, that is the request's URL.
      const text = `${msg.text()} (${msg.location().url})`;
      if (msg.type() === 'error' && !allowed(text)) errors.push(text);
    });
    context.on('weberror', (err) => {
      const text = String(err.error());
      if (!allowed(text)) errors.push(text);
    });
    await use(context);
    expect(errors, 'console errors').toEqual([]);
  },
});
