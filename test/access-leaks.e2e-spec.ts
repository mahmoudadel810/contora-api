import { createHash } from 'node:crypto';
import { getConnectionToken } from '@nestjs/mongoose';
import { Types, type Connection } from 'mongoose';
import { AccessService } from '../src/access/access.service.js';
import { ROUTE_DOCS, ROUTE_SCOPES } from '../src/api-reference/route-docs.js';
import { SessionsService } from '../src/auth/sessions.service.js';
import { ContentTypesService } from '../src/content-types/content-types.service.js';
import { FoldersRepository } from '../src/folders/folders.repository.js';
import { DEMO_ADMIN, DEMO_PASSWORD } from '../src/seed/demo-data.js';
import { PEOPLE_LIMIT } from '../src/members/members.service.js';
import { SeedModule } from '../src/seed/seed.module.js';
import { SeedService } from '../src/seed/seed.service.js';
import { RecordsRepository, VersionsRepository } from '../src/records/records.repository.js';
import { BlobsService } from '../src/storage/blobs.service.js';
import { UsersRepository } from '../src/users/users.repository.js';
import {
  addMember,
  agentFor,
  as,
  DEFAULT_PASSWORD,
  signIn,
  signUp,
  type Actor,
} from './helpers/actors.js';
import { createRecord, grantAccess, workspace, type Workspace } from './helpers/fixtures.js';
import { createTestApp, type TestApp } from './helpers/test-app.js';

function stripped(body: unknown): unknown {
  if (body === null || typeof body !== 'object') return body;
  const copy = { ...(body as Record<string, unknown>) };
  delete copy.requestId;
  return copy;
}

const randomId = () => new Types.ObjectId().toHexString();

const inADay = () => new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

type Named = { id: string; name: string };

interface Ids {
  record: string;
  other: string;
  trashedRecord: string;
  folder: string;
  otherFolder: string;
  trashedFolder: string;
  comment: string;
  relation: string;
  savedSearch: string;
  notification: string;
  shareLink: string;
}

