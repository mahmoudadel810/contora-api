import { getModelToken } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import { AuditEntry } from '../src/audit/audit-entry.schema.js';
import { RefreshToken } from '../src/auth/refresh-token.schema.js';
import { ShareLink } from '../src/shares/share-link.schema.js';
import { ShareLinksRepository } from '../src/shares/share-links.repository.js';
import { ShareLinksService } from '../src/shares/share-links.service.js';
import {
  addMember,
  agentFor,
  as,
  DEFAULT_PASSWORD,
  signIn,
  signUp,
  type Actor,
} from './helpers/actors.js';
import { createRecord, workspace, type Workspace } from './helpers/fixtures.js';
import { createTestApp, type TestApp } from './helpers/test-app.js';

const DAY = 24 * 60 * 60 * 1000;
const in7Days = () => new Date(Date.now() + 7 * DAY).toISOString();
const RESOLVE = '/api/v1/public/share-link';
const CONTENT = '/api/v1/public/share-link/content';

interface Created {
  id: string;
  token: string;
}

describe('share link lifecycle (e2e)', () => {
  let ctx: TestApp;
  let admin: Actor;
  let ws: Workspace;
  let links: Model<ShareLink>;
  let audits: Model<AuditEntry>;

  beforeAll(async () => {
    ctx = await createTestApp();
    admin = await signUp(ctx, { tenantName: 'Lifecycle Co' });
    ws = await workspace(ctx, admin, 'Lifecycle');
    links = ctx.app.get<Model<ShareLink>>(getModelToken(ShareLink.name));
    audits = ctx.app.get<Model<AuditEntry>>(getModelToken(AuditEntry.name));
  });

  afterAll(async () => {
    await ctx.stop();
  });

  async function fileRecord(name: string, folderId = ws.folderId): Promise<string> {
    const { id } = await createRecord(
      ctx,
      admin,
      { ...ws, folderId },
      {
        name,
        file: { content: `content of ${name}`, name: `${name}.txt` },
      },
    );
    return id;
  }

  async function grant(member: Actor, level: 'view' | 'edit', folderId = ws.folderId) {
    const res = await as(ctx, admin)
      .put('/api/v1/access/grants')
      .send({ userId: member.userId, targetType: 'folder', targetId: folderId, level })
      .expect(200);
    return res.body.id as string;
  }

  async function sharer(): Promise<Actor> {
    const member = await addMember(ctx, admin);
    await grant(member, 'edit');
    return member;
  }

  const createLink = (actor: Actor, recordId: string) =>
    as(ctx, actor).post(`/api/v1/records/${recordId}/share-links`).send({ expiresAt: in7Days() });

  async function share(actor: Actor, recordId: string): Promise<Created> {
    const res = await createLink(actor, recordId).expect(201);
    return { id: res.body.id as string, token: (res.body.url as string).split('#')[1] };
  }

  const resolve = (token: string) => ctx.http().get(RESOLVE).set('X-Share-Token', token);
  const content = (token: string) => ctx.http().get(CONTENT).set('X-Share-Token', token);
  const linkOf = (id: string) => links.findById(id).lean().exec();
  const linksFor = (recordId: string) =>
    links
      .find({ recordId: new Types.ObjectId(recordId) })
      .lean()
      .exec();
  const revokedAudits = (recordId: string) =>
    audits
      .find({ action: 'SHARE_LINK_REVOKED', 'resource.id': recordId })
      .sort({ createdAt: 1, _id: 1 })
      .lean()
      .exec();

  async function reinvite(email: string, role: 'admin' | 'member'): Promise<void> {
    const invited = await as(ctx, admin)
      .post('/api/v1/invitations')
      .send({ email, role })
      .expect(201);
    const token = new URL(invited.body.acceptUrl as string).searchParams.get('token') as string;
    await agentFor(ctx)
      .post('/api/v1/invitations/accept')
      .send({ token, displayName: 'Rejoined', password: DEFAULT_PASSWORD })
      .expect(201);
  }

  describe('sharer removal and rejoin', () => {
    it('removal revokes every active link of the sharer, one entry each, the admin as actor', async () => {
      const member = await sharer();
      const first = await fileRecord('Removal one');
      const second = await fileRecord('Removal two');
      const a = await share(member, first);
      const b = await share(member, second);
      const earlier = await share(member, first);
      await as(ctx, member).delete(`/api/v1/share-links/${earlier.id}`).expect(204);
      const kept = await share(admin, first);

      await as(ctx, admin).delete(`/api/v1/members/${member.userId}`).expect(204);

      for (const link of [a, b]) {
        await resolve(link.token).expect(404);
        expect(await linkOf(link.id)).toMatchObject({
          revokeReason: 'SHARER_REMOVED',
          revokedByName: admin.displayName,
        });
      }
      expect((await linkOf(earlier.id))?.revokeReason).toBe('REVOKED');
      await resolve(kept.token).expect(200);
      const entries = [...(await revokedAudits(first)), ...(await revokedAudits(second))].filter(
        (e) => (e.context as { reason: string }).reason === 'SHARER_REMOVED',
      );
      expect(entries.map((e) => (e.context as { linkId: string }).linkId).sort()).toEqual(
        [a.id, b.id].sort(),
      );
      expect(entries.every((e) => e.actor?.id.toHexString() === admin.userId)).toBe(true);
    });

    it('a failing link revocation on removal keeps the audit, the ended sessions and dead links', async () => {
      const member = await sharer();
      const recordId = await fileRecord('Revocation fails');
      const link = await share(member, recordId);
      const service = ctx.app.get(ShareLinksService);
      const spy = vi
        .spyOn(service, 'revokeAllForUser')
        .mockRejectedValueOnce(new Error('share links unavailable'));
      try {
        await as(ctx, admin).delete(`/api/v1/members/${member.userId}`).expect(500);
        expect(spy).toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
      expect(
        await audits.countDocuments({ action: 'MEMBER_REMOVED', 'resource.id': member.userId }),
      ).toBe(1);
      const refreshTokens = ctx.app.get<Model<RefreshToken>>(getModelToken(RefreshToken.name));
      const userId = new Types.ObjectId(member.userId);
      expect(await refreshTokens.countDocuments({ userId })).toBeGreaterThan(0);
      expect(await refreshTokens.countDocuments({ userId, familyRevoked: false })).toBe(0);
      await member.agent.post('/api/v1/auth/refresh').expect(401);

      expect((await linkOf(link.id))?.revokedAt).toBeNull();
      await resolve(link.token).expect(404);
      await content(link.token).expect(404);
      const [refused] = await audits
        .find({ action: 'SHARE_LINK_ACCESSED', 'resource.id': recordId })
        .lean()
        .exec();
      expect(refused.context).toMatchObject({ outcome: 'refused', reason: 'sharer_inactive' });
    });

    it('an admin sharer removed and re-invited as admin keeps their links dead', async () => {
      const other = await addMember(ctx, admin, 'admin');
      const recordId = await fileRecord('Admin sharer');
      const link = await share(other, recordId);
      await resolve(link.token).expect(200);
      await as(ctx, admin).delete(`/api/v1/members/${other.userId}`).expect(204);
      await resolve(link.token).expect(404);

      await reinvite(other.email, 'admin');
      const rejoined = await signIn(ctx, other.email, DEFAULT_PASSWORD);
      expect(rejoined.role).toBe('admin');
      await resolve(link.token).expect(404);
      await content(link.token).expect(404);
      expect((await linkOf(link.id))?.revokeReason).toBe('SHARER_REMOVED');
    });

    it('rejoin revokes, with a null actor, a link the removal did not catch', async () => {
      const member = await sharer();
      const recordId = await fileRecord('Rejoin net');
      const link = await share(member, recordId);
      await as(ctx, admin).delete(`/api/v1/members/${member.userId}`).expect(204);
      await links
        .updateOne(
          { _id: link.id },
          { revokedAt: null, revokedBy: null, revokedByName: null, revokeReason: null },
        )
        .exec();
      await reinvite(member.email, 'member');
      expect(await linkOf(link.id)).toMatchObject({
        revokeReason: 'SHARER_REMOVED',
        revokedBy: null,
        revokedByName: null,
      });
      const entries = await revokedAudits(recordId);
      expect(entries).toHaveLength(2);
      expect(entries[1].actor).toBeNull();
      await resolve(link.token).expect(404);
    });

    it('a create whose insert lands between rejoin’s revoke-all and its flip stays dead', async () => {
      const member = await sharer();
      const recordId = await fileRecord('Race rejoin');
      const repository = ctx.app.get(ShareLinksRepository);
      const service = ctx.app.get(ShareLinksService);
      const insert = repository.create.bind(repository);
      const revokeAll = service.revokeAllForUser.bind(service);
      let revokeSpy: { mockRestore: () => void } | undefined;
      let revokeRan = false;
      const insertSpy = vi.spyOn(repository, 'create').mockImplementationOnce(async (...args) => {
        await as(ctx, admin).delete(`/api/v1/members/${member.userId}`).expect(204);
        const box: { inserted?: Awaited<ReturnType<typeof insert>> } = {};
        revokeSpy = vi
          .spyOn(service, 'revokeAllForUser')
          .mockImplementationOnce(async (tenantId, userId, by) => {
            const revoked = await revokeAll(tenantId, userId, by);
            box.inserted = await insert(...args);
            revokeRan = true;
            return revoked;
          });
        await reinvite(member.email, 'member');
        if (!box.inserted) throw new Error('the insert did not run inside the rejoin');
        return box.inserted;
      });
      try {
        const res = await createLink(member, recordId);
        expect(insertSpy).toHaveBeenCalled();
        expect(revokeRan).toBe(true);
        expect(res.status).toBe(401);
        expect(res.body.url).toBeUndefined();
      } finally {
        insertSpy.mockRestore();
        revokeSpy?.mockRestore();
      }
      expect(await linksFor(recordId)).toEqual([]);
      expect(
        await audits.countDocuments({ action: 'SHARE_LINK_CREATED', 'resource.id': recordId }),
      ).toBe(0);
      const rejoined = await signIn(ctx, member.email, DEFAULT_PASSWORD);
      await grant(rejoined, 'edit');
      await share(rejoined, recordId);
    });
  });

  describe('suspension, grants, moves and check-outs', () => {
    it('suspension pauses a link and reactivation revives it', async () => {
      const member = await sharer();
      const link = await share(member, await fileRecord('Suspend'));
      await as(ctx, admin).post(`/api/v1/members/${member.userId}/suspend`).expect(200);
      await resolve(link.token).expect(404);
      await as(ctx, admin).post(`/api/v1/members/${member.userId}/reactivate`).expect(200);
      await resolve(link.token).expect(200);
      expect((await linkOf(link.id))?.revokedAt).toBeNull();
    });

    it('narrowing Edit to View keeps the link; losing View kills it', async () => {
      const member = await addMember(ctx, admin);
      const grantId = await grant(member, 'edit');
      const link = await share(member, await fileRecord('Narrowed'));
      await grant(member, 'view');
      await resolve(link.token).expect(200);
      await content(link.token).expect(200);
      await as(ctx, admin).delete(`/api/v1/access/grants/${grantId}`).expect(200);
      await resolve(link.token).expect(404);
    });

    it('moving the record out of the sharer’s scope kills the link; moving it back revives it', async () => {
      const member = await sharer();
      const outside = await as(ctx, admin)
        .post('/api/v1/folders')
        .send({ name: `Outside ${Date.now()}`, parentId: ws.rootId })
        .expect(201);
      const recordId = await fileRecord('Moved');
      const link = await share(member, recordId);
      await as(ctx, admin)
        .post(`/api/v1/records/${recordId}/move`)
        .send({ folderId: outside.body.id })
        .expect(200);
      await resolve(link.token).expect(404);
      await as(ctx, admin)
        .post(`/api/v1/records/${recordId}/move`)
        .send({ folderId: ws.folderId })
        .expect(200);
      await resolve(link.token).expect(200);
    });

    it('a check-out by someone else has no effect', async () => {
      const member = await sharer();
      const recordId = await fileRecord('Checked out');
      const link = await share(member, recordId);
      await as(ctx, admin).post(`/api/v1/records/${recordId}/checkout`).expect(200);
      await resolve(link.token).expect(200);
      await content(link.token).expect(200);
    });
  });

  describe('trash, restore and purge', () => {
    it('trash pauses a link and restore revives it', async () => {
      const recordId = await fileRecord('Restored');
      const link = await share(admin, recordId);
      await as(ctx, admin).delete(`/api/v1/records/${recordId}`).expect(204);
      await resolve(link.token).expect(404);
      await as(ctx, admin).post(`/api/v1/trash/records/${recordId}/restore`).expect(200);
      await resolve(link.token).expect(200);
    });

    it('purge deletes the link rows and keeps their audit entries', async () => {
      const recordId = await fileRecord('Purged');
      const link = await share(admin, recordId);
      const other = await share(admin, await fileRecord('Not purged'));
      await as(ctx, admin).delete(`/api/v1/records/${recordId}`).expect(204);
      await as(ctx, admin).delete(`/api/v1/trash/records/${recordId}`).expect(200);
      expect(await linksFor(recordId)).toEqual([]);
      expect(await linkOf(other.id)).not.toBeNull();
      await resolve(link.token).expect(404);
      expect(
        await audits.countDocuments({ action: 'SHARE_LINK_CREATED', 'resource.id': recordId }),
      ).toBe(1);
    });

    it('emptying the trash deletes the link rows of the records it purges', async () => {
      const first = await fileRecord('Emptied one');
      const second = await fileRecord('Emptied two');
      const live = await fileRecord('Still live');
      await share(admin, first);
      await share(admin, second);
      const kept = await share(admin, live);
      await as(ctx, admin).delete(`/api/v1/records/${first}`).expect(204);
      await as(ctx, admin).delete(`/api/v1/records/${second}`).expect(204);
      await as(ctx, admin).delete('/api/v1/trash').expect(200);
      expect(await linksFor(first)).toEqual([]);
      expect(await linksFor(second)).toEqual([]);
      expect(await linkOf(kept.id)).not.toBeNull();
      await resolve(kept.token).expect(200);
    });

    it('purging a folder deletes the links of the records inside it', async () => {
      const folder = await as(ctx, admin)
        .post('/api/v1/folders')
        .send({ name: `Doomed ${Date.now()}`, parentId: ws.folderId })
        .expect(201);
      const recordId = await fileRecord('In doomed folder', folder.body.id as string);
      await share(admin, recordId);
      await as(ctx, admin).delete(`/api/v1/folders/${folder.body.id}`).expect(204);
      await as(ctx, admin).delete(`/api/v1/trash/folders/${folder.body.id}`).expect(200);
      expect(await linksFor(recordId)).toEqual([]);
    });
  });
});
