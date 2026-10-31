import type { Comment, CommentReaction, Notification } from '@ordo/shared';
import { MAX_REACTION_KINDS } from '@ordo/shared';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { commentReactions, domainEvents } from '../src/db/schema.ts';
import { type Client, signup, testApp } from './helpers.ts';

let app: FastifyInstance;
let owner: Client;
let member: Client;
let insider: Client;
const ws = '/api/w/react';
const ids: Record<string, string> = {};

const react = (c: Client, commentId: string, emoji: string) =>
  c.put(`${ws}/comments/${commentId}/reactions/${encodeURIComponent(emoji)}`);
const unreact = (c: Client, commentId: string, emoji: string) =>
  c.del(`${ws}/comments/${commentId}/reactions/${encodeURIComponent(emoji)}`);
const comments = async (c: Client, issueId: string) =>
  (await c.get(`${ws}/issues/${issueId}/comments`)).data as Comment[];
const reactionNotes = async (c: Client) =>
  ((await c.get(`${ws}/notifications`)).data as Notification[]).filter(
    (n) => n.type === 'comment_reaction',
  );

beforeAll(async () => {
  app = await testApp();
  owner = (await signup(app, 'Olga Owner')).client;
  await owner.post('/api/workspaces', {
    name: 'React',
    slug: 'react',
    teamName: 'Pub',
    teamKey: 'PUB',
  });
  const invite = async () => (await owner.post(`${ws}/invites`, { role: 'member' })).data[0].token;
  member = (await signup(app, 'Mona Member', { inviteToken: await invite() })).client;
  insider = (await signup(app, 'Ines Insider', { inviteToken: await invite() })).client;
  ids.member = (await member.get('/api/auth/me')).data.id;
  ids.insider = (await insider.get('/api/auth/me')).data.id;
  const prv = (await owner.post(`${ws}/teams`, { name: 'Private', key: 'PRV', private: true }))
    .data;
  await owner.post(`${ws}/teams/${prv.id}/members`, { userId: ids.insider });
  const boot = (await owner.get(`${ws}/bootstrap`)).data;
  ids.ws = boot.workspace.id;
  const pub = boot.teams.find((t: { key: string }) => t.key === 'PUB').id;
  ids.open = (await owner.post(`${ws}/issues`, { teamId: pub, title: 'Open' })).data.id;
  ids.secret = (await owner.post(`${ws}/issues`, { teamId: prv.id, title: 'Secret' })).data.id;
  ids.comment = (
    await owner.post(`${ws}/issues/${ids.open}/comments`, { body: 'Ship it?' })
  ).data.id;
  ids.secretComment = (
    await owner.post(`${ws}/issues/${ids.secret}/comments`, { body: 'Shh' })
  ).data.id;
});

afterAll(() => app.close());

describe('comment reactions', () => {
  it('adds a reaction once, lists it on the comment and tells the author', async () => {
    const res = await react(member, ids.comment!, '👍');
    expect(res.statusCode).toBe(200);
    expect(res.data as CommentReaction[]).toEqual([{ emoji: '👍', userIds: [ids.member] }]);
    expect((await react(member, ids.comment!, '👍')).data).toEqual(res.data);
    await react(insider, ids.comment!, '🎉');
    await react(insider, ids.comment!, '👍');

    const [comment] = await comments(owner, ids.open!);
    expect(comment!.reactions).toEqual([
      { emoji: '👍', userIds: [ids.member, ids.insider] },
      { emoji: '🎉', userIds: [ids.insider] },
    ]);
    const notes = await reactionNotes(owner);
    expect(notes).toHaveLength(3);
    expect(notes.map((n) => n.data.emoji).sort()).toEqual(['🎉', '👍', '👍']);
    expect(notes.every((n) => n.commentId === ids.comment)).toBe(true);

    const events = await app.db
      .select()
      .from(domainEvents)
      .where(and(eq(domainEvents.workspaceId, ids.ws!), eq(domainEvents.type, 'reaction.created')));
    expect(events.some((e) => (e.data.reaction as { emoji: string }).emoji === '🎉')).toBe(true);
  });

  it('removes a reaction, and its notification while unread', async () => {
    const res = await unreact(insider, ids.comment!, '🎉');
    expect(res.statusCode).toBe(200);
    expect(res.data).toEqual([{ emoji: '👍', userIds: [ids.member, ids.insider] }]);
    expect((await unreact(insider, ids.comment!, '🎉')).statusCode).toBe(200);
    const notes = await reactionNotes(owner);
    expect(notes.map((n) => n.data.emoji)).toEqual(['👍', '👍']);
    expect(
      await app.db
        .select()
        .from(domainEvents)
        .where(
          and(eq(domainEvents.workspaceId, ids.ws!), eq(domainEvents.type, 'reaction.deleted')),
        ),
    ).toHaveLength(1);
  });

  it("doesn't notify people about their own reactions", async () => {
    const before = (await reactionNotes(owner)).length;
    await react(owner, ids.comment!, '🚀');
    expect(await reactionNotes(owner)).toHaveLength(before);
  });

  it('accepts one emoji only', async () => {
    for (const bad of ['abc', '👍👍', ':+1:', ' '])
      expect((await react(member, ids.comment!, bad)).statusCode, bad).toBe(400);
    for (const ok of ['👍🏽', '🇸🇪', '👨‍👩‍👧'])
      expect((await react(member, ids.comment!, ok)).statusCode, ok).toBe(200);
  });

  it('caps the number of different emoji on a comment', async () => {
    const id = (await owner.post(`${ws}/issues/${ids.open}/comments`, { body: 'Vote' })).data.id;
    const pool = [
      ...'😀😁😂🤣😃😄😅😆😉😊😋😎😍😘🥰😗😙😚🙂🤗🤩🤔'.matchAll(/\p{Extended_Pictographic}/gu),
    ];
    for (const [e] of pool.slice(0, MAX_REACTION_KINDS))
      expect((await react(member, id, e)).statusCode).toBe(200);
    expect((await react(member, id, pool[MAX_REACTION_KINDS]![0])).statusCode).toBe(400);
    expect((await react(insider, id, pool[0]![0])).statusCode).toBe(200);
  });

  it('follows the issue: private teams stay private', async () => {
    expect((await react(member, ids.secretComment!, '👀')).statusCode).toBe(404);
    expect((await unreact(member, ids.secretComment!, '👀')).statusCode).toBe(404);
    expect((await react(insider, ids.secretComment!, '👀')).statusCode).toBe(200);
  });

  it('goes away with its comment', async () => {
    const onComment = () =>
      app.db
        .select()
        .from(commentReactions)
        .where(eq(commentReactions.commentId, ids.secretComment!));
    expect(await onComment()).toHaveLength(1);
    expect((await owner.del(`${ws}/comments/${ids.secretComment}`)).statusCode).toBe(200);
    expect(await onComment()).toEqual([]);
    expect((await react(insider, ids.secretComment!, '👀')).statusCode).toBe(404);
  });
});
