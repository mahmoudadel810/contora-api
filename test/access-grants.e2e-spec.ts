import { HttpException } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import { AccessGrant } from '../src/access/access-grant.schema.js';
import { AccessGrantsRepository } from '../src/access/access-grants.repository.js';
import { AccessService } from '../src/access/access.service.js';
import type { Principal } from '../src/auth/principal.js';
import { RecordsRepository } from '../src/records/records.repository.js';
import { addMember, as, signUp, type Actor } from './helpers/actors.js';
import { createRecord, workspace, type Workspace } from './helpers/fixtures.js';
import { createTestApp, type TestApp } from './helpers/test-app.js';

const GRANTS = '/api/v1/access/grants';

function principalOf(actor: Actor): Principal {
  return {
    userId: actor.userId,
    tenantId: actor.tenantId,
    role: actor.role,
    email: actor.email,
    displayName: actor.displayName,
  };
}

async function thrownBody(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HttpException) return error.getResponse();
    throw error;
  }
  throw new Error('expected the call to throw');
}

describe('access grants (e2e)', () => {
  let ctx: TestApp;
  let admin: Actor;
  let member: Actor;
  let ws: Workspace;
  let subfolderId: string;
  let grantModel: Model<AccessGrant>;
  let access: AccessService;

  beforeAll(async () => {
    ctx = await createTestApp();
    admin = await signUp(ctx, { tenantName: 'Grants Co' });
    member = await addMember(ctx, admin);
    ws = await workspace(ctx, admin, 'Finance');
    const sub = await as(ctx, admin)
      .post('/api/v1/folders')
      .send({ name: 'Q1', parentId: ws.folderId })
      .expect(201);
    subfolderId = sub.body.id as string;
    grantModel = ctx.app.get<Model<AccessGrant>>(getModelToken(AccessGrant.name));
    access = ctx.app.get(AccessService);
  });

  afterAll(async () => {
    await ctx.stop();
  });

  const put = (actor: Actor, body: object) => as(ctx, actor).put(GRANTS).send(body);

  async function auditOf(action: string, resourceId: string) {
    const res = await as(ctx, admin)
      .get(`/api/v1/audit?action=${action}&resourceId=${resourceId}&pageSize=100`)
      .expect(200);
    return res.body.items as Array<{ context: Record<string, unknown>; resource: unknown }>;
  }

  async function newFolder(name: string, parentId = ws.rootId): Promise<string> {
    const res = await as(ctx, admin).post('/api/v1/folders').send({ name, parentId }).expect(201);
    return res.body.id as string;
  }

  describe('PUT /access/grants', () => {
    it('creates a grant, audits it, and changes only its level on the next PUT', async () => {
      const grantee = await addMember(ctx, admin);
      const created = await put(admin, {
        userId: grantee.userId,
        targetType: 'folder',
        targetId: ws.folderId,
        level: 'view',
      }).expect(200);
      expect(created.body).toMatchObject({
        userId: grantee.userId,
        userName: grantee.displayName,
        targetType: 'folder',
        targetId: ws.folderId,
        targetName: 'Finance',
        level: 'view',
        createdBy: admin.userId,
        createdByName: admin.displayName,
        created: true,
      });
      expect(created.body.id).toMatch(/^[a-f0-9]{24}$/);
      let entries = await auditOf('ACCESS_GRANTED', ws.folderId);
      const mine = () => entries.filter((e) => e.context.userId === grantee.userId);
      expect(mine()).toHaveLength(1);
      expect(mine()[0]).toMatchObject({
        resource: { type: 'folder', id: ws.folderId, label: 'Finance' },
        context: {
          userId: grantee.userId,
          userEmail: grantee.email,
          level: 'view',
          previousLevel: null,
        },
      });

      const again = await put(admin, {
        userId: grantee.userId,
        targetType: 'folder',
        targetId: ws.folderId,
        level: 'view',
      }).expect(200);
      expect(again.body).toMatchObject({ id: created.body.id, level: 'view', created: false });
      entries = await auditOf('ACCESS_GRANTED', ws.folderId);
      expect(mine()).toHaveLength(1);

      const raised = await put(admin, {
        userId: grantee.userId,
        targetType: 'folder',
        targetId: ws.folderId,
        level: 'edit',
      }).expect(200);
      expect(raised.body).toMatchObject({ id: created.body.id, level: 'edit', created: false });
      entries = await auditOf('ACCESS_GRANTED', ws.folderId);
      expect(mine()).toHaveLength(2);
      expect(mine()[0].context).toEqual({
        userId: grantee.userId,
        userEmail: grantee.email,
        level: 'edit',
        previousLevel: 'view',
      });
      expect(await grantModel.countDocuments({ userId: new Types.ObjectId(grantee.userId) })).toBe(
        1,
      );
    });

    it('grants a record and the root folder', async () => {
      const grantee = await addMember(ctx, admin);
      const record = await createRecord(ctx, admin, ws, { name: 'Root and record' });
      await put(admin, {
        userId: grantee.userId,
        targetType: 'record',
        targetId: record.id,
        level: 'edit',
      })
        .expect(200)
        .expect((res) => expect(res.body).toMatchObject({ targetName: 'Root and record' }));
      await put(admin, {
        userId: grantee.userId,
        targetType: 'folder',
        targetId: ws.rootId,
        level: 'view',
      })
        .expect(200)
        .expect((res) => expect(res.body).toMatchObject({ targetName: 'Repository' }));
    });

    it('validates the body', async () => {
      const valid = {
        userId: member.userId,
        targetType: 'folder',
        targetId: ws.folderId,
        level: 'view',
      };
      for (const body of [
        { ...valid, level: 'manage' },
        { ...valid, targetType: 'root' },
        { ...valid, userId: 'not-an-id' },
        { ...valid, targetId: '../x' },
        { ...valid, tenantId: admin.tenantId },
        { ...valid, createdBy: admin.userId },
        { userId: member.userId, targetType: 'folder', targetId: ws.folderId },
        {},
      ]) {
        const res = await put(admin, body).expect(400);
        expect(res.body.code).toBe('VALIDATION_FAILED');
      }
    });

    it('refuses admins, suspended and removed members, unknown users and dead targets', async () => {
      const otherAdmin = await addMember(ctx, admin, 'admin');
      const grant = (userId: string, targetType = 'folder', targetId = ws.folderId) =>
        put(admin, { userId, targetType, targetId, level: 'view' });

      expect((await grant(otherAdmin.userId).expect(409)).body.code).toBe('GRANTEE_IS_ADMIN');
      expect((await grant(admin.userId).expect(409)).body.code).toBe('GRANTEE_IS_ADMIN');

      const suspended = await addMember(ctx, admin);
      await as(ctx, admin).post(`/api/v1/members/${suspended.userId}/suspend`).expect(200);
      expect((await grant(suspended.userId).expect(409)).body.code).toBe('GRANTEE_SUSPENDED');

      const removed = await addMember(ctx, admin);
      await as(ctx, admin).delete(`/api/v1/members/${removed.userId}`).expect(204);
      expect((await grant(removed.userId).expect(404)).body.message).toBe('Member not found');
      expect((await grant(new Types.ObjectId().toHexString()).expect(404)).body.message).toBe(
        'Member not found',
      );

      const missing = new Types.ObjectId().toHexString();
      expect((await grant(member.userId, 'folder', missing).expect(404)).body.message).toBe(
        'Folder not found',
      );
      expect((await grant(member.userId, 'record', missing).expect(404)).body.message).toBe(
        'Record not found',
      );
      await grant(member.userId, 'record', ws.folderId).expect(404);

      const trashedFolder = await newFolder('Trashed folder');
      await as(ctx, admin).delete(`/api/v1/folders/${trashedFolder}`).expect(204);
      expect((await grant(member.userId, 'folder', trashedFolder).expect(404)).body.message).toBe(
        'Folder not found',
      );
      const trashedRecord = await createRecord(ctx, admin, ws, { name: 'Trashed record' });
      await as(ctx, admin).delete(`/api/v1/records/${trashedRecord.id}`).expect(204);
      await grant(member.userId, 'record', trashedRecord.id).expect(404);

      expect(await grantModel.countDocuments({ targetId: new Types.ObjectId(trashedFolder) })).toBe(
        0,
      );
    });

    it('retries a level change that another write overtook, and records it once', async () => {
      const grantee = await addMember(ctx, admin);
      const body = {
        userId: grantee.userId,
        targetType: 'folder',
        targetId: ws.folderId,
        level: 'view',
      };
      await put(admin, body).expect(200);
      const repository = ctx.app.get(AccessGrantsRepository);
      const spy = vi.spyOn(repository, 'updateOne').mockResolvedValueOnce(null);
      try {
        const res = await put(admin, { ...body, level: 'edit' }).expect(200);
        expect(res.body).toMatchObject({ level: 'edit', created: false });
        expect(spy).toHaveBeenCalledTimes(2);
      } finally {
        spy.mockRestore();
      }
      const entries = (await auditOf('ACCESS_GRANTED', ws.folderId)).filter(
        (e) => e.context.userId === grantee.userId,
      );
      expect(entries.map((e) => e.context.previousLevel)).toEqual(['view', null]);
    });

    it('gives up with GRANT_CHANGED_CONCURRENTLY after three overtaken writes', async () => {
      const grantee = await addMember(ctx, admin);
      const body = {
        userId: grantee.userId,
        targetType: 'folder',
        targetId: ws.folderId,
        level: 'view',
      };
      await put(admin, body).expect(200);
      const repository = ctx.app.get(AccessGrantsRepository);
      const spy = vi.spyOn(repository, 'updateOne').mockResolvedValue(null);
      try {
        const res = await put(admin, { ...body, level: 'edit' }).expect(409);
        expect(res.body.code).toBe('GRANT_CHANGED_CONCURRENTLY');
        expect(spy).toHaveBeenCalledTimes(3);
      } finally {
        spy.mockRestore();
      }
      const entries = (await auditOf('ACCESS_GRANTED', ws.folderId)).filter(
        (e) => e.context.userId === grantee.userId,
      );
      expect(entries).toHaveLength(1);
      const [grant] = (await as(ctx, admin).get(`${GRANTS}?userId=${grantee.userId}`).expect(200))
        .body as Array<{ level: string }>;
      expect(grant.level).toBe('view');
    });

    it('caps the grants a user can hold', async () => {
      const grantee = await addMember(ctx, admin);
      const repository = ctx.app.get(AccessGrantsRepository);
      const spy = vi.spyOn(repository, 'count').mockResolvedValueOnce(500);
      try {
        const res = await put(admin, {
          userId: grantee.userId,
          targetType: 'folder',
          targetId: ws.folderId,
          level: 'view',
        }).expect(409);
        expect(res.body.code).toBe('GRANT_LIMIT');
        expect(spy).toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
      expect(await grantModel.countDocuments({ userId: new Types.ObjectId(grantee.userId) })).toBe(
        0,
      );
    });
  });

  describe('GET /access/grants', () => {
    it('lists a target’s direct grants and those inherited from above, root first', async () => {
      const viewer = await addMember(ctx, admin);
      const editor = await addMember(ctx, admin);
      const direct = await addMember(ctx, admin);
      const record = await createRecord(
        ctx,
        admin,
        { ...ws, folderId: subfolderId },
        {
          name: 'Deep record',
        },
      );
      await put(admin, {
        userId: viewer.userId,
        targetType: 'folder',
        targetId: ws.rootId,
        level: 'view',
      }).expect(200);
      await put(admin, {
        userId: editor.userId,
        targetType: 'folder',
        targetId: ws.folderId,
        level: 'edit',
      }).expect(200);
      await put(admin, {
        userId: direct.userId,
        targetType: 'record',
        targetId: record.id,
        level: 'view',
      }).expect(200);

      const res = await as(ctx, admin)
        .get(`${GRANTS}?targetType=record&targetId=${record.id}`)
        .expect(200);
      expect(res.body.target).toEqual({ type: 'record', id: record.id, name: 'Deep record' });
      expect(res.body.direct).toEqual([
        expect.objectContaining({ userId: direct.userId, level: 'view', targetId: record.id }),
      ]);
      const inherited = (
        res.body.inherited as Array<{ userId: string; level: string; from: unknown }>
      ).filter((g) => [viewer.userId, editor.userId].includes(g.userId));
      expect(inherited).toEqual([
        expect.objectContaining({
          userId: viewer.userId,
          level: 'view',
          from: { type: 'folder', id: ws.rootId, name: 'Repository' },
        }),
        expect.objectContaining({
          userId: editor.userId,
          level: 'edit',
          from: { type: 'folder', id: ws.folderId, name: 'Finance' },
        }),
      ]);

      const folder = await as(ctx, admin)
        .get(`${GRANTS}?targetType=folder&targetId=${subfolderId}`)
        .expect(200);
      expect(folder.body.target).toEqual({ type: 'folder', id: subfolderId, name: 'Q1' });
      expect(folder.body.direct).toEqual([]);
      expect((folder.body.inherited as Array<{ userId: string }>).map((g) => g.userId)).toEqual(
        expect.arrayContaining([viewer.userId, editor.userId]),
      );
      expect(
        (folder.body.inherited as Array<{ userId: string }>).map((g) => g.userId),
      ).not.toContain(direct.userId);
    });

    it('lists one member’s grants with target names', async () => {
      const grantee = await addMember(ctx, admin);
      const record = await createRecord(ctx, admin, ws, { name: 'Listed record' });
      await put(admin, {
        userId: grantee.userId,
        targetType: 'record',
        targetId: record.id,
        level: 'edit',
      }).expect(200);
      await put(admin, {
        userId: grantee.userId,
        targetType: 'folder',
        targetId: subfolderId,
        level: 'view',
      }).expect(200);
      const res = await as(ctx, admin).get(`${GRANTS}?userId=${grantee.userId}`).expect(200);
      expect(res.body).toEqual([
        expect.objectContaining({ targetType: 'folder', targetName: 'Q1', level: 'view' }),
        expect.objectContaining({
          targetType: 'record',
          targetName: 'Listed record',
          level: 'edit',
        }),
      ]);
      const nobody = await addMember(ctx, admin);
      expect(
        (await as(ctx, admin).get(`${GRANTS}?userId=${nobody.userId}`).expect(200)).body,
      ).toEqual([]);
      await as(ctx, admin)
        .get(`${GRANTS}?userId=${new Types.ObjectId().toHexString()}`)
        .expect(404);
    });

    it('validates the query and refuses trashed or missing targets', async () => {
      for (const query of [
        '',
        `?userId=${member.userId}&targetType=folder&targetId=${ws.folderId}`,
        '?targetType=folder',
        `?targetId=${ws.folderId}`,
        `?targetType=root&targetId=${ws.folderId}`,
        '?userId=nope',
        `?userId=${member.userId}&extra=1`,
      ]) {
        const res = await as(ctx, admin).get(`${GRANTS}${query}`).expect(400);
        expect(res.body.code).toBe('VALIDATION_FAILED');
      }
      const trashed = await newFolder('Trashed for listing');
      await as(ctx, admin).delete(`/api/v1/folders/${trashed}`).expect(204);
      await as(ctx, admin).get(`${GRANTS}?targetType=folder&targetId=${trashed}`).expect(404);
      await as(ctx, admin)
        .get(`${GRANTS}?targetType=record&targetId=${new Types.ObjectId().toHexString()}`)
        .expect(404);
    });
  });

  describe('DELETE /access/grants/:id', () => {
    it('revokes, audits, and 404s afterwards', async () => {
      const grantee = await addMember(ctx, admin);
      const granted = await put(admin, {
        userId: grantee.userId,
        targetType: 'folder',
        targetId: subfolderId,
        level: 'edit',
      }).expect(200);
      const res = await as(ctx, admin).delete(`${GRANTS}/${granted.body.id}`).expect(200);
      expect(res.body).toEqual({ heldCheckouts: [] });
      const entries = (await auditOf('ACCESS_REVOKED', subfolderId)).filter(
        (e) => e.context.userId === grantee.userId,
      );
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        resource: { type: 'folder', id: subfolderId, label: 'Q1' },
        context: {
          userId: grantee.userId,
          userEmail: grantee.email,
          level: 'edit',
          heldCheckouts: 0,
        },
      });
      await as(ctx, admin).delete(`${GRANTS}/${granted.body.id}`).expect(404);
      await as(ctx, admin).delete(`${GRANTS}/not-an-id`).expect(404);
    });

    it('succeeds while the member holds a check-out, and reports the records they lose', async () => {
      const grantee = await addMember(ctx, admin);
      const folder = await newFolder('Held');
      const lost = await createRecord(ctx, admin, { ...ws, folderId: folder }, { name: 'Lost' });
      const kept = await createRecord(ctx, admin, { ...ws, folderId: folder }, { name: 'Kept' });
      const elsewhere = await createRecord(ctx, admin, ws, { name: 'Elsewhere' });
      const folderGrant = await put(admin, {
        userId: grantee.userId,
        targetType: 'folder',
        targetId: folder,
        level: 'edit',
      }).expect(200);
      await put(admin, {
        userId: grantee.userId,
        targetType: 'record',
        targetId: kept.id,
        level: 'edit',
      }).expect(200);
      await put(admin, {
        userId: grantee.userId,
        targetType: 'folder',
        targetId: ws.folderId,
        level: 'edit',
      }).expect(200);
      for (const id of [lost.id, kept.id, elsewhere.id]) {
        await as(ctx, grantee).post(`/api/v1/records/${id}/checkout`).expect(200);
      }
      const res = await as(ctx, admin).delete(`${GRANTS}/${folderGrant.body.id}`).expect(200);
      expect(res.body).toEqual({ heldCheckouts: [{ id: lost.id, name: 'Lost' }] });
      const [entry] = (await auditOf('ACCESS_REVOKED', folder)).filter(
        (e) => e.context.userId === grantee.userId,
      );
      expect(entry.context.heldCheckouts).toBe(1);
    });
  });

  describe('who may manage grants', () => {
    it('refuses members on every route and records ACCESS_DENIED', async () => {
      const granted = await put(admin, {
        userId: member.userId,
        targetType: 'folder',
        targetId: subfolderId,
        level: 'view',
      }).expect(200);
      const before = await as(ctx, admin)
        .get('/api/v1/audit?action=ACCESS_DENIED&pageSize=100')
        .expect(200);
      await as(ctx, member).get(`${GRANTS}?userId=${member.userId}`).expect(403);
      await as(ctx, member).get(`${GRANTS}?targetType=folder&targetId=${ws.folderId}`).expect(403);
      await put(member, {
        userId: member.userId,
        targetType: 'folder',
        targetId: ws.folderId,
        level: 'edit',
      }).expect(403);
      await as(ctx, member).delete(`${GRANTS}/${granted.body.id}`).expect(403);
      const after = await as(ctx, admin)
        .get('/api/v1/audit?action=ACCESS_DENIED&pageSize=100')
        .expect(200);
      const denied = (
        after.body.items as Array<{ actor: { id: string }; context: Record<string, unknown> }>
      ).filter(
        (e) => e.actor.id === member.userId && e.context.attemptedAction === 'access.manage',
      );
      expect(after.body.total - before.body.total).toBe(4);
      expect(denied.length).toBeGreaterThanOrEqual(4);
      expect(
        await grantModel.exists({ _id: new Types.ObjectId(granted.body.id as string) }),
      ).not.toBeNull();
      await ctx.http().get(`${GRANTS}?userId=${member.userId}`).expect(401);
    });

    it('keeps grant decisions out of the record’s activity feed', async () => {
      const grantee = await addMember(ctx, admin);
      const record = await createRecord(ctx, admin, ws, { name: 'Feed record' });
      const granted = await put(admin, {
        userId: grantee.userId,
        targetType: 'record',
        targetId: record.id,
        level: 'view',
      }).expect(200);
      await as(ctx, admin).delete(`${GRANTS}/${granted.body.id}`).expect(200);
      const feed = await as(ctx, admin).get(`/api/v1/records/${record.id}/activity`).expect(200);
      const actions = (feed.body.items as Array<{ action: string }>).map((e) => e.action);
      expect(actions).toContain('RECORD_CREATED');
      expect(actions).not.toContain('ACCESS_GRANTED');
      expect(actions).not.toContain('ACCESS_REVOKED');
    });

    it('enforces grants: a member without one sees nothing', async () => {
      const ungranted = await addMember(ctx, admin);
      const record = await createRecord(ctx, admin, ws, { name: 'No longer visible' });
      await as(ctx, ungranted).get(`/api/v1/records/${record.id}`).expect(404);
      await as(ctx, ungranted).get(`/api/v1/folders/${ws.folderId}`).expect(404);
      await as(ctx, ungranted).get('/api/v1/members').expect(403);
    });
  });

  describe('tenant isolation', () => {
    let other: Actor;
    let otherMember: Actor;
    let otherWs: Workspace;

    beforeAll(async () => {
      other = await signUp(ctx, { tenantName: 'Other Grants Co' });
      otherMember = await addMember(ctx, other);
      otherWs = await workspace(ctx, other, 'Other finance');
    });

    it('answers 404 for another tenant’s users, targets and grants', async () => {
      const record = await createRecord(ctx, admin, ws, { name: 'Tenant A record' });
      const grant = await put(admin, {
        userId: member.userId,
        targetType: 'record',
        targetId: record.id,
        level: 'edit',
      }).expect(200);

      expect(
        (
          await put(admin, {
            userId: otherMember.userId,
            targetType: 'folder',
            targetId: ws.folderId,
            level: 'view',
          }).expect(404)
        ).body.message,
      ).toBe('Member not found');
      const otherRecord = await createRecord(ctx, other, otherWs, { name: 'Tenant B record' });
      await put(admin, {
        userId: member.userId,
        targetType: 'folder',
        targetId: otherWs.folderId,
        level: 'view',
      }).expect(404);
      await put(admin, {
        userId: member.userId,
        targetType: 'record',
        targetId: otherRecord.id,
        level: 'view',
      }).expect(404);
      await put(other, {
        userId: member.userId,
        targetType: 'record',
        targetId: record.id,
        level: 'view',
      }).expect(404);
      await put(other, {
        userId: otherMember.userId,
        targetType: 'record',
        targetId: record.id,
        level: 'view',
      }).expect(404);
      await as(ctx, other).get(`${GRANTS}?userId=${member.userId}`).expect(404);
      await as(ctx, other).get(`${GRANTS}?targetType=record&targetId=${record.id}`).expect(404);
      await as(ctx, other).get(`${GRANTS}?targetType=folder&targetId=${ws.rootId}`).expect(404);
      await as(ctx, other).delete(`${GRANTS}/${grant.body.id}`).expect(404);
      for (const [targetType, targetId] of [
        ['folder', otherWs.folderId],
        ['folder', otherWs.rootId],
        ['record', otherRecord.id],
      ]) {
        const res = await as(ctx, admin)
          .get(`${GRANTS}?targetType=${targetType}&targetId=${targetId}`)
          .expect(404);
        expect(res.body.code).toBe('NOT_FOUND');
      }

      expect(
        await grantModel.exists({ _id: new Types.ObjectId(grant.body.id as string) }),
      ).not.toBeNull();
      expect(
        await grantModel.countDocuments({ tenantId: new Types.ObjectId(other.tenantId) }),
      ).toBe(0);
      await put(other, {
        userId: otherMember.userId,
        targetType: 'folder',
        targetId: otherWs.folderId,
        level: 'view',
      }).expect(200);
      const theirs = await as(ctx, other).get(`${GRANTS}?userId=${otherMember.userId}`).expect(200);
      expect(theirs.body).toHaveLength(1);
      expect(JSON.stringify(theirs.body)).not.toContain(record.id);
    });
  });

  describe('races', () => {
    it('keeps one grant when identical PUTs run at once', async () => {
      const grantee = await addMember(ctx, admin);
      const body = {
        userId: grantee.userId,
        targetType: 'folder',
        targetId: subfolderId,
        level: 'edit',
      };
      const results = await Promise.all([1, 2, 3, 4].map(() => put(admin, body)));
      expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200]);
      expect(results.filter((r) => r.body.created === true)).toHaveLength(1);
      expect(new Set(results.map((r) => r.body.id as string)).size).toBe(1);
      expect(await grantModel.countDocuments({ userId: new Types.ObjectId(grantee.userId) })).toBe(
        1,
      );
      const entries = (await auditOf('ACCESS_GRANTED', subfolderId)).filter(
        (e) => e.context.userId === grantee.userId,
      );
      expect(entries).toHaveLength(1);
    });

    it('leaves no grant when the target is trashed during the PUT', async () => {
      const grantee = await addMember(ctx, admin);
      const folder = await newFolder('Trashed during PUT');
      const repository = ctx.app.get(AccessGrantsRepository);
      const count = repository.count.bind(repository);
      const spy = vi.spyOn(repository, 'count').mockImplementationOnce(async (tenantId, filter) => {
        await as(ctx, admin).delete(`/api/v1/folders/${folder}`).expect(204);
        return count(tenantId, filter);
      });
      try {
        const res = await put(admin, {
          userId: grantee.userId,
          targetType: 'folder',
          targetId: folder,
          level: 'view',
        }).expect(404);
        expect(res.body.message).toBe('Folder not found');
        expect(spy).toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
      expect(await grantModel.countDocuments({ userId: new Types.ObjectId(grantee.userId) })).toBe(
        0,
      );
      expect(
        (await auditOf('ACCESS_GRANTED', folder)).filter(
          (e) => e.context.userId === grantee.userId,
        ),
      ).toHaveLength(0);
    });

    it('leaves no grant when the member is removed during the PUT', async () => {
      const grantee = await addMember(ctx, admin);
      const repository = ctx.app.get(AccessGrantsRepository);
      const count = repository.count.bind(repository);
      const spy = vi.spyOn(repository, 'count').mockImplementationOnce(async (tenantId, filter) => {
        await as(ctx, admin).delete(`/api/v1/members/${grantee.userId}`).expect(204);
        return count(tenantId, filter);
      });
      try {
        const res = await put(admin, {
          userId: grantee.userId,
          targetType: 'folder',
          targetId: ws.folderId,
          level: 'view',
        }).expect(404);
        expect(res.body.message).toBe('Member not found');
        expect(spy).toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
      expect(await grantModel.countDocuments({ userId: new Types.ObjectId(grantee.userId) })).toBe(
        0,
      );
    });

    it('leaves no grant when the member is suspended during the PUT', async () => {
      const grantee = await addMember(ctx, admin);
      const repository = ctx.app.get(AccessGrantsRepository);
      const count = repository.count.bind(repository);
      const spy = vi.spyOn(repository, 'count').mockImplementationOnce(async (tenantId, filter) => {
        await as(ctx, admin).post(`/api/v1/members/${grantee.userId}/suspend`).expect(200);
        return count(tenantId, filter);
      });
      try {
        const res = await put(admin, {
          userId: grantee.userId,
          targetType: 'folder',
          targetId: ws.folderId,
          level: 'view',
        }).expect(409);
        expect(res.body.code).toBe('GRANTEE_SUSPENDED');
        expect(spy).toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
      expect(await grantModel.countDocuments({ userId: new Types.ObjectId(grantee.userId) })).toBe(
        0,
      );
    });
  });

  describe('AccessService', () => {
    let grantee: Actor;
    let viewRecordId: string;
    let editRecordId: string;
    let hiddenRecordId: string;
    let hiddenFolderId: string;

    beforeAll(async () => {
      grantee = await addMember(ctx, admin);
      hiddenFolderId = await newFolder('Hidden');
      viewRecordId = (await createRecord(ctx, admin, ws, { name: 'In Finance' })).id;
      editRecordId = (
        await createRecord(ctx, admin, { ...ws, folderId: subfolderId }, { name: 'In Q1' })
      ).id;
      hiddenRecordId = (
        await createRecord(ctx, admin, { ...ws, folderId: hiddenFolderId }, { name: 'Hidden' })
      ).id;
      await put(admin, {
        userId: grantee.userId,
        targetType: 'folder',
        targetId: ws.folderId,
        level: 'view',
      }).expect(200);
      await put(admin, {
        userId: grantee.userId,
        targetType: 'folder',
        targetId: subfolderId,
        level: 'edit',
      }).expect(200);
    });

    it('scopeForUser re-reads the user: admin unrestricted, inactive or foreign users see nothing', async () => {
      expect((await access.scopeForUser(admin.tenantId, admin.userId)).unrestricted).toBe(true);

      const scope = await access.scopeForUser(admin.tenantId, grantee.userId);
      expect(scope.unrestricted).toBe(false);
      expect(scope.levelOfFolderId(ws.folderId)).toBe('view');
      expect(scope.levelOfFolderId(subfolderId)).toBe('edit');
      expect(scope.levelOfFolderId(hiddenFolderId)).toBeNull();

      const none = async (tenantId: string, userId: string) => {
        const s = await access.scopeForUser(tenantId, userId);
        expect(s.unrestricted).toBe(false);
        expect(s.levelOfFolderId(ws.folderId)).toBeNull();
        expect(s.levelOfFolderId(subfolderId)).toBeNull();
        expect(s.recordFilter('view')).toEqual({ _id: { $in: [] } });
      };
      const suspended = await addMember(ctx, admin);
      const removed = await addMember(ctx, admin);
      for (const user of [suspended, removed]) {
        await put(admin, {
          userId: user.userId,
          targetType: 'folder',
          targetId: ws.folderId,
          level: 'edit',
        }).expect(200);
      }
      await as(ctx, admin).post(`/api/v1/members/${suspended.userId}/suspend`).expect(200);
      await as(ctx, admin).delete(`/api/v1/members/${removed.userId}`).expect(204);
      await none(admin.tenantId, suspended.userId);
      await none(admin.tenantId, removed.userId);
      await none(admin.tenantId, new Types.ObjectId().toHexString());
      await none(admin.tenantId, 'not-an-id');
      const foreign = await signUp(ctx, { tenantName: 'Foreign scope' });
      await none(admin.tenantId, foreign.userId);
      const suspendedAdmin = await addMember(ctx, admin, 'admin');
      await as(ctx, admin).post(`/api/v1/members/${suspendedAdmin.userId}/suspend`).expect(200);
      await none(admin.tenantId, suspendedAdmin.userId);
    });

    it('requireRecord and requireFolder: 404 when hidden or missing (same body), 403 below the level', async () => {
      const p = principalOf(grantee);
      await expect(access.requireRecord(p, viewRecordId, 'view')).resolves.toMatchObject({
        name: 'In Finance',
      });
      await expect(access.requireRecord(p, editRecordId, 'edit')).resolves.toMatchObject({
        name: 'In Q1',
      });
      const hidden = await thrownBody(access.requireRecord(p, hiddenRecordId, 'view'));
      const missing = await thrownBody(
        access.requireRecord(p, new Types.ObjectId().toHexString(), 'view'),
      );
      const malformed = await thrownBody(access.requireRecord(p, 'nope', 'view'));
      expect(hidden).toEqual({ statusCode: 404, code: 'NOT_FOUND', message: 'Record not found' });
      expect(missing).toEqual(hidden);
      expect(malformed).toEqual(hidden);
      expect(await thrownBody(access.requireFolder(p, hiddenFolderId, 'view'))).toEqual(
        await thrownBody(access.requireFolder(p, new Types.ObjectId().toHexString(), 'view')),
      );

      expect(await thrownBody(access.requireRecord(p, viewRecordId, 'edit'))).toMatchObject({
        statusCode: 403,
      });
      const denied = await auditOf('ACCESS_DENIED', viewRecordId);
      expect(denied[0]).toMatchObject({
        resource: { type: 'record', id: viewRecordId, label: 'In Finance' },
        context: {
          attemptedAction: 'access.edit',
          attemptedAccess: 'edit',
          level: 'view',
          role: 'member',
        },
      });
      expect(await auditOf('ACCESS_DENIED', hiddenRecordId)).toEqual([]);

      await expect(access.requireFolder(p, subfolderId, 'edit')).resolves.toMatchObject({
        name: 'Q1',
      });
      expect(
        await thrownBody(access.requireFolder(p, ws.folderId, 'view', { itself: true })),
      ).toMatchObject({ statusCode: 403 });
      await expect(
        access.requireFolder(p, subfolderId, 'view', { itself: true }),
      ).resolves.toBeDefined();
      expect(
        await thrownBody(access.requireFolder(p, subfolderId, 'edit', { itself: true })),
      ).toMatchObject({ statusCode: 403 });

      await expect(
        access.requireRecord(principalOf(admin), hiddenRecordId, 'edit'),
      ).resolves.toBeDefined();
    });

    it('require* distinguishes live from trashed', async () => {
      const p = principalOf(grantee);
      const trashed = await createRecord(
        ctx,
        admin,
        { ...ws, folderId: subfolderId },
        {
          name: 'Soon trashed',
        },
      );
      await as(ctx, admin).delete(`/api/v1/records/${trashed.id}`).expect(204);
      expect(await thrownBody(access.requireRecord(p, trashed.id, 'view'))).toMatchObject({
        statusCode: 404,
      });
      await expect(
        access.requireRecord(p, trashed.id, 'edit', { trashed: true }),
      ).resolves.toMatchObject({ name: 'Soon trashed' });
      expect(
        await thrownBody(access.requireRecord(p, editRecordId, 'view', { trashed: true })),
      ).toMatchObject({ statusCode: 404 });
    });

    it('caches the scope per request, and recomputes it on demand', async () => {
      const p = principalOf(grantee);
      const first = await access.scopeFor(p);
      expect(await access.scopeFor(p)).toBe(first);
      const fresh = await access.scopeFor(p, { fresh: true });
      expect(fresh).not.toBe(first);
      expect(await access.scopeFor(p)).toBe(fresh);
      expect(await access.scopeFor(principalOf(grantee))).not.toBe(fresh);
    });

    it('loads the subtree of a grant above the root level (root View, folder Edit)', async () => {
      const user = await addMember(ctx, admin);
      const folder = await newFolder('Expanded');
      const sub = await newFolder('Expanded sub', folder);
      const deep = await createRecord(ctx, admin, { ...ws, folderId: sub }, { name: 'Deep edit' });
      for (const [targetId, level] of [
        [ws.rootId, 'view'],
        [folder, 'edit'],
      ]) {
        await put(admin, { userId: user.userId, targetType: 'folder', targetId, level }).expect(
          200,
        );
      }
      const scope = await access.scopeForUser(admin.tenantId, user.userId);
      expect(scope.levelOfFolderId(sub)).toBe('edit');
      expect(scope.levelOfFolderId(hiddenFolderId)).toBe('view');
      const editable = await ctx.app.get(RecordsRepository).find(admin.tenantId, {
        $and: [{ deletedAt: null }, await access.recordScope(principalOf(user), 'edit')],
      });
      expect(editable.map((r) => r.id as string)).toContain(deep.id);
      expect(editable.map((r) => r.id as string)).not.toContain(hiddenRecordId);
    });

    it('needs no subtree beneath a root grant that covers it (root Edit, folder View)', async () => {
      const user = await addMember(ctx, admin);
      const folder = await newFolder('Covered');
      const sub = await newFolder('Covered sub', folder);
      for (const [targetId, level] of [
        [ws.rootId, 'edit'],
        [folder, 'view'],
      ]) {
        await put(admin, { userId: user.userId, targetType: 'folder', targetId, level }).expect(
          200,
        );
      }
      const scope = await access.scopeForUser(admin.tenantId, user.userId);
      expect(scope.levelOfFolderId(sub)).toBe('edit');
      expect(scope.recordFilter('edit')).toEqual({});
      expect(scope.entryPoints()).toEqual([{ type: 'folder', id: ws.rootId, level: 'edit' }]);
    });

    it('assertLevel applies the same 404 and the same ACCESS_DENIED entry as requireRecord', async () => {
      const p = principalOf(grantee);
      const resource = { type: 'record', id: viewRecordId, label: 'In Finance' };
      expect(await thrownBody(access.assertLevel(p, resource, null, 'view'))).toEqual(
        await thrownBody(access.requireRecord(p, hiddenRecordId, 'view')),
      );
      await expect(access.assertLevel(p, resource, 'view', 'view')).resolves.toBeUndefined();

      expect(await thrownBody(access.requireRecord(p, viewRecordId, 'edit'))).toMatchObject({
        statusCode: 403,
      });
      expect(await thrownBody(access.assertLevel(p, resource, 'view', 'edit'))).toMatchObject({
        statusCode: 403,
      });
      const [fromAssert, fromRequire] = await auditOf('ACCESS_DENIED', viewRecordId);
      expect(fromAssert.resource).toEqual(fromRequire.resource);
      expect(fromAssert.context).toEqual(fromRequire.context);
    });

    it('housekeeping skips malformed ids instead of throwing', async () => {
      await expect(access.clearForUser(admin.tenantId, 'not-an-id')).resolves.toBe(0);
      await expect(
        access.purgeForTargets(admin.tenantId, { folderIds: ['nope'], recordIds: ['../x'] }),
      ).resolves.toBe(0);
    });

    it('recordScope and folderFilter select only what the member can reach', async () => {
      const p = principalOf(grantee);
      const records = ctx.app.get(RecordsRepository);
      const visible = await records.find(admin.tenantId, {
        $and: [{ deletedAt: null }, await access.recordScope(p, 'view')],
      });
      const names = visible.map((r) => r.name);
      expect(names).toEqual(expect.arrayContaining(['In Finance', 'In Q1']));
      expect(names).not.toContain('Hidden');
      const editable = await records.find(admin.tenantId, {
        $and: [{ deletedAt: null }, await access.recordScope(p, 'edit')],
      });
      expect(editable.map((r) => r.name)).toContain('In Q1');
      expect(editable.map((r) => r.name)).not.toContain('In Finance');
      expect(await access.folderFilter(p, 'edit')).toEqual({
        _id: { $in: [new Types.ObjectId(subfolderId)] },
      });
      expect(await access.recordScope(principalOf(admin), 'edit')).toEqual({});
    });

    it('clearForUser and purgeForTargets delete grants, in the tenant only', async () => {
      const user = await addMember(ctx, admin);
      const record = await createRecord(ctx, admin, ws, { name: 'Purge target' });
      const purgedFolder = await newFolder('Purge folder');
      for (const [targetType, targetId] of [
        ['folder', ws.folderId],
        ['folder', purgedFolder],
        ['record', record.id],
      ] as const) {
        await put(admin, { userId: user.userId, targetType, targetId, level: 'view' }).expect(200);
      }
      const other = await signUp(ctx, { tenantName: 'Purge other' });
      expect(
        await access.purgeForTargets(other.tenantId, {
          recordIds: [new Types.ObjectId(record.id)],
        }),
      ).toBe(0);
      expect(await access.clearForUser(other.tenantId, user.userId)).toBe(0);
      expect(
        await access.purgeForTargets(admin.tenantId, {
          folderIds: [new Types.ObjectId(purgedFolder)],
          recordIds: [new Types.ObjectId(record.id)],
        }),
      ).toBe(2);
      expect(await access.purgeForTargets(admin.tenantId, {})).toBe(0);
      const left = await as(ctx, admin).get(`${GRANTS}?userId=${user.userId}`).expect(200);
      expect(left.body.map((g: { targetId: string }) => g.targetId)).toEqual([ws.folderId]);
      expect(await access.clearForUser(admin.tenantId, user.userId)).toBe(1);
      expect(
        (await as(ctx, admin).get(`${GRANTS}?userId=${user.userId}`).expect(200)).body,
      ).toEqual([]);
    });
  });
});