describe('access grants on every path (e2e)', () => {
  let ctx: TestApp;
  let admin: Actor;
  let viewer: Actor;
  let stranger: Actor;
  let ws: Workspace;
  let rootId: string;
  let folderA: string;
  let folderB: string;
  let folderC: string;
  let folderE: string;
  let folderE2: string;
  let rA: string;
  let rB: string;
  let rC: string;
  let rX: string;
  let rE: string;

  const mkdir = async (name: string, parentId: string): Promise<string> =>
    (await as(ctx, admin).post('/api/v1/folders').send({ name, parentId }).expect(201)).body
      .id as string;
  const recordIn = async (folderId: string, name: string, actor = admin): Promise<string> =>
    (await createRecord(ctx, actor, { ...ws, folderId }, { name })).id;
  const grant = (
    user: Actor,
    targetType: 'folder' | 'record',
    targetId: string,
    level: 'view' | 'edit',
  ) => grantAccess(ctx, admin, { userId: user.userId, targetType, targetId, level });
  const revoke = (grantId: string) =>
    as(ctx, admin).delete(`/api/v1/access/grants/${grantId}`).expect(200);
  const deniedCount = async (actor: Actor, resourceId: string): Promise<number> =>
    (
      await as(ctx, admin)
        .get(`/api/v1/audit?action=ACCESS_DENIED&actorId=${actor.userId}&resourceId=${resourceId}`)
        .expect(200)
    ).body.total as number;
  const folderOf = async (recordId: string): Promise<string> =>
    (await as(ctx, admin).get(`/api/v1/records/${recordId}`).expect(200)).body.record
      .folderId as string;
  const answer = async (request: PromiseLike<{ status: number; body: unknown }>) => {
    const res = await request;
    return { status: res.status, body: stripped(res.body) };
  };

  beforeAll(async () => {
    ctx = await createTestApp();
    admin = await signUp(ctx, { tenantName: 'Leaks Co' });
    ws = await workspace(ctx, admin, 'A');
    rootId = ws.rootId;
    folderA = ws.folderId;
    folderB = await mkdir('B', folderA);
    folderC = await mkdir('C', rootId);
    folderE = await mkdir('E', rootId);
    folderE2 = await mkdir('E2', folderE);
    rA = await recordIn(folderA, 'Leak rA');
    rB = await recordIn(folderB, 'Leak rB');
    rC = await recordIn(folderC, 'Leak rC');
    rX = await recordIn(folderC, 'Leak rX secret');
    rE = await recordIn(folderE, 'Leak rE');
    viewer = await addMember(ctx, admin);
    await grant(viewer, 'folder', folderA, 'view');
    await grant(viewer, 'record', rC, 'view');
    await grant(viewer, 'folder', folderE, 'edit');
    stranger = await addMember(ctx, admin);
  });

  afterAll(async () => {
    await ctx.stop();
  });

  describe('folders (folders.service.ts)', () => {
    it('hides the root without a root grant, and shows granted folders without a hidden parent', async () => {
      const root = await answer(as(ctx, viewer).get('/api/v1/folders/root'));
      expect(root.status).toBe(404);
      expect(root).toEqual(await answer(as(ctx, viewer).get(`/api/v1/folders/${randomId()}`)));

      const a = await as(ctx, viewer).get(`/api/v1/folders/${folderA}`).expect(200);
      expect(a.body.folder).toMatchObject({ id: folderA, parentId: null, access: 'view' });
      expect(a.body.access).toBe('view');
      expect(a.body.breadcrumbs.map((c: Named) => c.name)).toEqual(['A']);
      expect(a.body.folders.map((f: Named) => f.name)).toEqual(['B']);

      const b = await as(ctx, viewer).get(`/api/v1/folders/${folderB}`).expect(200);
      expect(b.body.folder.parentId).toBe(folderA);
      expect(b.body.breadcrumbs.map((c: Named) => c.name)).toEqual(['A', 'B']);

      const hidden = await answer(as(ctx, viewer).get(`/api/v1/folders/${folderC}`));
      expect(hidden.status).toBe(404);
      expect(hidden).toEqual(await answer(as(ctx, viewer).get(`/api/v1/folders/${randomId()}`)));

      const tree = await as(ctx, viewer).get('/api/v1/folders/tree').expect(200);
      const names = (tree.body as Named[]).map((f) => f.name);
      expect(names).toEqual(expect.arrayContaining(['A', 'B', 'E', 'E2']));
      expect(names).not.toContain('C');
      expect(names).not.toContain('Repository');
      expect(
        (tree.body as Array<Named & { parentId: string | null }>).find((f) => f.id === folderA)
          ?.parentId,
      ).toBeNull();
    });

    it('needs Edit on the parent to create, and Edit from the parent to rename, move or trash', async () => {
      const before = await deniedCount(viewer, folderA);
      const refused = await as(ctx, viewer)
        .post('/api/v1/folders')
        .send({ name: 'Not here', parentId: folderA })
        .expect(403);
      expect(refused.body.code).toBe('FORBIDDEN');
      expect(await deniedCount(viewer, folderA)).toBe(before + 1);

      const hidden = await answer(
        as(ctx, viewer).post('/api/v1/folders').send({ name: 'Nope', parentId: folderC }),
      );
      expect(hidden).toMatchObject({ status: 404, body: { message: 'Parent folder not found' } });
      expect(hidden).toEqual(
        await answer(
          as(ctx, viewer).post('/api/v1/folders').send({ name: 'Nope', parentId: randomId() }),
        ),
      );

      const made = await as(ctx, viewer)
        .post('/api/v1/folders')
        .send({ name: 'Made by viewer', parentId: folderE })
        .expect(201);
      expect(made.body.access).toBe('edit');
      await as(ctx, viewer).patch(`/api/v1/folders/${folderE}`).send({ name: 'E!' }).expect(403);
      await as(ctx, viewer).delete(`/api/v1/folders/${folderE}`).expect(403);
      await as(ctx, viewer)
        .patch(`/api/v1/folders/${made.body.id}`)
        .send({ name: 'Renamed by viewer' })
        .expect(200);
      await as(ctx, viewer)
        .post(`/api/v1/folders/${made.body.id}/move`)
        .send({ parentId: folderA })
        .expect(403);
      const target = await as(ctx, viewer)
        .post(`/api/v1/folders/${made.body.id}/move`)
        .send({ parentId: folderC })
        .expect(404);
      expect(target.body.message).toBe('Target folder not found');
      await as(ctx, viewer).patch(`/api/v1/folders/${folderB}`).send({ name: 'B!' }).expect(403);
      await as(ctx, viewer).patch(`/api/v1/folders/${folderC}`).send({ name: 'C!' }).expect(404);
    });

    it('tells the UI the level on changing each folder itself (accessItself)', async () => {
      const a = await as(ctx, viewer).get(`/api/v1/folders/${folderA}`).expect(200);
      expect(a.body.folder).toMatchObject({ access: 'view', accessItself: null });
      expect(a.body.accessItself).toBeNull();
      expect(a.body.folders.find((f: Named) => f.id === folderB)).toMatchObject({
        access: 'view',
        accessItself: 'view',
      });
      const e = await as(ctx, viewer).get(`/api/v1/folders/${folderE}`).expect(200);
      expect(e.body).toMatchObject({ access: 'edit', accessItself: null });
      expect(e.body.folders.find((f: Named) => f.id === folderE2)?.accessItself).toBe('edit');
      const tree = await as(ctx, viewer).get('/api/v1/folders/tree').expect(200);
      const e2 = (tree.body as Array<Named & { accessItself: string | null }>).find(
        (f) => f.id === folderE2,
      );
      expect(e2?.accessItself).toBe('edit');

      const root = await as(ctx, admin).get('/api/v1/folders/root').expect(200);
      expect(root.body.folder).toMatchObject({ access: 'edit', accessItself: null });
      const adminA = await as(ctx, admin).get(`/api/v1/folders/${folderA}`).expect(200);
      expect(adminA.body).toMatchObject({ access: 'edit', accessItself: 'edit' });
    });
  });

  describe('records (records.service.ts)', () => {
    it('tells the UI the level on the record’s folder, which a move needs (folderAccess)', async () => {
      const a = await as(ctx, viewer).get(`/api/v1/records/${rA}`).expect(200);
      expect(a.body).toMatchObject({ access: 'view', folderAccess: 'view' });
      const c = await as(ctx, viewer).get(`/api/v1/records/${rC}`).expect(200);
      expect(c.body).toMatchObject({ access: 'view', folderAccess: null });
      const e = await as(ctx, viewer).get(`/api/v1/records/${rE}`).expect(200);
      expect(e.body).toMatchObject({ access: 'edit', folderAccess: 'edit' });
      const adminView = await as(ctx, admin).get(`/api/v1/records/${rX}`).expect(200);
      expect(adminView.body).toMatchObject({ access: 'edit', folderAccess: 'edit' });
    });

    it('shows a record in a hidden folder without naming the folder, and hides the rest', async () => {
      const a = await as(ctx, viewer).get(`/api/v1/records/${rA}`).expect(200);
      expect(a.body.access).toBe('view');
      expect(a.body.record).toMatchObject({ folderId: folderA, folderName: 'A' });
      expect(a.body.breadcrumbs.map((c: Named) => c.name)).toEqual(['A']);

      const c = await as(ctx, viewer).get(`/api/v1/records/${rC}`).expect(200);
      expect(c.body.record).toMatchObject({ id: rC, folderId: null, folderName: null });
      expect(c.body.breadcrumbs).toEqual([]);
      expect(JSON.stringify(c.body)).not.toContain(folderC);

      const x = await answer(as(ctx, viewer).get(`/api/v1/records/${rX}`));
      expect(x.status).toBe(404);
      expect(x).toEqual(await answer(as(ctx, viewer).get(`/api/v1/records/${randomId()}`)));
    });

    it('lists, searches and exports only visible records, and 404s a hidden folder filter', async () => {
      const all = await as(ctx, viewer).get('/api/v1/records?pageSize=100').expect(200);
      const ids = (all.body.items as Named[]).map((r) => r.id);
      expect(ids).toEqual(expect.arrayContaining([rA, rB, rC, rE]));
      expect(ids).not.toContain(rX);
      expect(all.body.total).toBe(all.body.items.length);

      await as(ctx, viewer).get(`/api/v1/records?folderId=${folderC}`).expect(404);
      const inA = await as(ctx, viewer)
        .get(`/api/v1/records?folderId=${folderA}&includeSubfolders=true`)
        .expect(200);
      expect((inA.body.items as Named[]).map((r) => r.id).sort()).toEqual([rA, rB].sort());

      const secret = await as(ctx, viewer).get('/api/v1/records?q=secret').expect(200);
      expect(secret.body.total).toBe(0);
      const adminSecret = await as(ctx, admin).get('/api/v1/records?q=secret').expect(200);
      expect(adminSecret.body.total).toBe(1);

      const csv = await as(ctx, viewer).get('/api/v1/records/export').expect(200);
      expect(csv.text).toContain('Leak rA');
      expect(csv.text).not.toContain('Leak rX secret');
      await as(ctx, viewer).get(`/api/v1/records/export?folderId=${folderC}`).expect(404);
    });

    it('counts tags over visible records only', async () => {
      await as(ctx, admin)
        .put(`/api/v1/records/${rX}/tags`)
        .send({ tags: ['hidden-tag'] })
        .expect(200);
      const mine = await as(ctx, viewer).get('/api/v1/tags').expect(200);
      expect((mine.body as Array<{ tag: string }>).map((t) => t.tag)).not.toContain('hidden-tag');
      const all = await as(ctx, admin).get('/api/v1/tags').expect(200);
      expect((all.body as Array<{ tag: string }>).map((t) => t.tag)).toContain('hidden-tag');
    });

    it('refuses changes with View only (403, audited) and hides what is not visible (404)', async () => {
      const writes = (id: string) => [
        () => as(ctx, viewer).patch(`/api/v1/records/${id}`).send({ name: 'Changed' }),
        () =>
          as(ctx, viewer)
            .put(`/api/v1/records/${id}/tags`)
            .send({ tags: ['x'] }),
        () => as(ctx, viewer).post(`/api/v1/records/${id}/checkout`),
        () => as(ctx, viewer).post(`/api/v1/records/${id}/checkin`),
        () =>
          as(ctx, viewer)
            .post(`/api/v1/records/${id}/versions`)
            .send({ metadata: { supplier: 'Y', amount: 2 } }),
        () => as(ctx, viewer).post(`/api/v1/records/${id}/versions/1/restore`).send({}),
        () => as(ctx, viewer).delete(`/api/v1/records/${id}`),
      ];
      const before = await deniedCount(viewer, rA);
      for (const request of writes(rA)) expect((await request()).status).toBe(403);
      expect(await deniedCount(viewer, rA)).toBe(before + 7);
      for (const request of writes(rX)) expect((await request()).status).toBe(404);
      const unchanged = await as(ctx, admin).get(`/api/v1/records/${rA}`).expect(200);
      expect(unchanged.body.record).toMatchObject({
        name: 'Leak rA',
        currentVersion: 1,
        checkedOut: null,
      });
    });

    it('opens versions with View, and 404s them for a hidden record', async () => {
      await as(ctx, viewer).get(`/api/v1/records/${rA}/versions`).expect(200);
      await as(ctx, viewer).get(`/api/v1/records/${rA}/versions/1`).expect(200);
      await as(ctx, viewer).get(`/api/v1/records/${rX}/versions`).expect(404);
      await as(ctx, viewer).get(`/api/v1/records/${rX}/versions/1`).expect(404);
      const content = await as(ctx, viewer).get(`/api/v1/records/${rX}/content`).expect(404);
      expect(content.body.message).toBe('Record not found');
    });

    it('creates only with Edit on the folder', async () => {
      const body = (folderId: string) => ({
        name: 'Viewer upload',
        contentTypeId: ws.typeId,
        folderId,
        metadata: { supplier: 'V', amount: 1 },
      });
      await as(ctx, viewer).post('/api/v1/records').send(body(folderA)).expect(403);
      const hidden = await as(ctx, viewer).post('/api/v1/records').send(body(folderC)).expect(404);
      expect(hidden.body.message).toBe('Folder not found');
      const made = await as(ctx, viewer).post('/api/v1/records').send(body(folderE)).expect(201);
      expect(made.body.folderId).toBe(folderE);
    });

    it('moves only with Edit on the current folder and on the target', async () => {
      const r = await recordIn(folderE, 'Leak movable');
      await as(ctx, viewer)
        .post(`/api/v1/records/${r}/move`)
        .send({ folderId: folderA })
        .expect(403);
      const hidden = await as(ctx, viewer)
        .post(`/api/v1/records/${r}/move`)
        .send({ folderId: folderC })
        .expect(404);
      expect(hidden.body.message).toBe('Target folder not found');
      await as(ctx, viewer)
        .post(`/api/v1/records/${rC}/move`)
        .send({ folderId: folderE })
        .expect(403);
      const moved = await as(ctx, viewer)
        .post(`/api/v1/records/${r}/move`)
        .send({ folderId: folderE2 })
        .expect(200);
      expect(moved.body.folderId).toBe(folderE2);
    });

    it('lets a record grant with Edit change the record, but not move it out of its folder', async () => {
      const rG = await recordIn(folderC, 'Leak granted edit');
      await grant(viewer, 'record', rG, 'edit');
      await as(ctx, viewer)
        .patch(`/api/v1/records/${rG}`)
        .send({ name: 'Leak granted edit 2' })
        .expect(200);
      await as(ctx, viewer)
        .post(`/api/v1/records/${rG}/move`)
        .send({ folderId: folderE })
        .expect(403);
      expect(await folderOf(rG)).toBe(folderC);
    });
  });

  describe('record activity (record-activity.controller.ts)', () => {
    it('needs View, and drops hidden folder ids, hidden relation ends and email addresses', async () => {
      await as(ctx, viewer).get(`/api/v1/records/${rX}/activity`).expect(404);
      await as(ctx, admin)
        .post(`/api/v1/records/${rC}/relations`)
        .send({ kind: 'references', otherId: rX })
        .expect(201);
      const feed = await as(ctx, viewer).get(`/api/v1/records/${rC}/activity`).expect(200);
      type Entry = {
        action: string;
        actor: Record<string, unknown> | null;
        context: Record<string, unknown>;
      };
      const entries = feed.body.items as Entry[];
      const created = entries.find((e) => e.action === 'RECORD_CREATED');
      expect(created?.context).not.toHaveProperty('folderId');
      const related = entries.find((e) => e.action === 'RELATION_ADDED');
      expect(related?.context).toMatchObject({ kind: 'references' });
      expect(related?.context).not.toHaveProperty('otherId');
      expect(related?.context).not.toHaveProperty('otherName');
      expect(entries.every((e) => e.actor === null || !('email' in e.actor))).toBe(true);
      expect(JSON.stringify(feed.body)).not.toContain('Leak rX secret');

      const full = await as(ctx, admin).get(`/api/v1/records/${rC}/activity`).expect(200);
      const adminRelated = (full.body.items as Entry[]).find((e) => e.action === 'RELATION_ADDED');
      expect(adminRelated?.context).toMatchObject({ otherId: rX, otherName: 'Leak rX secret' });
      expect(
        (full.body.items as Entry[]).find((e) => e.action === 'RECORD_CREATED')?.context,
      ).toMatchObject({
        folderId: folderC,
      });
    });
  });

  describe('record state (record-state.ts): a move out of reach during a change', () => {
    let editor: Actor;

    beforeAll(async () => {
      editor = await addMember(ctx, admin);
      await grant(editor, 'folder', folderE, 'edit');
    });

    const moveToC = (recordId: string) =>
      as(ctx, admin)
        .post(`/api/v1/records/${recordId}/move`)
        .send({ folderId: folderC })
        .expect(200);

    it('refuses a rename with 404 and writes nothing', async () => {
      const id = await recordIn(folderE, 'Race rename');
      const types = ctx.app.get(ContentTypesService, { strict: false });
      const requireType = types.require.bind(types);
      const spy = vi.spyOn(types, 'require').mockImplementationOnce(async (...args) => {
        await moveToC(id);
        return requireType(...args);
      });
      try {
        await as(ctx, editor)
          .patch(`/api/v1/records/${id}`)
          .send({ name: 'Race renamed' })
          .expect(404);
        expect(spy).toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
      const now = await as(ctx, admin).get(`/api/v1/records/${id}`).expect(200);
      expect(now.body.record.name).toBe('Race rename');
    });

    it('refuses a retag with 404 and writes nothing', async () => {
      const id = await recordIn(folderE, 'Race retag');
      const types = ctx.app.get(ContentTypesService, { strict: false });
      const requireType = types.require.bind(types);
      const spy = vi.spyOn(types, 'require').mockImplementationOnce(async (...args) => {
        await moveToC(id);
        return requireType(...args);
      });
      try {
        await as(ctx, editor)
          .put(`/api/v1/records/${id}/tags`)
          .send({ tags: ['raced'] })
          .expect(404);
        expect(spy).toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
      const now = await as(ctx, admin).get(`/api/v1/records/${id}`).expect(200);
      expect(now.body.record.tags).toEqual([]);
    });

    it('refuses a new version with 404 and leaves no version row', async () => {
      const id = await recordIn(folderE, 'Race version');
      const versions = ctx.app.get(VersionsRepository, { strict: false });
      const latest = versions.latest.bind(versions);
      const spy = vi.spyOn(versions, 'latest').mockImplementationOnce(async (...args) => {
        await moveToC(id);
        return latest(...args);
      });
      try {
        await as(ctx, editor)
          .post(`/api/v1/records/${id}/versions`)
          .send({ metadata: { supplier: 'Raced', amount: 3 } })
          .expect(404);
        expect(spy).toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
      const history = await as(ctx, admin).get(`/api/v1/records/${id}/versions`).expect(200);
      expect(history.body).toHaveLength(1);
      expect(await versions.count(admin.tenantId, { recordId: new Types.ObjectId(id) })).toBe(1);
    });

    it('refuses a check-out with 404 and leaves the record free', async () => {
      const id = await recordIn(folderE, 'Race checkout');
      const records = ctx.app.get(RecordsRepository, { strict: false });
      const findById = records.findById.bind(records);
      const spy = vi.spyOn(records, 'findById').mockImplementationOnce(async (...args) => {
        const read = await findById(...args);
        await as(ctx, admin)
          .post(`/api/v1/records/${id}/move`)
          .send({ folderId: folderC })
          .expect(200);
        return read;
      });
      try {
        await as(ctx, editor).post(`/api/v1/records/${id}/checkout`).expect(404);
        expect(spy).toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
      const now = await as(ctx, admin).get(`/api/v1/records/${id}`).expect(200);
      expect(now.body.record.checkedOut).toBeNull();
    });
  });

  describe('accepted windows (documented, not prevented)', () => {
    let member: Actor;
    let parent: string;

    beforeAll(async () => {
      member = await addMember(ctx, admin);
      parent = await mkdir('Window parent', rootId);
      await grant(member, 'folder', parent, 'edit');
    });

    it('lets a rename land when an admin moves an ancestor folder out of reach mid-write', async () => {
      const inner = await mkdir('Window inner', parent);
      const id = await recordIn(inner, 'Window record');
      const types = ctx.app.get(ContentTypesService, { strict: false });
      const requireType = types.require.bind(types);
      const spy = vi.spyOn(types, 'require').mockImplementationOnce(async (...args) => {
        await as(ctx, admin)
          .post(`/api/v1/folders/${inner}/move`)
          .send({ parentId: folderC })
          .expect(200);
        return requireType(...args);
      });
      try {
        await as(ctx, member)
          .patch(`/api/v1/records/${id}`)
          .send({ name: 'Window renamed' })
          .expect(200);
        expect(spy).toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
      const now = await as(ctx, admin).get(`/api/v1/records/${id}`).expect(200);
      expect(now.body.record.name).toBe('Window renamed');
      await as(ctx, member).get(`/api/v1/records/${id}`).expect(404);
    });

    it('lets a member’s folder move use the access checked before the lease', async () => {
      const moving = await mkdir('Window moving', parent);
      const target = await mkdir('Window target', parent);
      const folders = ctx.app.get(FoldersRepository, { strict: false });
      const acquire = folders.acquireMoveLease.bind(folders);
      const spy = vi.spyOn(folders, 'acquireMoveLease').mockImplementationOnce(async (...args) => {
        await as(ctx, admin)
          .post(`/api/v1/folders/${target}/move`)
          .send({ parentId: folderC })
          .expect(200);
        return acquire(...args);
      });
      try {
        await as(ctx, member)
          .post(`/api/v1/folders/${moving}/move`)
          .send({ parentId: target })
          .expect(200);
        expect(spy).toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
      const moved = await as(ctx, admin).get(`/api/v1/folders/${moving}`).expect(200);
      expect(moved.body.folder.parentId).toBe(target);
      await as(ctx, member).get(`/api/v1/folders/${moving}`).expect(404);
    });
  });

  describe('fresh re-checks after an upload or a move (records.service.ts)', () => {
    const blobCount = (content: string) =>
      ctx.app
        .get<Connection>(getConnectionToken())
        .collection('blobs')
        .countDocuments({ sha256: createHash('sha256').update(content).digest('hex') });

    it('refuses a create whose grant was revoked during the upload, and sweeps the blob', async () => {
      const uploader = await addMember(ctx, admin);
      const given = await grant(uploader, 'folder', folderE, 'edit');
      const content = `revoked mid-ingest ${randomId()}`;
      const blobs = ctx.app.get(BlobsService, { strict: false });
      const ingest = blobs.ingest.bind(blobs);
      const spy = vi.spyOn(blobs, 'ingest').mockImplementationOnce(async (...args) => {
        const stored = await ingest(...args);
        await revoke(given.id);
        return stored;
      });
      try {
        await as(ctx, uploader)
          .post('/api/v1/records')
          .field('name', 'Revoked upload')
          .field('contentTypeId', ws.typeId)
          .field('folderId', folderE)
          .field('metadata', JSON.stringify({ supplier: 'R', amount: 1 }))
          .attach('file', Buffer.from(content), 'revoked.txt')
          .expect(404);
        expect(spy).toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
      const found = await as(ctx, admin).get('/api/v1/records?q=revoked upload').expect(200);
      expect(found.body.total).toBe(0);
      expect(await blobCount(content)).toBe(0);
    });

    it('refuses a new version whose grant was revoked during the upload, and sweeps the blob', async () => {
      const uploader = await addMember(ctx, admin);
      const given = await grant(uploader, 'folder', folderE, 'edit');
      const id = await recordIn(folderE, 'Revoked version');
      const content = `revoked version ${randomId()}`;
      const blobs = ctx.app.get(BlobsService, { strict: false });
      const ingest = blobs.ingest.bind(blobs);
      const spy = vi.spyOn(blobs, 'ingest').mockImplementationOnce(async (...args) => {
        const stored = await ingest(...args);
        await revoke(given.id);
        return stored;
      });
      try {
        await as(ctx, uploader)
          .post(`/api/v1/records/${id}/versions`)
          .attach('file', Buffer.from(content), 'late.txt')
          .expect(404);
        expect(spy).toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
      const history = await as(ctx, admin).get(`/api/v1/records/${id}/versions`).expect(200);
      expect(history.body).toHaveLength(1);
      expect(await blobCount(content)).toBe(0);
    });

    it('moves a record back when Edit on the target was revoked during the move', async () => {
      const mover = await addMember(ctx, admin);
      await grant(mover, 'folder', folderE, 'edit');
      const onTarget = await grant(mover, 'folder', folderC, 'edit');
      const id = await recordIn(folderE, 'Revoked move');
      const records = ctx.app.get(RecordsRepository, { strict: false });
      const updateOne = records.updateOne.bind(records);
      const spy = vi.spyOn(records, 'updateOne').mockImplementationOnce(async (...args) => {
        const moved = await updateOne(...args);
        await revoke(onTarget.id);
        return moved;
      });
      try {
        const res = await as(ctx, mover)
          .post(`/api/v1/records/${id}/move`)
          .send({ folderId: folderC })
          .expect(404);
        expect(res.body.message).toBe('Target folder not found');
        expect(spy).toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
      expect(await folderOf(id)).toBe(folderE);
    });
  });

  describe('trash (trash.service.ts)', () => {
    it('refuses trashing with View, and an entry point or a View folder itself', async () => {
      await as(ctx, viewer).delete(`/api/v1/records/${rA}`).expect(403);
      await as(ctx, viewer).delete(`/api/v1/folders/${folderB}`).expect(403);
      await as(ctx, viewer).delete(`/api/v1/folders/${folderA}`).expect(403);
      await as(ctx, viewer).delete(`/api/v1/folders/${folderC}`).expect(404);
      const sub = await as(ctx, viewer)
        .post('/api/v1/folders')
        .send({ name: 'Viewer bin', parentId: folderE })
        .expect(201);
      await as(ctx, viewer).delete(`/api/v1/folders/${sub.body.id}`).expect(204);
    });

    it('lists only what the member can Edit, and restores it', async () => {
      const inC = await recordIn(folderC, 'Trashed in C');
      const inE = await recordIn(folderE, 'Trashed in E');
      await as(ctx, admin).delete(`/api/v1/records/${inC}`).expect(204);
      await as(ctx, admin).delete(`/api/v1/records/${inE}`).expect(204);
      const trash = await as(ctx, viewer).get('/api/v1/trash').expect(200);
      const names = (trash.body.records as Named[]).map((r) => r.name);
      expect(names).toContain('Trashed in E');
      expect(names).not.toContain('Trashed in C');
      await as(ctx, viewer).post(`/api/v1/trash/records/${inC}/restore`).expect(404);
      await as(ctx, viewer).post(`/api/v1/trash/records/${inE}/restore`).expect(200);
    });

    it('refuses restoring a record into the root without root Edit (PARENT_IN_TRASH)', async () => {
      const doomed = await as(ctx, viewer)
        .post('/api/v1/folders')
        .send({ name: 'Doomed', parentId: folderE })
        .expect(201);
      const r = await recordIn(doomed.body.id as string, 'Orphan');
      await as(ctx, admin).delete(`/api/v1/records/${r}`).expect(204);
      await as(ctx, admin).delete(`/api/v1/folders/${doomed.body.id}`).expect(204);
      const res = await as(ctx, viewer).post(`/api/v1/trash/records/${r}/restore`).expect(409);
      expect(res.body.code).toBe('PARENT_IN_TRASH');
      const restored = await as(ctx, admin).post(`/api/v1/trash/records/${r}/restore`).expect(200);
      expect(restored.body.folderId).toBe(rootId);
    });

    it('deletes the grants on what a purge destroys, and counts them in its audit entry', async () => {
      const member = await addMember(ctx, admin);
      const r = await recordIn(folderC, 'Purged with grant');
      await grant(member, 'record', r, 'view');
      const folder = await mkdir('Purged folder', rootId);
      await grant(member, 'folder', folder, 'view');
      await as(ctx, admin).delete(`/api/v1/records/${r}`).expect(204);
      await as(ctx, admin).delete(`/api/v1/trash/records/${r}`).expect(200);
      await as(ctx, admin).delete(`/api/v1/folders/${folder}`).expect(204);
      await as(ctx, admin).delete(`/api/v1/trash/folders/${folder}`).expect(200);
      const left = await as(ctx, admin)
        .get(`/api/v1/access/grants?userId=${member.userId}`)
        .expect(200);
      expect(left.body).toEqual([]);
      const recordPurged = await as(ctx, admin)
        .get(`/api/v1/audit?action=RECORD_PURGED&resourceId=${r}`)
        .expect(200);
      expect(recordPurged.body.items[0].context).toMatchObject({ grantsRemoved: 1 });
      const folderPurged = await as(ctx, admin)
        .get(`/api/v1/audit?action=FOLDER_PURGED&resourceId=${folder}`)
        .expect(200);
      expect(folderPurged.body.items[0].context).toMatchObject({ grantsRemoved: 1 });
    });
  });

  describe('bulk (bulk.service.ts)', () => {
    it('refuses item by item: hidden record, then hidden target, then the level', async () => {
      const mine = await recordIn(folderE, 'Bulk mine');
      const before = await deniedCount(viewer, rA);
      const res = await as(ctx, viewer)
        .post('/api/v1/bulk/records/move')
        .send({ ids: [rX, rA, mine], folderId: folderE2 })
        .expect(200);
      expect(res.body.results).toEqual([
        { id: rX, ok: false, code: 'NOT_FOUND', message: 'Record not found' },
        { id: rA, ok: false, code: 'FORBIDDEN', message: expect.any(String) },
        { id: mine, ok: true },
      ]);
      expect(await deniedCount(viewer, rA)).toBe(before + 1);
      const hiddenTarget = await as(ctx, viewer)
        .post('/api/v1/bulk/records/move')
        .send({ ids: [mine], folderId: folderC })
        .expect(200);
      expect(hiddenTarget.body.results[0]).toMatchObject({
        ok: false,
        code: 'NOT_FOUND',
        message: 'Target folder not found',
      });
      const trash = await as(ctx, viewer)
        .post('/api/v1/bulk/records/trash')
        .send({ ids: [rX, rA] })
        .expect(200);
      expect(trash.body.results.map((r: { code: string }) => r.code)).toEqual([
        'NOT_FOUND',
        'FORBIDDEN',
      ]);
      const tags = await as(ctx, viewer)
        .post('/api/v1/bulk/records/tags')
        .send({ ids: [rX, rA], add: ['bulk'] })
        .expect(200);
      expect(tags.body.results.map((r: { code: string }) => r.code)).toEqual([
        'NOT_FOUND',
        'FORBIDDEN',
      ]);
    });
  });

  describe('comments (comments.service.ts)', () => {
    it('reads and adds with View, and hides a record’s comments behind its visibility', async () => {
      await as(ctx, viewer).get(`/api/v1/records/${rA}/comments`).expect(200);
      const mine = await as(ctx, viewer)
        .post(`/api/v1/records/${rA}/comments`)
        .send({ body: 'Seen with View' })
        .expect(201);
      await as(ctx, viewer).get(`/api/v1/records/${rX}/comments`).expect(404);
      await as(ctx, viewer).post(`/api/v1/records/${rX}/comments`).send({ body: 'no' }).expect(404);
      const theirs = await as(ctx, admin)
        .post(`/api/v1/records/${rX}/comments`)
        .send({ body: 'Hidden comment' })
        .expect(201);
      const hidden = await answer(
        as(ctx, viewer).delete(`/api/v1/records/${rX}/comments/${theirs.body.id}`),
      );
      expect(hidden.status).toBe(404);
      expect(hidden).toEqual(
        await answer(
          as(ctx, viewer).delete(`/api/v1/records/${randomId()}/comments/${randomId()}`),
        ),
      );
      await as(ctx, viewer).delete(`/api/v1/records/${rA}/comments/${mine.body.id}`).expect(204);
    });
  });

  describe('relations (relations.service.ts)', () => {
    it('lists and counts only visible ends, and needs Edit on the source end', async () => {
      await as(ctx, admin)
        .post(`/api/v1/records/${rA}/relations`)
        .send({ kind: 'references', otherId: rX })
        .expect(201);
      await as(ctx, admin)
        .post(`/api/v1/records/${rA}/relations`)
        .send({ kind: 'references', otherId: rB })
        .expect(201);
      const list = await as(ctx, viewer).get(`/api/v1/records/${rA}/relations`).expect(200);
      expect(list.body.total).toBe(1);
      expect(list.body.items.map((r: { other: { id: string } }) => r.other.id)).toEqual([rB]);

      await as(ctx, viewer)
        .post(`/api/v1/records/${rA}/relations`)
        .send({ kind: 'relatedTo', otherId: rB })
        .expect(403);
      const hidden = await as(ctx, viewer)
        .post(`/api/v1/records/${rE}/relations`)
        .send({ kind: 'relatedTo', otherId: rX })
        .expect(404);
      expect(hidden.body.message).toBe('Record not found');
      await as(ctx, viewer)
        .post(`/api/v1/records/${rE}/relations`)
        .send({ kind: 'supersedes', otherId: rA, direction: 'incoming' })
        .expect(403);
      const added = await as(ctx, viewer)
        .post(`/api/v1/records/${rE}/relations`)
        .send({ kind: 'partOf', otherId: rA })
        .expect(201);
      expect(added.body.other.folderPath.map((c: Named) => c.name)).toEqual(['A']);
      const rCSide = await as(ctx, admin)
        .post(`/api/v1/records/${rE}/relations`)
        .send({ kind: 'relatedTo', otherId: rC })
        .expect(201);
      const fromE = await as(ctx, viewer).get(`/api/v1/records/${rE}/relations`).expect(200);
      const toC = (
        fromE.body.items as Array<{
          id: string;
          other: { folderId: string | null; folderPath: unknown[] };
        }>
      ).find((r) => r.id === rCSide.body.id);
      expect(toC?.other).toMatchObject({ folderId: null, folderPath: [] });

      const toX = (
        await as(ctx, admin).get(`/api/v1/records/${rA}/relations`).expect(200)
      ).body.items.find((r: { other: { id: string } }) => r.other.id === rX);
      const removed = await as(ctx, viewer)
        .delete(`/api/v1/records/${rA}/relations/${toX.id}`)
        .expect(404);
      expect(removed.body.message).toBe('Relation not found');
    });
  });

  describe('my records (my-records.service.ts)', () => {
    it('needs View to favorite or open, hides lists after a revoke, and still removes one’s own favorite', async () => {
      await as(ctx, viewer).put(`/api/v1/records/${rX}/favorite`).expect(404);
      await as(ctx, viewer).get(`/api/v1/records/${rX}/favorite`).expect(404);
      await as(ctx, viewer).post(`/api/v1/records/${rX}/views`).expect(404);
      await as(ctx, viewer).delete(`/api/v1/records/${rX}/favorite`).expect(404);

      const revokee = await addMember(ctx, admin);
      const given = await grant(revokee, 'folder', folderA, 'view');
      await as(ctx, revokee).put(`/api/v1/records/${rA}/favorite`).expect(204);
      await as(ctx, revokee).post(`/api/v1/records/${rA}/views`).expect(204);
      expect((await as(ctx, revokee).get('/api/v1/me/favorites').expect(200)).body).toHaveLength(1);
      await revoke(given.id);
      expect((await as(ctx, revokee).get('/api/v1/me/favorites').expect(200)).body).toEqual([]);
      expect((await as(ctx, revokee).get('/api/v1/me/recent').expect(200)).body).toEqual([]);
      await as(ctx, revokee).delete(`/api/v1/records/${rA}/favorite`).expect(204);
      await as(ctx, revokee).delete(`/api/v1/records/${rA}/favorite`).expect(404);
    });
  });

  describe('saved searches (run through GET /records)', () => {
    it('keeps saved-search CRUD as it was; running one lists only visible records', async () => {
      await as(ctx, viewer)
        .post('/api/v1/saved-searches')
        .send({ name: 'Leaks', criteria: { q: 'leak' } })
        .expect(201);
      const run = await as(ctx, viewer).get('/api/v1/records?q=leak&pageSize=100').expect(200);
      expect((run.body.items as Named[]).map((r) => r.id)).not.toContain(rX);
    });
  });

  describe('notifications (notifications.service.ts)', () => {
    it('sends only to recipients who can View, and hides delivered ones after a revoke', async () => {
      const follower = await addMember(ctx, admin);
      const given = await grant(follower, 'folder', folderA, 'view');
      await as(ctx, follower).put(`/api/v1/records/${rA}/favorite`).expect(204);
      await as(ctx, admin)
        .post(`/api/v1/records/${rA}/comments`)
        .send({ body: 'While visible' })
        .expect(201);
      const inbox = await as(ctx, follower).get('/api/v1/notifications').expect(200);
      expect(inbox.body.items.map((n: { recordId: string }) => n.recordId)).toEqual([rA]);
      expect(inbox.body.unread).toBe(1);

      await revoke(given.id);
      const after = await as(ctx, follower).get('/api/v1/notifications').expect(200);
      expect(after.body).toEqual({ items: [], unread: 0 });
      expect(
        (await as(ctx, follower).get('/api/v1/notifications/unread-count').expect(200)).body,
      ).toEqual({ unread: 0 });
      await as(ctx, admin)
        .post(`/api/v1/records/${rA}/comments`)
        .send({ body: 'While hidden' })
        .expect(201);
      await grant(follower, 'folder', folderA, 'view');
      const back = await as(ctx, follower).get('/api/v1/notifications').expect(200);
      expect(back.body.items).toHaveLength(1);
    });

    it('tells a creator without View nothing, and a holder without View only that a check-out was released', async () => {
      const worker = await addMember(ctx, admin);
      const given = await grant(worker, 'folder', folderE, 'edit');
      const own = await recordIn(folderE, 'Worker record', worker);
      const held = await recordIn(folderE, 'Held by worker');
      await as(ctx, worker).post(`/api/v1/records/${held}/checkout`).expect(200);
      await revoke(given.id);
      await as(ctx, admin)
        .post(`/api/v1/records/${own}/comments`)
        .send({ body: 'You cannot see this' })
        .expect(201);
      await as(ctx, admin).post(`/api/v1/records/${held}/force-release`).expect(200);
      const inbox = await as(ctx, worker).get('/api/v1/notifications').expect(200);
      expect(inbox.body.items).toEqual([
        expect.objectContaining({
          kind: 'CHECKOUT_FORCE_RELEASED',
          title: 'An admin released your check-out',
          recordId: null,
        }),
      ]);
      expect(JSON.stringify(inbox.body)).not.toContain('Held by worker');
    });
  });

  describe('dashboard (dashboard.service.ts)', () => {
    it('counts what the member can see and leaves the tenant-wide figures to admins', async () => {
      const dash = await as(ctx, viewer).get('/api/v1/dashboard').expect(200);
      expect(dash.body.counts).toMatchObject({ versions: null, members: null, trashed: null });
      expect(dash.body.storage).toBeNull();
      const records = await as(ctx, viewer).get('/api/v1/records?pageSize=1').expect(200);
      expect(dash.body.counts.records).toBe(records.body.total);
      const tree = await as(ctx, viewer).get('/api/v1/folders/tree').expect(200);
      expect(dash.body.counts.folders).toBe(tree.body.length);
      expect(JSON.stringify(dash.body.recentRecords)).not.toContain('Leak rX secret');
      expect(
        dash.body.recentActivity.every(
          (e: { actor: object | null }) => e.actor === null || !('email' in e.actor),
        ),
      ).toBe(true);
      const adminDash = await as(ctx, admin).get('/api/v1/dashboard').expect(200);
      expect(typeof adminDash.body.counts.members).toBe('number');
      expect(adminDash.body.storage).not.toBeNull();
    });
  });

  describe('audit (policy)', () => {
    it('is admin-only', async () => {
      await as(ctx, viewer).get('/api/v1/audit').expect(403);
      await as(ctx, viewer).get('/api/v1/audit/actions').expect(403);
    });
  });

  describe('members (members.service.ts)', () => {
    it('keeps the directory for admins and gives everyone names only', async () => {
      await as(ctx, viewer).get('/api/v1/members').expect(403);
      const people = await as(ctx, viewer).get('/api/v1/people').expect(200);
      for (const person of people.body as object[]) {
        expect(Object.keys(person).sort()).toEqual(['displayName', 'id']);
      }
      expect((people.body as Array<{ id: string }>).map((p) => p.id)).toContain(admin.userId);
    });

    it('caps GET /people at PEOPLE_LIMIT, sorted by name', async () => {
      const users = ctx.app.get(UsersRepository, { strict: false });
      const spy = vi.spyOn(users, 'find');
      try {
        await as(ctx, viewer).get('/api/v1/people').expect(200);
        expect(spy).toHaveBeenCalledWith(
          admin.tenantId,
          { status: 'active' },
          { sort: { displayName: 1, _id: 1 }, limit: PEOPLE_LIMIT },
        );
      } finally {
        spy.mockRestore();
      }
      expect(PEOPLE_LIMIT).toBe(1000);
    });

    it('never shows another tenant’s people or grants (GET /people, GET /me/access)', async () => {
      const otherAdmin = await signUp(ctx, { tenantName: 'Other Leaks Co' });
      const otherMember = await addMember(ctx, otherAdmin);
      const otherWs = await workspace(ctx, otherAdmin, 'Other A');
      await grantAccess(ctx, otherAdmin, {
        userId: otherMember.userId,
        targetType: 'folder',
        targetId: otherWs.folderId,
        level: 'edit',
      });
      const people = await as(ctx, viewer).get('/api/v1/people').expect(200);
      const ids = (people.body as Array<{ id: string }>).map((p) => p.id);
      expect(ids).not.toContain(otherAdmin.userId);
      expect(ids).not.toContain(otherMember.userId);
      const theirPeople = await as(ctx, otherMember).get('/api/v1/people').expect(200);
      expect((theirPeople.body as Array<{ id: string }>).map((p) => p.id).sort()).toEqual(
        [otherAdmin.userId, otherMember.userId].sort(),
      );
      const mine = await as(ctx, viewer).get('/api/v1/me/access').expect(200);
      expect(JSON.stringify(mine.body)).not.toContain(otherWs.folderId);
      const theirs = await as(ctx, otherMember).get('/api/v1/me/access').expect(200);
      expect(theirs.body).toEqual({
        unrestricted: false,
        entryPoints: [{ type: 'folder', id: otherWs.folderId, name: 'Other A', level: 'edit' }],
      });
      await as(ctx, otherMember).get(`/api/v1/folders/${folderA}`).expect(404);
    });

    it('deletes a removed member’s grants and counts them', async () => {
      const leaver = await addMember(ctx, admin);
      await grant(leaver, 'folder', folderA, 'view');
      await grant(leaver, 'record', rC, 'edit');
      await as(ctx, admin).delete(`/api/v1/members/${leaver.userId}`).expect(204);
      const entry = await as(ctx, admin)
        .get(`/api/v1/audit?action=MEMBER_REMOVED&resourceId=${leaver.userId}`)
        .expect(200);
      expect(entry.body.items[0].context).toMatchObject({ grantsRemoved: 2 });
      const grants = ctx.app.get<Connection>(getConnectionToken()).collection('access_grants');
      expect(await grants.countDocuments({ userId: new Types.ObjectId(leaver.userId) })).toBe(0);
    });

    it('deletes grants given while the removal ran (cleared after the status write)', async () => {
      const leaver = await addMember(ctx, admin);
      const users = ctx.app.get(UsersRepository, { strict: false });
      const updateOne = users.updateOne.bind(users);
      const spy = vi.spyOn(users, 'updateOne').mockImplementationOnce(async (...args) => {
        await grant(leaver, 'folder', folderA, 'view');
        return updateOne(...args);
      });
      try {
        await as(ctx, admin).delete(`/api/v1/members/${leaver.userId}`).expect(204);
        expect(spy).toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
      const grants = ctx.app.get<Connection>(getConnectionToken()).collection('access_grants');
      expect(await grants.countDocuments({ userId: new Types.ObjectId(leaver.userId) })).toBe(0);
    });

    it('keeps a grant given once a rejoining member is active again (cleared before)', async () => {
      const rejoiner = await addMember(ctx, admin);
      await grant(rejoiner, 'folder', folderA, 'view');
      await as(ctx, admin).delete(`/api/v1/members/${rejoiner.userId}`).expect(204);
      const invited = await as(ctx, admin)
        .post('/api/v1/invitations')
        .send({ email: rejoiner.email, role: 'member' })
        .expect(201);
      const sessions = ctx.app.get(SessionsService, { strict: false });
      const cutOff = sessions.cutOff.bind(sessions);
      let fresh: { id: string } | null = null;
      const spy = vi.spyOn(sessions, 'cutOff').mockImplementationOnce(async (...args) => {
        const result = await cutOff(...args);
        fresh = await grant(rejoiner, 'folder', folderE, 'view');
        return result;
      });
      try {
        await agentFor(ctx)
          .post('/api/v1/invitations/accept')
          .send({
            token: new URL(invited.body.acceptUrl as string).searchParams.get('token'),
            displayName: 'Rejoiner',
            password: DEFAULT_PASSWORD,
          })
          .expect(201);
        expect(spy).toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
      const grants = await as(ctx, admin)
        .get(`/api/v1/access/grants?userId=${rejoiner.userId}`)
        .expect(200);
      expect(
        (grants.body as Array<{ id: string; targetId: string }>).map((g) => g.targetId),
      ).toEqual([folderE]);
      expect(fresh).not.toBeNull();
    });

    it('keeps a grant given after a concurrent rejoin won, when the losing rejoin clears', async () => {
      const rejoiner = await addMember(ctx, admin);
      await as(ctx, admin).delete(`/api/v1/members/${rejoiner.userId}`).expect(204);
      const invite = async () =>
        (
          await as(ctx, admin)
            .post('/api/v1/invitations')
            .send({ email: rejoiner.email, role: 'member' })
            .expect(201)
        ).body.acceptUrl as string;
      const accept = (acceptUrl: string, displayName: string) =>
        agentFor(ctx)
          .post('/api/v1/invitations/accept')
          .send({
            token: new URL(acceptUrl).searchParams.get('token'),
            displayName,
            password: DEFAULT_PASSWORD,
          });
      const losing = await invite();
      const access = ctx.app.get(AccessService);
      const clearForUser = access.clearForUser.bind(access);
      let winner = 0;
      const spy = vi.spyOn(access, 'clearForUser').mockImplementationOnce(async (...args) => {
        winner = (await accept(await invite(), 'Winner')).status;
        await grant(rejoiner, 'folder', folderE, 'view');
        return clearForUser(...args);
      });
      let loser: { status: number };
      try {
        loser = await accept(losing, 'Loser');
        expect(spy).toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
      expect(winner).toBe(201);
      expect(loser.status).toBe(409);
      const grants = await as(ctx, admin)
        .get(`/api/v1/access/grants?userId=${rejoiner.userId}`)
        .expect(200);
      expect((grants.body as Array<{ targetId: string }>).map((g) => g.targetId)).toEqual([
        folderE,
      ]);
    });

    it('clears, at start-up, grants left to members removed before removal deleted them', async () => {
      const gone = await addMember(ctx, admin);
      await grant(gone, 'folder', folderA, 'view');
      await ctx.app
        .get<Connection>(getConnectionToken())
        .collection('users')
        .updateOne({ _id: new Types.ObjectId(gone.userId) }, { $set: { status: 'removed' } });
      await ctx.app.get(AccessService).onApplicationBootstrap();
      const grants = ctx.app.get<Connection>(getConnectionToken()).collection('access_grants');
      expect(await grants.countDocuments({ userId: new Types.ObjectId(gone.userId) })).toBe(0);
    });
  });

  describe('API reference (route-docs.ts) and GET /me/access', () => {
    it('classifies every route by scope', () => {
      for (const [key, doc] of Object.entries(ROUTE_DOCS)) {
        expect(ROUTE_SCOPES, key).toContain(doc.scope);
      }
    });

    it('lists where the member’s access starts, names only', async () => {
      const mine = await as(ctx, viewer).get('/api/v1/me/access').expect(200);
      expect(mine.body.unrestricted).toBe(false);
      expect(mine.body.entryPoints).toEqual(
        expect.arrayContaining([
          { type: 'folder', id: folderA, name: 'A', level: 'view' },
          { type: 'folder', id: folderE, name: 'E', level: 'edit' },
          { type: 'record', id: rC, name: 'Leak rC', level: 'view' },
        ]),
      );
      const ids = (mine.body.entryPoints as Named[]).map((p) => p.id);
      expect(ids).not.toContain(folderB);
      expect((await as(ctx, stranger).get('/api/v1/me/access').expect(200)).body).toEqual({
        unrestricted: false,
        entryPoints: [],
      });
      expect((await as(ctx, admin).get('/api/v1/me/access').expect(200)).body).toEqual({
        unrestricted: true,
        entryPoints: [],
      });
    });
  });

  describe('AccessService.viewersOf', () => {
    it('agrees with scopeForUser().levelOfRecord for live records', async () => {
      const access = ctx.app.get(AccessService);
      const records = ctx.app.get(RecordsRepository, { strict: false });
      const hiddenFolder = await mkdir('Parity hidden', rootId);
      const granted = await mkdir('Parity granted', rootId);
      const middle = await mkdir('Parity middle', granted);
      const deep = await mkdir('Parity deep', middle);
      const inRoot = await recordIn(rootId, 'Parity in root');
      const inGranted = await recordIn(granted, 'Parity in granted');
      const recordOnly = await recordIn(hiddenFolder, 'Parity record only');
      const inDeep = await recordIn(deep, 'Parity in deep');
      await as(ctx, admin).delete(`/api/v1/folders/${middle}`).expect(204);

      const folderMember = await addMember(ctx, admin);
      await grant(folderMember, 'folder', granted, 'view');
      const recordMember = await addMember(ctx, admin);
      await grant(recordMember, 'record', recordOnly, 'view');
      const suspended = await addMember(ctx, admin);
      await grant(suspended, 'folder', granted, 'edit');
      await as(ctx, admin).post(`/api/v1/members/${suspended.userId}/suspend`).expect(200);
      const promoted = await addMember(ctx, admin);
      await grant(promoted, 'folder', hiddenFolder, 'view');
      await as(ctx, admin)
        .patch(`/api/v1/members/${promoted.userId}`)
        .send({ role: 'admin' })
        .expect(200);
      const nobody = await addMember(ctx, admin);
      const users = [admin, folderMember, recordMember, suspended, promoted, nobody, stranger];

      for (const recordId of [inRoot, inGranted, recordOnly, inDeep]) {
        const viewers = await access.viewersOf(
          admin.tenantId,
          recordId,
          users.map((u) => u.userId),
        );
        const record = await records.findById(admin.tenantId, recordId);
        for (const user of users) {
          const scope = await access.scopeForUser(admin.tenantId, user.userId);
          const expected =
            record !== null && record.deletedAt === null && scope.levelOfRecord(record) !== null;
          expect(viewers.has(user.userId), `${user.email} on ${record?.name}`).toBe(expected);
        }
      }
      expect(
        await access.viewersOf(admin.tenantId, inGranted, [folderMember.userId, suspended.userId]),
      ).toEqual(new Set([folderMember.userId]));
      expect(
        await access.viewersOf(admin.tenantId, recordOnly, [recordMember.userId, promoted.userId]),
      ).toEqual(new Set([recordMember.userId, promoted.userId]));
      expect(
        (
          await access.viewersOf(
            admin.tenantId,
            inDeep,
            users.map((u) => u.userId),
          )
        ).size,
      ).toBe(0);
    });
  });
});

describe('access canaries over the demo tenant (e2e)', () => {
  let ctx: TestApp;
  let admin: Actor;
  let zero: Actor;
  let viewAll: Actor;
  let seeded: Ids & { type: string };
  let forbiddenIds: string[];
  let forbiddenNames: string[];

  beforeAll(async () => {
    ctx = await createTestApp([SeedModule]);
    await ctx.app.get(SeedService).run();
    admin = await signIn(ctx, DEMO_ADMIN.email, DEMO_PASSWORD);
    const db = ctx.app.get<Connection>(getConnectionToken());
    const tenant = { tenantId: new Types.ObjectId(admin.tenantId) };
    const hr = await db.collection('folders').findOne({ ...tenant, name: 'HR' });
    await as(ctx, admin).delete(`/api/v1/folders/${hr?._id.toHexString()}`).expect(204);

    const all = async (name: string) => db.collection(name).find(tenant).toArray();
    const folders = await all('folders');
    const records = await all('records');
    const comments = await all('record_comments');
    const relations = await all('record_relations');
    const byName = (rows: Array<Record<string, unknown>>, name: string) =>
      (rows.find((r) => r.name === name) as unknown as { _id: Types.ObjectId })._id.toHexString();
    const msa = byName(records, 'Master services agreement — Wayne Enterprises');
    seeded = {
      record: msa,
      other: byName(records, 'NDA — Stark Industries'),
      trashedRecord: byName(records, 'Globex invoice INV-2026-001 (duplicate upload)'),
      folder: byName(folders, 'Contracts'),
      otherFolder: byName(folders, 'Finance'),
      trashedFolder: byName(folders, 'HR'),
      comment: (
        comments.find((c) => c.recordId.equals(msa)) as { _id: Types.ObjectId }
      )._id.toHexString(),
      relation: (relations[0] as { _id: Types.ObjectId })._id.toHexString(),
      savedSearch: ((await all('saved_searches'))[0] as { _id: Types.ObjectId })._id.toHexString(),
      notification: ((await all('notifications'))[0] as { _id: Types.ObjectId })._id.toHexString(),
      type: ((await all('content_types'))[0] as { _id: Types.ObjectId })._id.toHexString(),
      shareLink: '',
    };
    const link = await as(ctx, admin)
      .post(`/api/v1/records/${msa}/share-links`)
      .send({ expiresAt: inADay() })
      .expect(201);
    seeded.shareLink = link.body.id as string;
    zero = await addMember(ctx, admin);
    viewAll = await addMember(ctx, admin);
    await grantAccess(ctx, admin, {
      userId: viewAll.userId,
      targetType: 'folder',
      targetId: byName(folders, 'Repository'),
      level: 'view',
    });

    const typesText = JSON.stringify(
      (await as(ctx, zero).get('/api/v1/content-types').expect(200)).body,
    );
    const secret = (value: unknown): value is string =>
      typeof value === 'string' && value.length >= 5 && !typesText.includes(value);
    forbiddenIds = [
      ...folders.map((f) => (f._id as Types.ObjectId).toHexString()),
      ...records.map((r) => (r._id as Types.ObjectId).toHexString()),
      ...comments.map((c) => (c._id as Types.ObjectId).toHexString()),
      ...relations.map((r) => (r._id as Types.ObjectId).toHexString()),
      seeded.savedSearch,
      seeded.notification,
    ];
    const others = (await all('users')).filter(
      (u) => !(u._id as Types.ObjectId).equals(zero.userId) && u.displayName !== zero.displayName,
    );
    forbiddenNames = [
      ...folders.map((f) => f.name),
      ...records.map((r) => r.name),
      ...records.map((r) => (r.file as { fileName?: string } | null)?.fileName),
      ...records.flatMap((r) => (r.tags as string[] | undefined) ?? []),
      ...comments.map((c) => c.body),
      ...others.map((u) => u.displayName),
      ...others.map((u) => u.email),
    ].filter(secret);
  });

  afterAll(async () => {
    await ctx.stop();
  });

  function pathOf(key: string, ids: Ids) {
    const [, path] = key.split(' ');
    const idFor = (): string => {
      if (path.startsWith('/records') || path.startsWith('/trash/records')) return ids.record;
      if (path.startsWith('/folders') || path.startsWith('/trash/folders')) return ids.folder;
      if (path.startsWith('/saved-searches')) return ids.savedSearch;
      if (path.startsWith('/notifications')) return ids.notification;
      if (path.startsWith('/share-links')) return ids.shareLink;
      if (path.startsWith('/content-types')) return seeded.type;
      return admin.userId;
    };
    return `/api/v1${path
      .replace('{id}', idFor())
      .replace('{number}', '1')
      .replace('{commentId}', ids.comment)
      .replace('{relationId}', ids.relation)
      .replace('{sid}', randomId())}`;
  }

  it('canary 1: a member without grants finds no seeded id or name in any GET', async () => {
    const ids = { ...seeded };
    const urls = Object.keys(ROUTE_DOCS)
      .filter(
        (key) =>
          key.startsWith('GET ') &&
          !['GET /people', 'GET /openapi.json', 'GET /reference'].includes(key) &&
          ROUTE_DOCS[key].produces !== 'text/event-stream',
      )
      .map((key) => pathOf(key, ids));
    urls.push(
      `/api/v1/records?folderId=${seeded.folder}`,
      `/api/v1/records?folderId=${seeded.folder}&includeSubfolders=true`,
      '/api/v1/records?q=wayne',
      `/api/v1/records/export?folderId=${seeded.folder}`,
    );
    expect(urls.length).toBeGreaterThan(40);
    for (const url of urls) {
      const res = await as(ctx, zero).get(url).timeout({ response: 5000, deadline: 10000 });
      const text = res.text ?? JSON.stringify(res.body);
      for (const id of forbiddenIds) expect(text.includes(id), `${url} names ${id}`).toBe(false);
      for (const name of forbiddenNames)
        expect(text.includes(name), `${url} names "${name}"`).toBe(false);
    }
    for (const route of ['/api/v1/records', '/api/v1/records/export']) {
      const answerFor = async (folderId: string) => {
        const res = await as(ctx, zero).get(`${route}?folderId=${folderId}`);
        return { status: res.status, body: stripped(res.body) };
      };
      const hidden = await answerFor(seeded.folder);
      expect(hidden.status, route).toBe(404);
      expect(JSON.stringify(hidden), route).toBe(JSON.stringify(await answerFor(randomId())));
    }
  });

  const BODIES: Record<string, (ids: Ids) => { path?: Partial<Ids>; body?: object }> = {
    'POST /folders': (ids) => ({ body: { name: 'Canary', parentId: ids.folder } }),
    'PATCH /folders/{id}': () => ({ body: { name: 'Canary' } }),
    'POST /folders/{id}/move': (ids) => ({ body: { parentId: ids.otherFolder } }),
    'DELETE /folders/{id}': () => ({}),
    'POST /records': (ids) => ({
      body: { name: 'Canary', contentTypeId: seeded.type, folderId: ids.folder, metadata: {} },
    }),
    'PATCH /records/{id}': () => ({ body: { name: 'Canary' } }),
    'PUT /records/{id}/tags': () => ({ body: { tags: ['canary'] } }),
    'POST /records/{id}/move': (ids) => ({ body: { folderId: ids.otherFolder } }),
    'POST /records/{id}/versions': () => ({ body: { metadata: {} } }),
    'POST /records/{id}/versions/{number}/restore': () => ({ body: {} }),
    'POST /records/{id}/checkout': () => ({}),
    'POST /records/{id}/checkin': () => ({}),
    'POST /records/{id}/force-release': () => ({}),
    'DELETE /records/{id}': () => ({}),
    'POST /records/{id}/comments': () => ({ body: { body: 'Canary' } }),
    'DELETE /records/{id}/comments/{commentId}': () => ({}),
    'POST /records/{id}/relations': (ids) => ({ body: { kind: 'relatedTo', otherId: ids.other } }),
    'DELETE /records/{id}/relations/{relationId}': () => ({}),
    'PUT /records/{id}/favorite': () => ({}),
    'DELETE /records/{id}/favorite': () => ({}),
    'POST /records/{id}/views': () => ({}),
    'POST /bulk/records/move': (ids) => ({
      body: { ids: [ids.record], folderId: ids.otherFolder },
    }),
    'POST /bulk/records/trash': (ids) => ({ body: { ids: [ids.record] } }),
    'POST /bulk/records/tags': (ids) => ({ body: { ids: [ids.record], add: ['canary'] } }),
    'POST /trash/records/{id}/restore': (ids) => ({ path: { record: ids.trashedRecord } }),
    'POST /trash/folders/{id}/restore': (ids) => ({ path: { folder: ids.trashedFolder } }),
    'DELETE /trash/records/{id}': (ids) => ({ path: { record: ids.trashedRecord } }),
    'DELETE /trash/folders/{id}': (ids) => ({ path: { folder: ids.trashedFolder } }),
    'DELETE /trash': () => ({}),
    'DELETE /saved-searches/{id}': () => ({}),
    'POST /notifications/{id}/read': () => ({}),
    'POST /records/{id}/share-links': () => ({ body: { expiresAt: inADay() } }),
    'DELETE /share-links/{id}': () => ({}),
  };
  const VIEW_LEVEL = new Set([
    'POST /records/{id}/comments',
    'PUT /records/{id}/favorite',
    'DELETE /records/{id}/favorite',
    'POST /records/{id}/views',
  ]);

  const changingRoutes = () =>
    Object.entries(ROUTE_DOCS)
      .filter(
        ([key, doc]) =>
          !key.startsWith('GET ') && ['record', 'folder', 'records'].includes(doc.scope),
      )
      .map(([key]) => key)
      .concat(['DELETE /saved-searches/{id}', 'POST /notifications/{id}/read']);

  async function call(actor: Actor, key: string, ids: Ids) {
    const planned = BODIES[key](ids);
    const url = pathOf(key, { ...ids, ...planned.path });
    const [method] = key.split(' ');
    const client = as(ctx, actor);
    const request =
      method === 'POST'
        ? client.post(url)
        : method === 'PUT'
          ? client.put(url)
          : method === 'PATCH'
            ? client.patch(url)
            : client.delete(url);
    const res = await (planned.body ? request.send(planned.body) : request).timeout({
      response: 5000,
      deadline: 10000,
    });
    const body = stripped(res.body) as { results?: Array<{ id: string }> };
    if (body && Array.isArray(body.results)) {
      body.results = body.results.map((result) => {
        const copy: Record<string, unknown> = { ...result };
        delete copy.id;
        return copy;
      }) as typeof body.results;
    }
    return { status: res.status, body };
  }

  it('canary 2: a member without grants gets byte-identical answers for seeded and nonexistent ids', async () => {
    const seededSet: Ids = {
      record: seeded.record,
      other: seeded.other,
      trashedRecord: seeded.trashedRecord,
      folder: seeded.folder,
      otherFolder: seeded.otherFolder,
      trashedFolder: seeded.trashedFolder,
      comment: seeded.comment,
      relation: seeded.relation,
      savedSearch: seeded.savedSearch,
      notification: seeded.notification,
      shareLink: seeded.shareLink,
    };
    const randomSet = Object.fromEntries(
      Object.keys(seededSet).map((k) => [k, randomId()]),
    ) as unknown as Ids;
    const routes = changingRoutes();
    expect(routes.filter((key) => !BODIES[key])).toEqual([]);
    for (const key of routes) {
      const hidden = await call(zero, key, seededSet);
      const missing = await call(zero, key, randomSet);
      expect(hidden, key).toEqual(missing);
      expect([200, 403, 404], key).toContain(hidden.status);
    }
  });

  it('canary 2: a member with View on everything is refused (403) every change needing Edit', async () => {
    const ids: Ids = {
      record: seeded.record,
      other: seeded.other,
      trashedRecord: seeded.trashedRecord,
      folder: seeded.folder,
      otherFolder: seeded.otherFolder,
      trashedFolder: seeded.trashedFolder,
      comment: seeded.comment,
      relation: seeded.relation,
      savedSearch: seeded.savedSearch,
      notification: seeded.notification,
      shareLink: seeded.shareLink,
    };
    const routes = changingRoutes().filter(
      (key) => !VIEW_LEVEL.has(key) && ROUTE_DOCS[key].scope !== 'personal',
    );
    for (const key of routes) {
      const res = await call(viewAll, key, ids);
      if (key.startsWith('POST /bulk/')) {
        expect(res.status, key).toBe(200);
        expect(
          res.body.results?.map((r) => (r as { code?: string }).code),
          key,
        ).toEqual(['FORBIDDEN']);
      } else {
        expect(res.status, key).toBe(403);
      }
    }
    const msa = await as(ctx, admin).get(`/api/v1/records/${seeded.record}`).expect(200);
    expect(msa.body.record.name).toBe('Master services agreement — Wayne Enterprises');
  });
});
