import { getModelToken } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import { ShareLink } from '../src/shares/share-link.schema.js';
import { ShareLinksRepository } from '../src/shares/share-links.repository.js';
import { ShareLinksService } from '../src/shares/share-links.service.js';
import { PolicyService } from '../src/authorization/policy.service.js';
import { errors } from '../src/common/errors.js';
import { RecordEntity } from '../src/records/record.schema.js';
import { addMember, as, signUp, type Actor } from './helpers/actors.js';
import { createRecord, workspace, type Workspace } from './helpers/fixtures.js';
import { createTestApp, type TestApp } from './helpers/test-app.js';

const DAY = 24 * 60 * 60 * 1000;
const in7Days = () => new Date(Date.now() + 7 * DAY).toISOString();

const VIEW_KEYS = [
  'accessCount',
  'createdAt',
  'expiresAt',
  'hasPassword',
  'id',
  'lastAccessedAt',
  'recordId',
  'revokeReason',
  'revokedAt',
  'revokedBy',
  'sharedBy',
  'status',
].sort();

const byText = (x: string, y: string) => x.localeCompare(y);
const linksOf = (recordId: string) => `/api/v1/records/${recordId}/share-links`;

describe('share links (e2e)', () => {
  let ctx: TestApp;
  let admin: Actor;
  let editor: Actor;
  let viewer: Actor;
  let outsider: Actor;
  let ws: Workspace;
  let model: Model<ShareLink>;
  let repository: ShareLinksRepository;

  beforeAll(async () => {
    ctx = await createTestApp();
    admin = await signUp(ctx, { tenantName: 'Sharing Co' });
    ws = await workspace(ctx, admin, 'Contracts');
    editor = await addMember(ctx, admin);
    viewer = await addMember(ctx, admin);
    outsider = await addMember(ctx, admin);
    await grant(editor, ws.folderId, 'edit');
    await grant(viewer, ws.folderId, 'view');
    model = ctx.app.get<Model<ShareLink>>(getModelToken(ShareLink.name));
    repository = ctx.app.get(ShareLinksRepository);
  });

  afterAll(async () => {
    await ctx.stop();
  });

  async function grant(member: Actor, folderId: string, level: 'view' | 'edit') {
    await as(ctx, admin)
      .put('/api/v1/access/grants')
      .send({ userId: member.userId, targetType: 'folder', targetId: folderId, level })
      .expect(200);
  }

  async function fileRecord(name = 'Contract.pdf', target: Workspace = ws, by: Actor = admin) {
    const { id } = await createRecord(ctx, by, target, {
      name,
      file: { content: `content of ${name}`, name: `${name}.txt` },
    });
    return id;
  }

  async function auditOf(action: string, resourceId: string, reader: Actor = admin) {
    const res = await as(ctx, reader)
      .get(`/api/v1/audit?action=${action}&resourceId=${resourceId}&pageSize=100`)
      .expect(200);
    return res.body.items as Array<{
      actor: { id: string } | null;
      resource: { type: string; id: string; label?: string };
      context: Record<string, unknown>;
    }>;
  }

  const countFor = (recordId: string) =>
    model.countDocuments({ recordId: new Types.ObjectId(recordId) }).exec();

  const create = (actor: Actor, recordId: string, body: object = { expiresAt: in7Days() }) =>
    as(ctx, actor).post(linksOf(recordId)).send(body);

  describe('POST /records/:id/share-links', () => {
    it('lets an Edit member create a link: the url once, the view, one audit entry', async () => {
      const recordId = await fileRecord('Lease');
      const expiresAt = in7Days();
      const res = await create(editor, recordId, { expiresAt }).expect(201);

      expect(Object.keys(res.body).sort()).toEqual([...VIEW_KEYS, 'url'].sort());
      expect(res.body).toMatchObject({
        recordId,
        status: 'active',
        expiresAt,
        hasPassword: false,
        sharedBy: { id: editor.userId, displayName: editor.displayName },
        accessCount: 0,
        lastAccessedAt: null,
        revokedAt: null,
        revokedBy: null,
        revokeReason: null,
      });
      expect(res.body.url).toMatch(/^http:\/\/localhost:4300\/s#[A-Za-z0-9_-]{43}$/);
      const token = (res.body.url as string).split('#')[1];

      const stored = await model.findById(res.body.id).lean().exec();
      expect(stored?.tokenHash).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(stored)).not.toContain(token);

      const entries = await auditOf('SHARE_LINK_CREATED', recordId);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        actor: { id: editor.userId },
        resource: { type: 'record', id: recordId, label: 'Lease' },
      });
      expect(entries[0].context).toEqual({
        linkId: res.body.id,
        expiresAt,
        protected: false,
      });
      expect(JSON.stringify(entries)).not.toContain(token);
    });

    it('lets an admin create a password link; the password is stored only as a bcrypt hash', async () => {
      const recordId = await fileRecord('Board minutes');
      const password = 'correct horse battery';
      const res = await create(admin, recordId, { expiresAt: in7Days(), password }).expect(201);
      expect(res.body.hasPassword).toBe(true);
      expect(JSON.stringify(res.body)).not.toContain(password);
      const stored = await model.findById(res.body.id).lean().exec();
      expect(stored?.passwordHash).toMatch(/^\$2[aby]\$/);
      const [entry] = await auditOf('SHARE_LINK_CREATED', recordId);
      expect(entry.context).toMatchObject({ protected: true });
      expect(JSON.stringify(entry)).not.toContain(password);
    });

    it('refuses a View-only member with 403 and an ACCESS_DENIED entry', async () => {
      const recordId = await fileRecord('View only');
      const res = await create(viewer, recordId).expect(403);
      expect(res.body.code).toBe('FORBIDDEN');
      const denied = await auditOf('ACCESS_DENIED', recordId);
      expect(denied.map((e) => e.actor?.id)).toEqual([viewer.userId]);
      expect(await auditOf('SHARE_LINK_CREATED', recordId)).toEqual([]);
      expect(await countFor(recordId)).toBe(0);
    });

    it('answers 404 without an audit entry for a member without a grant', async () => {
      const recordId = await fileRecord('Hidden');
      const res = await create(outsider, recordId).expect(404);
      expect(res.body.code).toBe('NOT_FOUND');
      expect(await auditOf('ACCESS_DENIED', recordId)).toEqual([]);
      expect(await auditOf('SHARE_LINK_CREATED', recordId)).toEqual([]);
    });

    it('answers 404 for a trashed record, a malformed id and an unknown id', async () => {
      const recordId = await fileRecord('Trashed');
      await as(ctx, admin).delete(`/api/v1/records/${recordId}`).expect(204);
      await create(admin, recordId).expect(404);
      await create(editor, recordId).expect(404);
      await create(admin, 'not-an-id').expect(404);
      await create(admin, '0123456789abcdef01234567').expect(404);
      expect(await countFor(recordId)).toBe(0);
    });

    it('checks the record before the policy action, so an admin-only switch still hides records', async () => {
      const policy = ctx.app.get(PolicyService);
      const authorize = policy.authorize.bind(policy);
      const spy = vi
        .spyOn(policy, 'authorize')
        .mockImplementation(async (principal, action, resource) => {
          if (action === 'shareLinks.create' && principal.role !== 'admin') {
            throw errors.forbidden();
          }
          await authorize(principal, action, resource);
        });
      try {
        const hidden = await fileRecord('Switch hidden');
        const visible = await fileRecord('Switch visible');
        for (const request of [
          () => create(outsider, hidden),
          () => as(ctx, outsider).get(linksOf(hidden)),
        ]) {
          const res = await request().expect(404);
          expect(res.body.code).toBe('NOT_FOUND');
        }
        const foreign = await create(outsider, '0123456789abcdef01234567').expect(404);
        expect(foreign.body.code).toBe('NOT_FOUND');
        for (const request of [
          () => create(editor, visible),
          () => as(ctx, editor).get(linksOf(visible)),
        ]) {
          const res = await request().expect(403);
          expect(res.body.code).toBe('FORBIDDEN');
        }
        expect(spy).toHaveBeenCalledWith(
          expect.objectContaining({ userId: editor.userId }),
          'shareLinks.create',
          { type: 'record', id: visible, label: 'Switch visible' },
        );
        expect(spy).not.toHaveBeenCalledWith(
          expect.objectContaining({ userId: outsider.userId }),
          'shareLinks.create',
          expect.anything(),
        );
        await create(admin, visible).expect(201);
      } finally {
        spy.mockRestore();
      }
    });

    it('works while someone else has the record checked out (not a write to the record)', async () => {
      const recordId = await fileRecord('Checked out');
      await as(ctx, admin).post(`/api/v1/records/${recordId}/checkout`).expect(200);
      await create(editor, recordId).expect(201);
    });

    it('answers 409 RECORD_HAS_NO_FILE for a record without a file', async () => {
      const { id } = await createRecord(ctx, admin, ws, { name: 'No file' });
      const res = await create(editor, id).expect(409);
      expect(res.body.code).toBe('RECORD_HAS_NO_FILE');
    });

    it('refuses an expiry in the past or more than 90 days away', async () => {
      const recordId = await fileRecord('Expiry');
      for (const expiresAt of [
        new Date(Date.now() - 60_000).toISOString(),
        new Date(Date.now() + 91 * DAY).toISOString(),
      ]) {
        const res = await create(editor, recordId, { expiresAt }).expect(400);
        expect(res.body.code).toBe('SHARE_LINK_EXPIRY_INVALID');
      }
      await create(editor, recordId, {
        expiresAt: new Date(Date.now() + 90 * DAY).toISOString(),
      }).expect(201);
    });

    it('validates the body strictly', async () => {
      const recordId = await fileRecord('Validation');
      for (const body of [
        {},
        { expiresAt: 'tomorrow' },
        { expiresAt: in7Days(), password: 'short77' },
        { expiresAt: in7Days(), password: 'x'.repeat(129) },
        { expiresAt: in7Days(), password: 'é'.repeat(36) + 'a' },
        { expiresAt: in7Days(), password: '' },
        { expiresAt: in7Days(), recordId },
      ]) {
        const res = await create(editor, recordId, body).expect(400);
        expect(res.body.code).toBe('VALIDATION_FAILED');
      }
      await create(editor, recordId, { expiresAt: in7Days(), password: 'é'.repeat(36) }).expect(
        201,
      );
      await create(editor, recordId, { expiresAt: in7Days(), password: 'p'.repeat(8) }).expect(201);
    });

    it('caps a record at 20 active links (409 TOO_MANY_SHARE_LINKS); revoked and expired do not count', async () => {
      const recordId = await fileRecord('Popular');
      const old = await create(admin, recordId).expect(201);
      await model.updateOne({ _id: old.body.id }, { expiresAt: new Date(Date.now() - 1) }).exec();
      const revoked = await create(admin, recordId).expect(201);
      await as(ctx, admin).delete(`/api/v1/share-links/${revoked.body.id}`).expect(204);
      for (let i = 0; i < 20; i += 1) await create(editor, recordId).expect(201);
      const res = await create(editor, recordId).expect(409);
      expect(res.body.code).toBe('TOO_MANY_SHARE_LINKS');
      expect(await countFor(recordId)).toBe(22);
      expect(await auditOf('SHARE_LINK_CREATED', recordId)).toHaveLength(22);
    });
  });

  describe('create races', () => {
    it('keeps the cap when a create lands inside the cap check of another (19 active)', async () => {
      const recordId = await fileRecord('Race cap');
      for (let i = 0; i < 19; i += 1) await create(editor, recordId).expect(201);
      const firstActiveIds = repository.firstActiveIds.bind(repository);
      let inner: number | undefined;
      const spy = vi.spyOn(repository, 'firstActiveIds').mockImplementationOnce(async (...args) => {
        inner = (await create(editor, recordId)).status;
        return firstActiveIds(...args);
      });
      try {
        const outer = await create(admin, recordId);
        expect(spy).toHaveBeenCalled();
        expect([outer.status, inner ?? 0].sort((x, y) => x - y)).toEqual([201, 409]);
      } finally {
        spy.mockRestore();
      }
      const active = await countFor(recordId);
      expect(active).toBeLessThanOrEqual(20);
      expect(await auditOf('SHARE_LINK_CREATED', recordId)).toHaveLength(active);
    });

    it('never lets parallel creates past the cap (5 at once from 18 active)', async () => {
      const recordId = await fileRecord('Race parallel');
      for (let i = 0; i < 18; i += 1) await create(editor, recordId).expect(201);
      const results = await Promise.all(Array.from({ length: 5 }, () => create(editor, recordId)));
      for (const res of results) expect([201, 409]).toContain(res.status);
      for (const refused of results.filter((r) => r.status === 409)) {
        expect(refused.body.code).toBe('TOO_MANY_SHARE_LINKS');
      }
      const created = results.filter((r) => r.status === 201).length;
      expect(created).toBeGreaterThanOrEqual(0);
      expect(created).toBeLessThanOrEqual(2);
      const active = await countFor(recordId);
      expect(active).toBe(18 + created);
      expect(active).toBeLessThanOrEqual(20);
    });

    it('deletes the new link when the sharer is suspended during the create', async () => {
      const sharer = await addMember(ctx, admin);
      await grant(sharer, ws.folderId, 'edit');
      const recordId = await fileRecord('Race suspend');
      const insert = repository.create.bind(repository);
      const spy = vi.spyOn(repository, 'create').mockImplementationOnce(async (...args) => {
        const link = await insert(...args);
        await as(ctx, admin).post(`/api/v1/members/${sharer.userId}/suspend`).expect(200);
        return link;
      });
      try {
        const res = await create(sharer, recordId).expect(401);
        expect(spy).toHaveBeenCalled();
        expect(res.body.url).toBeUndefined();
      } finally {
        spy.mockRestore();
      }
      expect(await countFor(recordId)).toBe(0);
      expect(await auditOf('SHARE_LINK_CREATED', recordId)).toEqual([]);
    });
  });

  describe('GET /records/:id/share-links', () => {
    it('lists every link of the record newest first, without secrets, paginated', async () => {
      const recordId = await fileRecord('Listed');
      const first = await create(editor, recordId, {
        expiresAt: in7Days(),
        password: 'a long password',
      }).expect(201);
      const second = await create(admin, recordId).expect(201);
      const third = await create(editor, recordId).expect(201);
      await as(ctx, admin).delete(`/api/v1/share-links/${second.body.id}`).expect(204);
      await model.updateOne({ _id: third.body.id }, { expiresAt: new Date(Date.now() - 1) }).exec();

      const res = await as(ctx, editor).get(linksOf(recordId)).expect(200);
      expect(res.body).toMatchObject({ total: 3, page: 1, pageSize: 20 });
      expect(res.body.items.map((l: { id: string }) => l.id)).toEqual([
        third.body.id,
        second.body.id,
        first.body.id,
      ]);
      expect(res.body.items.map((l: { status: string }) => l.status)).toEqual([
        'expired',
        'revoked',
        'active',
      ]);
      for (const item of res.body.items) expect(Object.keys(item).sort()).toEqual(VIEW_KEYS);
      expect(res.body.items[1]).toMatchObject({
        revokedBy: { id: admin.userId, displayName: admin.displayName },
        revokeReason: 'REVOKED',
      });
      expect(res.body.items[2].hasPassword).toBe(true);

      const text = JSON.stringify(res.body);
      for (const created of [first, second, third]) {
        expect(text).not.toContain((created.body.url as string).split('#')[1]);
      }
      expect(text).not.toMatch(/tokenHash|passwordHash|proofs|failedCount|lockedUntil|@/);

      const page2 = await as(ctx, admin)
        .get(`${linksOf(recordId)}?page=2&pageSize=2`)
        .expect(200);
      expect(page2.body).toMatchObject({ total: 3, page: 2, pageSize: 2 });
      expect(page2.body.items.map((l: { id: string }) => l.id)).toEqual([first.body.id]);
    });

    it('needs Edit: View-only 403 with ACCESS_DENIED, no grant 404, bad query 400', async () => {
      const recordId = await fileRecord('Listed access');
      await create(editor, recordId).expect(201);
      const res = await as(ctx, viewer).get(linksOf(recordId)).expect(403);
      expect(res.body.code).toBe('FORBIDDEN');
      expect((await auditOf('ACCESS_DENIED', recordId)).map((e) => e.actor?.id)).toEqual([
        viewer.userId,
      ]);
      await as(ctx, outsider).get(linksOf(recordId)).expect(404);
      expect(await auditOf('ACCESS_DENIED', recordId)).toHaveLength(1);
      const bad = await as(ctx, editor)
        .get(`${linksOf(recordId)}?status=all`)
        .expect(400);
      expect(bad.body.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('DELETE /share-links/:id', () => {
    const revoke = (actor: Actor, id: string) => as(ctx, actor).delete(`/api/v1/share-links/${id}`);

    it('lets the sharer revoke their own link, and audits it', async () => {
      const recordId = await fileRecord('Revoke own');
      const link = await create(editor, recordId).expect(201);
      await revoke(editor, link.body.id).expect(204);
      const [view] = (await as(ctx, editor).get(linksOf(recordId)).expect(200)).body.items;
      expect(view).toMatchObject({
        status: 'revoked',
        revokedBy: { id: editor.userId, displayName: editor.displayName },
        revokeReason: 'REVOKED',
      });
      const entries = await auditOf('SHARE_LINK_REVOKED', recordId);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        actor: { id: editor.userId },
        resource: { type: 'record', id: recordId, label: 'Revoke own' },
      });
      expect(entries[0].context).toEqual({ linkId: link.body.id, reason: 'REVOKED' });
    });

    it('refuses a colleague who can View with 403 and hides the link from one who cannot', async () => {
      const recordId = await fileRecord('Revoke colleague');
      const link = await create(editor, recordId).expect(201);
      const res = await revoke(viewer, link.body.id).expect(403);
      expect(res.body.code).toBe('FORBIDDEN');
      const denied = await auditOf('ACCESS_DENIED', recordId);
      expect(denied.map((e) => e.actor?.id)).toEqual([viewer.userId]);
      expect(denied[0].context).toMatchObject({ attemptedAction: 'shareLinks.manageAll' });

      const hidden = await revoke(outsider, link.body.id).expect(404);
      expect(hidden.body.message).toBe('Share link not found');
      expect(await auditOf('ACCESS_DENIED', recordId)).toHaveLength(1);
      expect(await auditOf('SHARE_LINK_REVOKED', recordId)).toEqual([]);
    });

    it('hides a colleague’s link on a trashed record from a View member (404, no audit)', async () => {
      const recordId = await fileRecord('Revoke trashed');
      const link = await create(editor, recordId).expect(201);
      await as(ctx, admin).delete(`/api/v1/records/${recordId}`).expect(204);
      const res = await revoke(viewer, link.body.id).expect(404);
      expect(res.body.message).toBe('Share link not found');
      expect(await auditOf('ACCESS_DENIED', recordId)).toEqual([]);
      await revoke(editor, link.body.id).expect(204);
      expect(await auditOf('SHARE_LINK_REVOKED', recordId)).toHaveLength(1);
    });

    it('lets an admin revoke any link, also on a trashed record, as the actor', async () => {
      const recordId = await fileRecord('Revoke admin');
      const link = await create(editor, recordId).expect(201);
      await as(ctx, admin).delete(`/api/v1/records/${recordId}`).expect(204);
      await revoke(admin, link.body.id).expect(204);
      const [entry] = await auditOf('SHARE_LINK_REVOKED', recordId);
      expect(entry.actor?.id).toBe(admin.userId);
      const stored = await model.findById(link.body.id).lean().exec();
      expect(stored).toMatchObject({ revokedByName: admin.displayName, revokeReason: 'REVOKED' });
      expect(stored?.revokedBy?.toHexString()).toBe(admin.userId);
    });

    it('answers 409 SHARE_LINK_NOT_ACTIVE for a revoked or expired link', async () => {
      const recordId = await fileRecord('Revoke inactive');
      const revoked = await create(editor, recordId).expect(201);
      await revoke(editor, revoked.body.id).expect(204);
      const again = await revoke(editor, revoked.body.id).expect(409);
      expect(again.body.code).toBe('SHARE_LINK_NOT_ACTIVE');
      const expired = await create(editor, recordId).expect(201);
      await model
        .updateOne({ _id: expired.body.id }, { expiresAt: new Date(Date.now() - 1) })
        .exec();
      const res = await revoke(admin, expired.body.id).expect(409);
      expect(res.body.code).toBe('SHARE_LINK_NOT_ACTIVE');
      expect(await auditOf('SHARE_LINK_REVOKED', recordId)).toHaveLength(1);
    });

    it('lets the sharer revoke after losing View on the record', async () => {
      const sharer = await addMember(ctx, admin);
      const recordId = await fileRecord('Revoke after losing view');
      const granted = await as(ctx, admin)
        .put('/api/v1/access/grants')
        .send({ userId: sharer.userId, targetType: 'record', targetId: recordId, level: 'edit' })
        .expect(200);
      const link = await create(sharer, recordId).expect(201);
      await as(ctx, admin).delete(`/api/v1/access/grants/${granted.body.id}`).expect(200);
      await create(sharer, recordId).expect(404);
      await revoke(sharer, link.body.id).expect(204);
    });

    it('answers 404 for malformed and unknown ids', async () => {
      await revoke(admin, 'nope').expect(404);
      await revoke(editor, '0123456789abcdef01234567').expect(404);
    });

    it('revokes once when two revokes race', async () => {
      const recordId = await fileRecord('Revoke race');
      const link = await create(editor, recordId).expect(201);
      const results = await Promise.all([
        revoke(editor, link.body.id),
        revoke(admin, link.body.id),
      ]);
      expect(results.map((r) => r.status).sort((x, y) => x - y)).toEqual([204, 409]);
      expect(await auditOf('SHARE_LINK_REVOKED', recordId)).toHaveLength(1);
    });

    it('guards the write: a revoke landing after the read makes the first one 409', async () => {
      const recordId = await fileRecord('Revoke race spy');
      const link = await create(editor, recordId).expect(201);
      const findById = repository.findById.bind(repository);
      const spy = vi.spyOn(repository, 'findById').mockImplementationOnce(async (...args) => {
        const found = await findById(...args);
        await revoke(admin, link.body.id).expect(204);
        return found;
      });
      try {
        const res = await revoke(editor, link.body.id).expect(409);
        expect(spy).toHaveBeenCalled();
        expect(res.body.code).toBe('SHARE_LINK_NOT_ACTIVE');
      } finally {
        spy.mockRestore();
      }
      const entries = await auditOf('SHARE_LINK_REVOKED', recordId);
      expect(entries.map((e) => e.actor?.id)).toEqual([admin.userId]);
    });
  });

  describe('GET /share-links (admin)', () => {
    let listAdmin: Actor;
    let listMember: Actor;
    let ids: { active: string; revoked: string; expired: string; trashed: string };

    beforeAll(async () => {
      listAdmin = await signUp(ctx, { tenantName: 'List Co' });
      listMember = await addMember(ctx, listAdmin);
      const listWs = await workspace(ctx, listAdmin, 'Shared');
      const recordId = await fileRecord('Policy.pdf', listWs, listAdmin);
      const trashedId = await fileRecord('Old policy.pdf', listWs, listAdmin);
      const make = async (id: string) =>
        (await create(listAdmin, id).expect(201)).body.id as string;
      ids = {
        expired: await make(recordId),
        revoked: await make(recordId),
        trashed: await make(trashedId),
        active: await make(recordId),
      };
      await model.updateOne({ _id: ids.expired }, { expiresAt: new Date(Date.now() - 1) }).exec();
      await as(ctx, listAdmin).delete(`/api/v1/share-links/${ids.revoked}`).expect(204);
      await as(ctx, listAdmin).delete(`/api/v1/records/${trashedId}`).expect(204);
    });

    it('lists the active links by default, newest first, with their record', async () => {
      const res = await as(ctx, listAdmin).get('/api/v1/share-links').expect(200);
      expect(res.body).toMatchObject({ total: 2, page: 1, pageSize: 20 });
      expect(res.body.items.map((l: { id: string }) => l.id)).toEqual([ids.active, ids.trashed]);
      for (const item of res.body.items) {
        expect(Object.keys(item).sort()).toEqual([...VIEW_KEYS, 'record'].sort());
      }
      expect(res.body.items[0].record).toEqual({
        id: res.body.items[0].recordId,
        name: 'Policy.pdf',
        trashed: false,
      });
      expect(res.body.items[1].record).toMatchObject({ name: 'Old policy.pdf', trashed: true });
      expect(JSON.stringify(res.body)).not.toMatch(/tokenHash|passwordHash|proofs|@/);
    });

    it('lists every status with status=all, paginated', async () => {
      const all = await as(ctx, listAdmin).get('/api/v1/share-links?status=all').expect(200);
      expect(all.body.total).toBe(4);
      expect(all.body.items.map((l: { id: string }) => l.id)).toEqual([
        ids.active,
        ids.trashed,
        ids.revoked,
        ids.expired,
      ]);
      const page = await as(ctx, listAdmin)
        .get('/api/v1/share-links?status=all&page=2&pageSize=3')
        .expect(200);
      expect(page.body).toMatchObject({ total: 4, page: 2, pageSize: 3 });
      expect(page.body.items.map((l: { id: string }) => l.id)).toEqual([ids.expired]);
    });

    it('shows a record that no longer exists as null', async () => {
      const records = ctx.app.get<Model<RecordEntity>>(getModelToken(RecordEntity.name));
      const orphan = await fileRecord(
        'Gone.pdf',
        await workspace(ctx, listAdmin, 'Gone'),
        listAdmin,
      );
      const link = await create(listAdmin, orphan).expect(201);
      await records.deleteOne({ _id: new Types.ObjectId(orphan) }).exec();
      const res = await as(ctx, listAdmin).get('/api/v1/share-links').expect(200);
      const item = res.body.items.find((l: { id: string }) => l.id === link.body.id);
      expect(item.record).toBeNull();
      await model.deleteOne({ _id: link.body.id }).exec();
    });

    it('refuses a member with 403 and ACCESS_DENIED, and a bad status with 400', async () => {
      const res = await as(ctx, listMember).get('/api/v1/share-links').expect(403);
      expect(res.body.code).toBe('FORBIDDEN');
      const denied = await as(ctx, listAdmin)
        .get(`/api/v1/audit?action=ACCESS_DENIED&actorId=${listMember.userId}`)
        .expect(200);
      expect(denied.body.items[0].context).toMatchObject({
        attemptedAction: 'shareLinks.manageAll',
      });
      const bad = await as(ctx, listAdmin).get('/api/v1/share-links?status=revoked').expect(400);
      expect(bad.body.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('cross-tenant', () => {
    it('hides every link and record of another tenant, and audits nothing in either', async () => {
      const recordId = await fileRecord('Tenant A only');
      const link = await create(editor, recordId).expect(201);
      const otherAdmin = await signUp(ctx, { tenantName: 'Other Co' });
      const otherMember = await addMember(ctx, otherAdmin);
      const auditTotal = async (actor: Actor) =>
        (await as(ctx, actor).get('/api/v1/audit?pageSize=1').expect(200)).body.total as number;
      const beforeA = await auditTotal(admin);
      const beforeB = await auditTotal(otherAdmin);

      for (const actor of [otherAdmin, otherMember]) {
        await create(actor, recordId).expect(404);
        await as(ctx, actor).get(linksOf(recordId)).expect(404);
        const res = await as(ctx, actor).delete(`/api/v1/share-links/${link.body.id}`).expect(404);
        expect(res.body.message).toBe('Share link not found');
      }
      const list = await as(ctx, otherAdmin).get('/api/v1/share-links?status=all').expect(200);
      expect(list.body).toMatchObject({ total: 0, items: [] });

      expect(await auditTotal(admin)).toBe(beforeA);
      expect(await auditTotal(otherAdmin)).toBe(beforeB);
      const [still] = (await as(ctx, editor).get(linksOf(recordId)).expect(200)).body.items;
      expect(still).toMatchObject({ id: link.body.id, status: 'active' });

      const theirs = await fileRecord(
        'Tenant B only',
        await workspace(ctx, otherAdmin, 'B'),
        otherAdmin,
      );
      const bLink = await create(otherAdmin, theirs).expect(201);
      const aList = await as(ctx, admin).get('/api/v1/share-links?status=all&pageSize=100');
      expect(aList.body.items.map((l: { id: string }) => l.id)).not.toContain(bLink.body.id);
    });
  });

  describe('housekeeping', () => {
    it('revokeAllForUser revokes a sharer’s active links with SHARER_REMOVED, one entry each', async () => {
      const service = ctx.app.get(ShareLinksService);
      const sharer = await addMember(ctx, admin);
      await grant(sharer, ws.folderId, 'edit');
      const recordId = await fileRecord('Removal');
      const a = await create(sharer, recordId).expect(201);
      const b = await create(sharer, recordId).expect(201);
      const own = await create(sharer, recordId).expect(201);
      await as(ctx, sharer).delete(`/api/v1/share-links/${own.body.id}`).expect(204);
      const kept = await create(editor, recordId).expect(201);

      const by = { id: admin.userId, email: admin.email, displayName: admin.displayName };
      expect(await service.revokeAllForUser(admin.tenantId, sharer.userId, by)).toBe(2);
      const items = (await as(ctx, admin).get(linksOf(recordId)).expect(200)).body.items as Array<{
        id: string;
        status: string;
        revokeReason: string | null;
        revokedBy: { id: string } | null;
      }>;
      const byId = new Map(items.map((i) => [i.id, i]));
      for (const id of [a.body.id, b.body.id]) {
        expect(byId.get(id)).toMatchObject({
          status: 'revoked',
          revokeReason: 'SHARER_REMOVED',
          revokedBy: { id: admin.userId },
        });
      }
      expect(byId.get(own.body.id)?.revokeReason).toBe('REVOKED');
      expect(byId.get(kept.body.id)?.status).toBe('active');
      const removed = (await auditOf('SHARE_LINK_REVOKED', recordId)).filter(
        (e) => e.context.reason === 'SHARER_REMOVED',
      );
      expect(removed.map((e) => String(e.context.linkId)).sort(byText)).toEqual(
        [a.body.id as string, b.body.id as string].sort(byText),
      );
      expect(removed.every((e) => e.actor?.id === admin.userId)).toBe(true);

      expect(await service.revokeAllForUser(admin.tenantId, sharer.userId, null)).toBe(0);
      const other = await signUp(ctx, { tenantName: 'Housekeeping Co' });
      expect(await service.revokeAllForUser(other.tenantId, editor.userId, null)).toBe(0);
      expect(await service.revokeAllForUser(admin.tenantId, 'bad', null)).toBe(0);
      expect(byId.get(kept.body.id)?.status).toBe('active');
    });

    it('revokeAllForUser with no actor records a null actor', async () => {
      const service = ctx.app.get(ShareLinksService);
      const sharer = await addMember(ctx, admin);
      await grant(sharer, ws.folderId, 'edit');
      const recordId = await fileRecord('Rejoin');
      await create(sharer, recordId).expect(201);
      expect(await service.revokeAllForUser(admin.tenantId, sharer.userId, null)).toBe(1);
      const [entry] = await auditOf('SHARE_LINK_REVOKED', recordId);
      expect(entry.actor).toBeNull();
      const stored = await model
        .findOne({ recordId: new Types.ObjectId(recordId) })
        .lean()
        .exec();
      expect(stored).toMatchObject({ revokedBy: null, revokedByName: null });
    });

    it('purgeForRecords deletes only the given records’ links in the given tenant', async () => {
      const service = ctx.app.get(ShareLinksService);
      const doomed = await fileRecord('Purged');
      const kept = await fileRecord('Not purged');
      await create(editor, doomed).expect(201);
      await create(admin, doomed).expect(201);
      await create(editor, kept).expect(201);
      const other = await signUp(ctx, { tenantName: 'Purge Co' });
      expect(await service.purgeForRecords(other.tenantId, [doomed])).toBe(0);
      expect(
        await service.purgeForRecords(admin.tenantId, [new Types.ObjectId(doomed), 'bad']),
      ).toBe(2);
      expect(await service.purgeForRecords(admin.tenantId, [])).toBe(0);
      expect(await countFor(doomed)).toBe(0);
      expect(await countFor(kept)).toBe(1);
    });
  });
});

describe('share link create rate limit (e2e)', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await createTestApp([], { AUTH_RATE_LIMIT: '3' });
  });

  afterAll(async () => {
    await ctx.stop();
  });

  it('answers 429 RATE_LIMITED once the auth budget is used up, and creates nothing', async () => {
    const admin = await signUp(ctx, { tenantName: 'Throttled Co' });
    const ws = await workspace(ctx, admin, 'Throttled');
    const { id } = await createRecord(ctx, admin, ws, {
      name: 'Throttled.pdf',
      file: { content: 'throttled', name: 'throttled.txt' },
    });
    const create = () => as(ctx, admin).post(linksOf(id)).send({ expiresAt: in7Days() });
    for (let i = 0; i < 3; i += 1) await create().expect(201);
    const blocked = await create().expect(429);
    expect(blocked.body.code).toBe('RATE_LIMITED');
    const model = ctx.app.get<Model<ShareLink>>(getModelToken(ShareLink.name));
    expect(await model.countDocuments({ recordId: new Types.ObjectId(id) }).exec()).toBe(3);
  });
});
