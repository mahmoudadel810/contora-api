import { getModelToken } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import { AuthService } from '../src/auth/auth.service.js';
import type { Principal } from '../src/auth/principal.js';
import { can } from '../src/authorization/policy.js';
import { RecordComment } from '../src/comments/comment.schema.js';
import { CommentsService } from '../src/comments/comments.service.js';
import { MyRecordsService } from '../src/my-records/my-records.service.js';
import { NotificationHub } from '../src/notifications/notification-hub.js';
import { Notification } from '../src/notifications/notification.schema.js';
import { as, DEFAULT_PASSWORD, signIn, signUp, uniqueEmail, type Actor } from './helpers/actors.js';
import { createRecord, workspace, type Workspace } from './helpers/fixtures.js';
import { createTestApp, type TestApp } from './helpers/test-app.js';

interface Item {
  id: string;
  kind: string;
  title: string;
  body: string;
  recordId: string | null;
  commentId: string | null;
}

interface AuditItem {
  action: string;
  context: Record<string, unknown>;
}

const MAX = 3;
const token = (userId: string) => `@{user:${userId}}`;
const forged = () => new Types.ObjectId().toHexString();

describe('comment mentions (e2e)', () => {
  let ctx: TestApp;
  let admin: Actor;
  let bob: Actor;
  let carol: Actor;
  let dave: Actor;
  let erin: Actor;
  let sam: Actor;
  let other: Actor;
  let ws: Workspace;

  async function person(owner: Actor, displayName: string, email = uniqueEmail('m')) {
    const actor = await ungranted(owner, displayName, email);
    await grantRoot(owner, actor);
    return actor;
  }

  async function ungranted(owner: Actor, displayName: string, email = uniqueEmail('m')) {
    await ctx.app.get(AuthService).createMember(owner.tenantId, {
      email,
      password: DEFAULT_PASSWORD,
      displayName,
      role: 'member',
    });
    return signIn(ctx, email, DEFAULT_PASSWORD);
  }

  async function grantRoot(owner: Actor, member: Actor): Promise<void> {
    const root = await as(ctx, owner).get('/api/v1/folders/root').expect(200);
    await as(ctx, owner)
      .put('/api/v1/access/grants')
      .send({
        userId: member.userId,
        targetType: 'folder',
        targetId: root.body.folder.id as string,
        level: 'edit',
      })
      .expect(200);
  }

  const inbox = async (actor: Actor): Promise<Item[]> =>
    (await as(ctx, actor).get('/api/v1/notifications').expect(200)).body.items as Item[];

  const comment = (actor: Actor, recordId: string, body: string) =>
    as(ctx, actor).post(`/api/v1/records/${recordId}/comments`).send({ body });

  const auditOf = async (recordId: string, action: string): Promise<AuditItem[]> =>
    (
      await as(ctx, admin)
        .get(`/api/v1/audit?resourceId=${recordId}&action=${action}&pageSize=100`)
        .expect(200)
    ).body.items as AuditItem[];

  beforeAll(async () => {
    ctx = await createTestApp([], { COMMENT_MENTION_MAX_RECIPIENTS: String(MAX) });
    admin = await signUp(ctx, { tenantName: 'Mention Co', displayName: 'Ada Admin' });
    ws = await workspace(ctx, admin);
    bob = await person(admin, 'Bob Builder');
    carol = await person(admin, 'Carol Clerk');
    dave = await person(admin, 'Dave Diver');
    erin = await person(admin, 'Erin Editor');
    sam = await person(admin, 'Sam Suspended');
    await as(ctx, admin).post(`/api/v1/members/${sam.userId}/suspend`).expect(200);
    other = await signUp(ctx, { tenantName: 'Other Co', displayName: 'Olga Other' });
  });

  afterAll(async () => {
    await ctx.stop();
  });

  it('stores the raw body and the mentions, and shows current names', async () => {
    const { id } = await createRecord(ctx, admin, ws, { name: 'Budget' });
    const res = await comment(bob, id, `  Please check ${token(carol.userId)} thanks  `).expect(
      201,
    );
    expect(res.body).toMatchObject({
      body: `Please check ${token(carol.userId)} thanks`,
      mentions: [{ type: 'user', id: carol.userId, displayName: 'Carol Clerk', active: true }],
      author: { id: bob.userId },
    });
    const list = await as(ctx, admin).get(`/api/v1/records/${id}/comments`).expect(200);
    expect(list.body).toEqual([res.body]);

    const [added] = await auditOf(id, 'COMMENT_ADDED');
    expect(added?.context).toEqual({
      commentId: res.body.id,
      excerpt: 'Please check @Carol Clerk thanks',
      mentionCount: 1,
    });
  });

  it('shows a suspended mentioned user by name as inactive, and a removed one as Former user', async () => {
    const { id } = await createRecord(ctx, admin, ws, { name: 'Roster' });
    const leaving = await person(admin, 'Lena Leaving');
    const pausing = await person(admin, 'Paul Pausing');
    const res = await comment(bob, id, `${token(leaving.userId)} ${token(pausing.userId)}`).expect(
      201,
    );
    await as(ctx, admin).delete(`/api/v1/members/${leaving.userId}`).expect(204);
    await as(ctx, admin).post(`/api/v1/members/${pausing.userId}/suspend`).expect(200);
    const list = await as(ctx, admin).get(`/api/v1/records/${id}/comments`).expect(200);
    expect(list.body[0]).toMatchObject({
      id: res.body.id,
      body: `${token(leaving.userId)} ${token(pausing.userId)}`,
      mentions: [
        { type: 'user', id: leaving.userId, displayName: 'Former user', active: false },
        { type: 'user', id: pausing.userId, displayName: 'Paul Pausing', active: false },
      ],
    });
  });

  describe('validation', () => {
    let recordId: string;

    beforeAll(async () => {
      recordId = (await createRecord(ctx, admin, ws, { name: 'Checked' })).id;
    });

    const refuses = async (actor: Actor, body: string, code: string) => {
      const res = await comment(actor, recordId, body).expect(400);
      expect(res.body.code).toBe(code);
      return res.body as { code: string; details?: unknown };
    };

    it('refuses more distinct mentions than the limit, before anything else', async () => {
      const ids = [forged(), forged(), forged(), forged()];
      const res = await refuses(bob, ids.map(token).join(' '), 'MENTION_LIMIT_EXCEEDED');
      expect(res.details).toEqual({ max: MAX });
      await comment(
        bob,
        recordId,
        [carol, carol, carol, carol].map((a) => token(a.userId)).join(''),
      ).expect(201);
      await refuses(
        bob,
        [bob.userId, forged(), forged(), forged()].map(token).join(' '),
        'MENTION_LIMIT_EXCEEDED',
      );
    });

    it('refuses mentioning yourself, before checking access', async () => {
      await refuses(bob, `note to ${token(bob.userId)}`, 'MENTION_SELF');
      await refuses(bob, `${token(bob.userId)} ${token(forged())}`, 'MENTION_SELF');
    });

    it('refuses a suspended user, another tenant’s user and a forged id alike, naming no one', async () => {
      for (const id of [sam.userId, other.userId, forged()]) {
        const res = await refuses(
          bob,
          `hi ${token(carol.userId)} and ${token(id)}`,
          'MENTION_NO_ACCESS',
        );
        expect(res.details).toEqual({
          mentions: [{ id, reason: 'unavailable' }],
          canGrant: false,
        });
      }
    });

    it('refuses an active member who cannot see the record as no_access; only admins may grant', async () => {
      const nora = await ungranted(admin, 'Nora Nogrant');
      const byMember = await refuses(
        bob,
        `${token(carol.userId)} ${token(nora.userId)} ${token(sam.userId)}`,
        'MENTION_NO_ACCESS',
      );
      expect(byMember.details).toEqual({
        mentions: [
          { id: nora.userId, reason: 'no_access' },
          { id: sam.userId, reason: 'unavailable' },
        ],
        canGrant: false,
      });
      const byAdmin = await refuses(admin, `ask ${token(nora.userId)}`, 'MENTION_NO_ACCESS');
      expect(byAdmin.details).toEqual({
        mentions: [{ id: nora.userId, reason: 'no_access' }],
        canGrant: true,
      });
      await grantRoot(admin, nora);
      await comment(admin, recordId, `ask ${token(nora.userId)}`).expect(201);
    });

    it('stores nothing, audits nothing and notifies no one when a mention is refused', async () => {
      const snapshot = async () => ({
        comments: (await as(ctx, admin).get(`/api/v1/records/${recordId}/comments`).expect(200))
          .body.length as number,
        carol: (await inbox(carol)).length,
        added: (await auditOf(recordId, 'COMMENT_ADDED')).length,
        mentioned: (await auditOf(recordId, 'COMMENT_MENTIONED')).length,
      });
      const before = await snapshot();
      await refuses(bob, `${token(carol.userId)} ${token(forged())}`, 'MENTION_NO_ACCESS');
      await refuses(bob, `${token(carol.userId)} ${token(sam.userId)}`, 'MENTION_NO_ACCESS');
      expect(await snapshot()).toEqual(before);
    });

    it('treats anything but an exact user token as plain text', async () => {
      const body = `@{user:${carol.userId.toUpperCase()}} @{department:${carol.userId}} @carol`;
      const res = await comment(bob, recordId, body).expect(201);
      expect(res.body).toMatchObject({ body, mentions: [] });
    });

    it('allows 4000 characters and refuses 4001', async () => {
      await comment(bob, recordId, 'x'.repeat(4000)).expect(201);
      const res = await comment(bob, recordId, 'x'.repeat(4001)).expect(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
    });

    it('enforces the same rules for in-process callers of CommentsService.add', async () => {
      const service = ctx.app.get(CommentsService);
      const principal: Principal = {
        userId: bob.userId,
        tenantId: bob.tenantId,
        role: 'member',
        email: bob.email,
        displayName: bob.displayName,
      };
      await expect(service.add(principal, recordId, `hi ${token(forged())}`)).rejects.toMatchObject(
        { code: 'MENTION_NO_ACCESS' },
      );
      await expect(
        service.add(principal, recordId, `me ${token(bob.userId)}`),
      ).rejects.toMatchObject({ code: 'MENTION_SELF' });
      await expect(service.add(principal, recordId, 'y'.repeat(4001))).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
      });
      const model = ctx.app.get<Model<RecordComment>>(getModelToken(RecordComment.name));
      expect(
        await model.countDocuments({ recordId: new Types.ObjectId(recordId), body: /^(hi|me) @/ }),
      ).toBe(0);
    });
  });

  it('sends mentioned people only a MENTION, and everyone else following the record the comment', async () => {
    const { id } = await createRecord(ctx, admin, ws, { name: 'Plan' });
    await as(ctx, dave).put(`/api/v1/records/${id}/favorite`).expect(204);
    await as(ctx, erin).put(`/api/v1/records/${id}/favorite`).expect(204);
    const res = await comment(
      bob,
      id,
      `Hi ${token(admin.userId)}, ${token(dave.userId)} and ${token(carol.userId)}: done`,
    ).expect(201);
    const commentId = res.body.id as string;
    const rendered = 'Hi @Ada Admin, @Dave Diver and @Carol Clerk: done';

    for (const actor of [admin, dave, carol]) {
      const mine = (await inbox(actor)).filter((n) => n.commentId === commentId);
      expect(mine).toEqual([
        expect.objectContaining({
          kind: 'MENTION',
          title: 'Bob Builder mentioned you on "Plan"',
          body: rendered,
          recordId: id,
          commentId,
        }),
      ]);
    }
    const erinItems = (await inbox(erin)).filter((n) => n.commentId === commentId);
    expect(erinItems).toEqual([
      expect.objectContaining({
        kind: 'COMMENT_ON_RECORD',
        title: 'Bob Builder commented on "Plan"',
        body: rendered,
        commentId,
      }),
    ]);
    expect((await inbox(bob)).some((n) => n.commentId === commentId)).toBe(false);
  });

  it('cuts the MENTION body at 120 characters of the rendered text', async () => {
    const { id } = await createRecord(ctx, admin, ws, { name: 'Long read' });
    const body = `${'a'.repeat(110)}${token(carol.userId)} and more text after it`;
    const res = await comment(bob, id, body).expect(201);
    const [item] = (await inbox(carol)).filter((n) => n.commentId === res.body.id);
    expect(item?.body).toBe(`${'a'.repeat(110)}@Carol Cle`);
  });

  it('audits one COMMENT_MENTIONED per recipient without text, and no raw token leaves comments', async () => {
    const { id } = await createRecord(ctx, admin, ws, { name: 'Tokens' });
    const res = await comment(
      bob,
      id,
      `${token(carol.userId)} ${token(erin.userId)} secret plan`,
    ).expect(201);
    const commentId = res.body.id as string;

    const mentioned = await auditOf(id, 'COMMENT_MENTIONED');
    expect(
      mentioned
        .map((e) => e.context)
        .sort((a, b) => String(a.recipientName).localeCompare(String(b.recipientName))),
    ).toEqual([
      { commentId, recipientId: carol.userId, recipientName: 'Carol Clerk', versionId: null },
      { commentId, recipientId: erin.userId, recipientName: 'Erin Editor', versionId: null },
    ]);
    expect(JSON.stringify(mentioned)).not.toContain('secret plan');
    const [added] = await auditOf(id, 'COMMENT_ADDED');
    expect(added?.context).toMatchObject({
      mentionCount: 2,
      excerpt: '@Carol Clerk @Erin Editor secret plan',
    });

    const everything = await as(ctx, admin).get(`/api/v1/audit?resourceId=${id}&pageSize=100`);
    const feed = await as(ctx, carol).get(`/api/v1/records/${id}/activity`).expect(200);
    const notes = [...(await inbox(carol)), ...(await inbox(admin)), ...(await inbox(erin))];
    for (const text of [
      JSON.stringify(everything.body),
      JSON.stringify(feed.body),
      JSON.stringify(notes),
    ]) {
      expect(text).not.toMatch(/@\{user:[0-9a-f]{24}\}/);
    }
  });

  it('clears the notification bodies of a deleted comment, and keeps their titles', async () => {
    const { id } = await createRecord(ctx, admin, ws, { name: 'Retracted' });
    const res = await comment(bob, id, `Oops ${token(carol.userId)}, wrong figures`).expect(201);
    const commentId = res.body.id as string;
    const before = [
      ...(await inbox(admin)).filter((n) => n.commentId === commentId),
      ...(await inbox(carol)).filter((n) => n.commentId === commentId),
    ];
    expect(before.map((n) => n.kind).sort()).toEqual(['COMMENT_ON_RECORD', 'MENTION']);
    expect(before.every((n) => n.body.includes('wrong figures'))).toBe(true);

    await as(ctx, bob).delete(`/api/v1/records/${id}/comments/${commentId}`).expect(204);
    const after = [
      ...(await inbox(admin)).filter((n) => n.commentId === commentId),
      ...(await inbox(carol)).filter((n) => n.commentId === commentId),
    ];
    expect(
      after
        .map((n) => ({ title: n.title, body: n.body }))
        .sort((a, b) => a.title.localeCompare(b.title)),
    ).toEqual([
      { title: 'Bob Builder commented on "Retracted"', body: '' },
      { title: 'Bob Builder mentioned you on "Retracted"', body: '' },
    ]);
    const [deleted] = await auditOf(id, 'COMMENT_DELETED');
    expect(deleted?.context).toMatchObject({ excerpt: 'Oops @Carol Clerk, wrong figures' });
  });

  it('clears the body even when the delete lands while the notifications are being written', async () => {
    const { id } = await createRecord(ctx, admin, ws, { name: 'Raced' });
    const myRecords = ctx.app.get(MyRecordsService);
    const favoritedBy = myRecords.favoritedBy.bind(myRecords);
    const published = vi.spyOn(ctx.app.get(NotificationHub), 'publish');
    const spy = vi
      .spyOn(myRecords, 'favoritedBy')
      .mockImplementationOnce(async (tenantId: string, recordId: string) => {
        const list = await as(ctx, bob).get(`/api/v1/records/${id}/comments`).expect(200);
        const last = list.body[list.body.length - 1] as { id: string };
        await as(ctx, bob).delete(`/api/v1/records/${id}/comments/${last.id}`).expect(204);
        return favoritedBy(tenantId, recordId);
      });
    try {
      const res = await comment(bob, id, `Race ${token(carol.userId)} with private words`).expect(
        201,
      );
      expect(spy).toHaveBeenCalled();
      const notifications = ctx.app.get<Model<Notification>>(getModelToken(Notification.name));
      const rows = await notifications
        .find({ commentId: new Types.ObjectId(res.body.id as string) })
        .lean();
      expect(rows.map((r) => r.kind).sort()).toEqual(['COMMENT_ON_RECORD', 'MENTION']);
      expect(rows.every((r) => r.body === '')).toBe(true);
      const commentId = res.body.id as string;
      for (const owner of [admin.userId, carol.userId]) {
        expect(published).toHaveBeenCalledWith(admin.tenantId, owner, 'cleared', { commentId });
      }
    } finally {
      spy.mockRestore();
      published.mockRestore();
    }
  });

  describe('mentionable users (GET /records/:id/mentionable-users)', () => {
    let owner: Actor;
    let caller: Actor;
    let recordId: string;
    let names: Record<string, Actor>;
    const candidates = async (actor: Actor, q?: string) => {
      const query = q === undefined ? '' : `?q=${encodeURIComponent(q)}`;
      return (
        await as(ctx, actor)
          .get(`/api/v1/records/${recordId}/mentionable-users${query}`)
          .expect(200)
      ).body.items as Array<{ id: string; displayName: string; collaborator: boolean }>;
    };

    beforeAll(async () => {
      owner = await signUp(ctx, { tenantName: 'Ranking Co', displayName: 'Zoe Owner' });
      const space = await workspace(ctx, owner, 'Ranked');
      caller = await person(owner, 'Mia Caller');
      names = {
        aaron: await person(owner, 'Aaron Zed'),
        grace: await person(owner, 'Grace Hopper'),
        tom: await person(owner, 'Tom Grant'),
        vera: await person(owner, 'Vera Version'),
        quiet: await person(owner, 'Quiet Person', `zulu-${Date.now()}@example.test`),
        paused: await person(owner, 'Gregor Paused'),
        gone: await person(owner, 'Gloria Gone'),
        nogrant: await ungranted(owner, 'Gary Nogrant'),
      };
      recordId = (await createRecord(ctx, owner, space, { name: 'Ranked record' })).id;
      await as(ctx, names.vera as Actor)
        .post(`/api/v1/records/${recordId}/versions`)
        .send({ metadata: { supplier: 'Acme', amount: 1, status: 'Open' }, comment: 'by Vera' })
        .expect(201);
      await comment(names.tom as Actor, recordId, 'A remark').expect(201);
      await as(ctx, owner).post(`/api/v1/members/${names.paused?.userId}/suspend`).expect(200);
      await as(ctx, owner).delete(`/api/v1/members/${names.gone?.userId}`).expect(204);
    });

    it('offers only people who can see the record, to members and admins alike', async () => {
      const nogrant = (names.nogrant as Actor).userId;
      expect((await candidates(caller, 'ga')).map((c) => c.id)).not.toContain(nogrant);
      expect((await candidates(owner, 'ga')).map((c) => c.id)).not.toContain(nogrant);
      expect((await candidates(owner)).map((c) => c.id)).not.toContain(nogrant);
    });

    it('ranks collaborators first, then by name, and leaves out the caller and inactive users', async () => {
      const items = await candidates(caller);
      expect(items.map((c) => [c.displayName, c.collaborator])).toEqual([
        ['Tom Grant', true],
        ['Vera Version', true],
        ['Zoe Owner', true],
        ['Aaron Zed', false],
        ['Grace Hopper', false],
        ['Quiet Person', false],
      ]);
      for (const item of items)
        expect(Object.keys(item).sort()).toEqual(['collaborator', 'displayName', 'id']);
      expect(JSON.stringify(items)).not.toContain('@');
    });

    it('matches the start of any word of the name, case-insensitively, and escapes the query', async () => {
      expect((await candidates(caller, 'gr')).map((c) => c.displayName)).toEqual([
        'Tom Grant',
        'Grace Hopper',
      ]);
      expect(await candidates(caller, 'race')).toEqual([]);
      expect(await candidates(caller, 'HOP')).toMatchObject([{ displayName: 'Grace Hopper' }]);
      expect(await candidates(caller, '.*')).toEqual([]);
      expect(await candidates(caller, '(')).toEqual([]);
      await as(ctx, caller)
        .get(`/api/v1/records/${recordId}/mentionable-users?q=${'a'.repeat(65)}`)
        .expect(400);
      await as(ctx, caller)
        .get(`/api/v1/records/${recordId}/mentionable-users?other=1`)
        .expect(400);
    });

    it('matches an email prefix only for callers who may read the member directory', async () => {
      const quiet = names.quiet as Actor;
      const byOwner = await candidates(owner, 'zulu-');
      expect(byOwner).toEqual([
        { id: quiet.userId, displayName: 'Quiet Person', collaborator: false },
      ]);
      const byMember = await candidates(caller, 'zulu-');
      expect(byMember.length).toBe(can({ role: 'member' }, 'members.read') ? 1 : 0);
      expect(JSON.stringify(byOwner)).not.toContain('example.test');
    });

    it('answers 404 for another tenant and 401 without sign-in, and never lists other tenants', async () => {
      await as(ctx, other).get(`/api/v1/records/${recordId}/mentionable-users`).expect(404);
      await ctx.http().get(`/api/v1/records/${recordId}/mentionable-users`).expect(401);
      await as(ctx, caller).get(`/api/v1/records/${forged()}/mentionable-users`).expect(404);
      const ids = (await candidates(owner)).map((c) => c.id);
      for (const outsider of [admin, bob, other]) expect(ids).not.toContain(outsider.userId);
    });
  });

  describe('rate limits (per user)', () => {
    it('allows 30 comments a minute, then answers 429 RATE_LIMITED, for that user only', async () => {
      const { id } = await createRecord(ctx, admin, ws, { name: 'Busy' });
      const chatty = await person(admin, 'Chatty Cathy');
      for (let i = 0; i < 30; i += 1) await comment(chatty, id, `note ${i}`).expect(201);
      const refused = await comment(chatty, id, 'one too many').expect(429);
      expect(refused.body.code).toBe('RATE_LIMITED');
      await comment(bob, id, 'someone else still can').expect(201);
    });

    it('allows 120 mentionable-user lookups a minute, then answers 429 RATE_LIMITED', async () => {
      const { id } = await createRecord(ctx, admin, ws, { name: 'Looked up' });
      const typist = await person(admin, 'Fast Typist');
      for (let i = 0; i < 120; i += 1) {
        await as(ctx, typist).get(`/api/v1/records/${id}/mentionable-users?q=c`).expect(200);
      }
      const refused = await as(ctx, typist)
        .get(`/api/v1/records/${id}/mentionable-users?q=c`)
        .expect(429);
      expect(refused.body.code).toBe('RATE_LIMITED');
      await as(ctx, bob).get(`/api/v1/records/${id}/mentionable-users?q=c`).expect(200);
    });
  });
});
