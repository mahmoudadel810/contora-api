import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getConnectionToken } from '@nestjs/mongoose';
import { Types, type Connection } from 'mongoose';
import { addMember, as, signUp, type Actor } from './helpers/actors.js';
import { createRecord, workspace, type Workspace, grantRootEdit } from './helpers/fixtures.js';
import { ContentTypesService } from '../src/content-types/content-types.service.js';
import { FoldersRepository } from '../src/folders/folders.repository.js';
import { AccessService } from '../src/access/access.service.js';
import { RecordState } from '../src/records/record-state.js';
import { BlobsService, SWEEP_LIMIT } from '../src/storage/blobs.service.js';
import { createTestApp, type TestApp } from './helpers/test-app.js';

async function blobFiles(tenantId: string): Promise<string[]> {
  const dir = join(process.env.STORAGE_DIR as string, 'blobs', tenantId);
  const shards = await readdir(dir).catch(() => [] as string[]);
  const files = await Promise.all(
    shards.map((s) => readdir(join(dir, s)).catch(() => [] as string[])),
  );
  return files.flat();
}

describe('records and versions (e2e)', () => {
  let ctx: TestApp;
  let admin: Actor;
  let member: Actor;
  let other: Actor;
  let ws: Workspace;

  beforeAll(async () => {
    ctx = await createTestApp();
    admin = await signUp(ctx, { tenantName: 'Records Co' });
    member = await addMember(ctx, admin);
    await grantRootEdit(ctx, admin, member);
    other = await signUp(ctx, { tenantName: 'Other Co' });
    ws = await workspace(ctx, admin);
  });

  afterAll(async () => {
    await ctx.stop();
  });

  describe('create and read', () => {
    it('creates a record with validated metadata, defaults, a file and version 1', async () => {
      const created = await createRecord(ctx, member, ws, {
        metadata: { supplier: '  Acme ', amount: 120.5 },
        file: { content: 'invoice body', name: '../../scan.txt' },
      });
      expect(created.body).toMatchObject({
        name: 'Invoice 42',
        contentTypeId: ws.typeId,
        folderId: ws.folderId,
        folderName: 'Invoices',
        currentVersion: 1,
        schemaVersion: 1,
        metadata: { supplier: 'Acme', amount: 120.5, status: 'Open' },
        file: { fileName: 'scan.txt', size: 12, mimeType: 'text/plain' },
        checkedOut: null,
        createdBy: { id: member.userId, displayName: member.displayName },
      });
      const detail = await as(ctx, admin).get(`/api/v1/records/${created.id}`).expect(200);
      expect(detail.body.contentType.id).toBe(ws.typeId);
      expect(detail.body.breadcrumbs.map((c: { name: string }) => c.name)).toEqual([
        'Repository',
        'Invoices',
      ]);
      const content = await as(ctx, admin).get(`/api/v1/records/${created.id}/content`).expect(200);
      expect(content.text).toBe('invoice body');
      expect(content.headers['content-disposition']).toContain(
        "attachment; filename*=UTF-8''scan.txt",
      );
      expect(content.headers['x-content-type-options']).toBe('nosniff');
    });

    it('serves only safe types inline, and always sandboxed', async () => {
      const text = await createRecord(ctx, admin, ws, {
        file: { content: 'plain', name: 'note.txt' },
      });
      const html = await createRecord(ctx, admin, ws, {
        file: { content: '<script>alert(1)</script>', name: 'page.html', type: 'text/html' },
      });
      const inline = await as(ctx, admin)
        .get(`/api/v1/records/${text.id}/content?disposition=inline`)
        .expect(200);
      expect(inline.headers['content-disposition']).toMatch(/^inline;/);
      expect(inline.headers['content-security-policy']).toBe("sandbox; default-src 'none'");
      const forced = await as(ctx, admin)
        .get(`/api/v1/records/${html.id}/content?disposition=inline`)
        .expect(200);
      expect(forced.headers['content-disposition']).toMatch(/^attachment;/);
      expect(forced.headers['content-security-policy']).toBe("sandbox; default-src 'none'");
      expect(forced.headers['x-content-type-options']).toBe('nosniff');
    });

    it('creates a metadata-only record through JSON too', async () => {
      const res = await as(ctx, admin)
        .post('/api/v1/records')
        .send({
          name: 'No file',
          contentTypeId: ws.typeId,
          folderId: ws.folderId,
          metadata: { supplier: 'X', amount: 1 },
        })
        .expect(201);
      expect(res.body.file).toBeNull();
      await as(ctx, admin).get(`/api/v1/records/${res.body.id}/content`).expect(404);
    });

    it('rejects invalid metadata with metadata-prefixed paths and stores nothing', async () => {
      const before = (
        await as(ctx, admin).get(`/api/v1/records?folderId=${ws.folderId}`).expect(200)
      ).body.total;
      const res = await as(ctx, admin)
        .post('/api/v1/records')
        .field('name', 'Bad')
        .field('contentTypeId', ws.typeId)
        .field('folderId', ws.folderId)
        .field('metadata', JSON.stringify({ amount: -5, status: 'Lost', bogus: 1 }))
        .attach('file', Buffer.from('x'), 'x.txt')
        .expect(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
      const paths = (res.body.details as Array<{ path: string }>).map((d) => d.path);
      expect(paths).toEqual(
        expect.arrayContaining([
          'metadata.supplier',
          'metadata.amount',
          'metadata.status',
          'metadata.bogus',
        ]),
      );
      const after = (
        await as(ctx, admin).get(`/api/v1/records?folderId=${ws.folderId}`).expect(200)
      ).body.total;
      expect(after).toBe(before);
      expect(await readdir(join(process.env.STORAGE_DIR as string, 'tmp'))).toEqual([]);
    });

    it('rejects malformed metadata JSON, unknown types and folders, and archived types', async () => {
      const malformed = await as(ctx, admin)
        .post('/api/v1/records')
        .field('name', 'Bad')
        .field('contentTypeId', ws.typeId)
        .field('folderId', ws.folderId)
        .field('metadata', '{not json')
        .expect(400);
      expect((malformed.body.details as Array<{ path: string }>).map((d) => d.path)).toContain(
        'metadata',
      );
      await as(ctx, admin)
        .post('/api/v1/records')
        .send({ name: 'x', contentTypeId: 'nope', folderId: ws.folderId, metadata: {} })
        .expect(404);
      await as(ctx, admin)
        .post('/api/v1/records')
        .send({
          name: 'x',
          contentTypeId: ws.typeId,
          folderId: '507f1f77bcf86cd799439011',
          metadata: {},
        })
        .expect(404);
      const archivedWs = await workspace(ctx, admin, 'Archived Area');
      await as(ctx, admin).post(`/api/v1/content-types/${archivedWs.typeId}/archive`).expect(200);
      const archived = await as(ctx, admin)
        .post('/api/v1/records')
        .send({
          name: 'x',
          contentTypeId: archivedWs.typeId,
          folderId: archivedWs.folderId,
          metadata: { supplier: 'A', amount: 1 },
        })
        .expect(409);
      expect(archived.body.code).toBe('CONTENT_TYPE_ARCHIVED');
    });

    it('rejects files over the upload limit with 413 and leaves no temp file', async () => {
      const res = await as(ctx, admin)
        .post('/api/v1/records')
        .field('name', 'Huge')
        .field('contentTypeId', ws.typeId)
        .field('folderId', ws.folderId)
        .field('metadata', JSON.stringify({ supplier: 'A', amount: 1 }))
        .attach('file', Buffer.alloc(1024 * 1024 + 10, 1), 'huge.bin')
        .expect(413);
      expect(res.body.code).toBe('PAYLOAD_TOO_LARGE');
      expect(await readdir(join(process.env.STORAGE_DIR as string, 'tmp'))).toEqual([]);
    });
  });

  describe('versions', () => {
    it('adds file and metadata versions, lists history with author, comment and size, and downloads any version', async () => {
      const { id } = await createRecord(ctx, admin, ws, {
        file: { content: 'first', name: 'v1.txt' },
      });
      const v2 = await as(ctx, member)
        .post(`/api/v1/records/${id}/versions`)
        .field('comment', 'Corrected scan')
        .attach('file', Buffer.from('second!'), 'v2.txt')
        .expect(201);
      expect(v2.body).toMatchObject({
        versionNumber: 2,
        comment: 'Corrected scan',
        size: 7,
        isCurrent: true,
      });
      const v3 = await as(ctx, admin)
        .post(`/api/v1/records/${id}/versions`)
        .send({ metadata: { supplier: 'Acme', amount: 99, status: 'Paid' }, comment: 'Paid' })
        .expect(201);
      expect(v3.body).toMatchObject({
        versionNumber: 3,
        metadata: { status: 'Paid' },
        file: { fileName: 'v2.txt' },
      });

      const history = await as(ctx, admin).get(`/api/v1/records/${id}/versions`).expect(200);
      expect(history.body.map((v: { versionNumber: number }) => v.versionNumber)).toEqual([
        3, 2, 1,
      ]);
      expect(history.body[1]).toMatchObject({
        createdBy: { id: member.userId, displayName: member.displayName },
        comment: 'Corrected scan',
        size: 7,
        isCurrent: false,
      });
      expect(typeof history.body[1].createdAt).toBe('string');
      expect(history.body[2].comment).toBe('Initial version');

      const old = await as(ctx, admin).get(`/api/v1/records/${id}/versions/1/content`).expect(200);
      expect(old.text).toBe('first');
      const single = await as(ctx, admin).get(`/api/v1/records/${id}/versions/2`).expect(200);
      expect(single.body.file.fileName).toBe('v2.txt');
      await as(ctx, admin).get(`/api/v1/records/${id}/versions/9`).expect(404);
      await as(ctx, admin).get(`/api/v1/records/${id}/versions/abc`).expect(400);

      const record = await as(ctx, admin).get(`/api/v1/records/${id}`).expect(200);
      expect(record.body.record).toMatchObject({
        currentVersion: 3,
        metadata: { amount: 99, status: 'Paid' },
      });
    });

    it('restores an old version as a new version without rewriting history', async () => {
      const { id } = await createRecord(ctx, admin, ws, {
        metadata: { supplier: 'Original', amount: 1 },
        file: { content: 'original', name: 'orig.txt' },
      });
      await as(ctx, admin)
        .post(`/api/v1/records/${id}/versions`)
        .field('metadata', JSON.stringify({ supplier: 'Changed', amount: 2 }))
        .attach('file', Buffer.from('changed'), 'changed.txt')
        .expect(201);
      const restored = await as(ctx, member)
        .post(`/api/v1/records/${id}/versions/1/restore`)
        .send({})
        .expect(201);
      expect(restored.body).toMatchObject({
        versionNumber: 3,
        restoredFrom: 1,
        comment: 'Restored from version 1',
        metadata: { supplier: 'Original' },
        file: { fileName: 'orig.txt' },
      });
      const history = await as(ctx, admin).get(`/api/v1/records/${id}/versions`).expect(200);
      expect(history.body).toHaveLength(3);
      expect(history.body[1].metadata.supplier).toBe('Changed');
      const current = await as(ctx, admin).get(`/api/v1/records/${id}/content`).expect(200);
      expect(current.text).toBe('original');
    });

    it('keeps old versions on their schema; new metadata versions use the current schema', async () => {
      const localWs = await workspace(ctx, admin, 'Schema Area');
      const { id } = await createRecord(ctx, admin, localWs, {
        metadata: { supplier: 'S', amount: 1 },
      });
      const type = await as(ctx, admin).get(`/api/v1/content-types/${localWs.typeId}`).expect(200);
      await as(ctx, admin)
        .patch(`/api/v1/content-types/${localWs.typeId}`)
        .send({
          name: type.body.name,
          description: type.body.description,
          fields: [
            ...type.body.fields,
            { key: 'poNumber', label: 'PO number', type: 'text', required: true },
          ],
        })
        .expect(200);
      const fileOnly = await as(ctx, admin)
        .post(`/api/v1/records/${id}/versions`)
        .attach('file', Buffer.from('new file'), 'n.txt')
        .expect(201);
      expect(fileOnly.body.schemaVersion).toBe(1);
      const missingPo = await as(ctx, admin)
        .post(`/api/v1/records/${id}/versions`)
        .send({ metadata: { supplier: 'S', amount: 1 } })
        .expect(400);
      expect((missingPo.body.details as Array<{ path: string }>).map((d) => d.path)).toContain(
        'metadata.poNumber',
      );
      const withPo = await as(ctx, admin)
        .post(`/api/v1/records/${id}/versions`)
        .send({ metadata: { supplier: 'S', amount: 1, poNumber: 'PO-7' } })
        .expect(201);
      expect(withPo.body.schemaVersion).toBe(2);
      const v1 = await as(ctx, admin).get(`/api/v1/records/${id}/versions/1`).expect(200);
      expect(v1.body.schemaVersion).toBe(1);
      expect(v1.body.metadata).not.toHaveProperty('poNumber');
    });

    it('requires a file or metadata for a new version', async () => {
      const { id } = await createRecord(ctx, admin, ws);
      const res = await as(ctx, admin)
        .post(`/api/v1/records/${id}/versions`)
        .send({ comment: 'nothing' })
        .expect(400);
      expect(res.body.code).toBe('NOTHING_TO_VERSION');
    });

    it('assigns unique sequential numbers under concurrent uploads', async () => {
      const { id } = await createRecord(ctx, admin, ws, {
        file: { content: 'base', name: 'base.txt' },
      });
      const uploads = Array.from({ length: 10 }, (_, i) =>
        as(ctx, i % 2 === 0 ? admin : member)
          .post(`/api/v1/records/${id}/versions`)
          .field('comment', `parallel ${i}`)
          .attach('file', Buffer.from(`content ${i}`), `p${i}.txt`),
      );
      const results = await Promise.all(uploads);
      expect(results.map((r) => r.status)).toEqual(Array(10).fill(201));
      const numbers = results.map((r) => r.body.versionNumber as number).sort((a, b) => a - b);
      expect(numbers).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
      const record = await as(ctx, admin).get(`/api/v1/records/${id}`).expect(200);
      expect(record.body.record.currentVersion).toBe(11);
      const history = await as(ctx, admin).get(`/api/v1/records/${id}/versions`).expect(200);
      expect(history.body.map((v: { versionNumber: number }) => v.versionNumber)).toEqual([
        11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1,
      ]);
    });

    it('stores identical file content once (content-addressed)', async () => {
      const dedupeWs = await workspace(ctx, other, 'Dedupe');
      const first = await createRecord(ctx, other, dedupeWs, {
        file: { content: 'same bytes', name: 'a.txt' },
      });
      await createRecord(ctx, other, dedupeWs, { file: { content: 'same bytes', name: 'b.txt' } });
      await as(ctx, other)
        .post(`/api/v1/records/${first.id}/versions`)
        .attach('file', Buffer.from('same bytes'), 'c.txt')
        .expect(201);
      expect(await blobFiles(other.tenantId)).toHaveLength(1);
    });
  });

  describe('rename and move', () => {
    it('renames without creating a version and moves between folders of the same tenant', async () => {
      const { id } = await createRecord(ctx, admin, ws);
      const renamed = await as(ctx, member)
        .patch(`/api/v1/records/${id}`)
        .send({ name: 'Renamed invoice' })
        .expect(200);
      expect(renamed.body).toMatchObject({ name: 'Renamed invoice', currentVersion: 1 });
      const moved = await as(ctx, member)
        .post(`/api/v1/records/${id}/move`)
        .send({ folderId: ws.rootId })
        .expect(200);
      expect(moved.body).toMatchObject({ folderId: ws.rootId, folderName: 'Repository' });
      const otherRoot = await as(ctx, other).get('/api/v1/folders/root').expect(200);
      await as(ctx, admin)
        .post(`/api/v1/records/${id}/move`)
        .send({ folderId: otherRoot.body.folder.id })
        .expect(404);
    });

    it('refuses to move a record that was trashed while the move was checked', async () => {
      const { id } = await createRecord(ctx, admin, ws, { name: 'Trashed mid-move' });
      const folders = ctx.app.get(AccessService);
      const requireLive = folders.requireFolder.bind(folders);
      const spy = vi.spyOn(folders, 'requireFolder').mockImplementationOnce(async (...args) => {
        const target = await requireLive(...args);
        await as(ctx, admin).delete(`/api/v1/records/${id}`).expect(204);
        return target;
      });
      try {
        await as(ctx, member)
          .post(`/api/v1/records/${id}/move`)
          .send({ folderId: ws.rootId })
          .expect(404);
      } finally {
        spy.mockRestore();
      }
      const restored = await as(ctx, admin).post(`/api/v1/trash/records/${id}/restore`).expect(200);
      expect(restored.body.folderId).toBe(ws.folderId);
    });
  });

  describe('destination folder trashed meanwhile', () => {
    const newFolder = async (name: string): Promise<string> =>
      (await as(ctx, admin).post('/api/v1/folders').send({ name, parentId: ws.rootId }).expect(201))
        .body.id as string;

    const trashedFolderOf = async (folderId: string) => {
      const trash = await as(ctx, admin).get('/api/v1/trash').expect(200);
      return (trash.body.folders as Array<{ id: string; recordCount: number }>).find(
        (f) => f.id === folderId,
      );
    };

    it('refuses a move whose target folder was trashed after it was checked, and keeps the record where it was', async () => {
      const { id } = await createRecord(ctx, admin, ws, { name: 'Move into trashed' });
      const targetId = await newFolder('Doomed move target');
      const folders = ctx.app.get(AccessService);
      const requireLive = folders.requireFolder.bind(folders);
      const spy = vi.spyOn(folders, 'requireFolder').mockImplementationOnce(async (...args) => {
        const target = await requireLive(...args);
        await as(ctx, admin).delete(`/api/v1/folders/${targetId}`).expect(204);
        return target;
      });
      try {
        await as(ctx, member)
          .post(`/api/v1/records/${id}/move`)
          .send({ folderId: targetId })
          .expect(404);
      } finally {
        spy.mockRestore();
      }
      const record = await as(ctx, admin).get(`/api/v1/records/${id}`).expect(200);
      expect(record.body.record.folderId).toBe(ws.folderId);
      expect((await trashedFolderOf(targetId))?.recordCount).toBe(0);
      const audit = await as(ctx, admin).get(`/api/v1/audit?action=RECORD_MOVED`).expect(200);
      expect(audit.body.items.some((e: { resource: { id: string } }) => e.resource.id === id)).toBe(
        false,
      );
    });

    it('moves the record to the root when its source folder was trashed before the move was undone', async () => {
      const sourceId = await newFolder('Doomed move source');
      const targetId = await newFolder('Doomed move target 2');
      const { id } = await createRecord(
        ctx,
        admin,
        { ...ws, folderId: sourceId },
        { name: 'Nowhere to go back' },
      );
      const folders = ctx.app.get(AccessService);
      const foldersRepository = ctx.app.get(FoldersRepository, { strict: false });
      const requireLive = folders.requireFolder.bind(folders);
      const findById = foldersRepository.findById.bind(foldersRepository);
      let armed = false;
      const requireSpy = vi
        .spyOn(folders, 'requireFolder')
        .mockImplementationOnce(async (...args) => {
          const target = await requireLive(...args);
          await as(ctx, admin).delete(`/api/v1/folders/${targetId}`).expect(204);
          armed = true;
          return target;
        });
      const findSpy = vi
        .spyOn(foldersRepository, 'findById')
        .mockImplementation(async (tenantId, folderId) => {
          if (armed && folderId === targetId) {
            armed = false;
            await as(ctx, admin).delete(`/api/v1/folders/${sourceId}`).expect(204);
          }
          return findById(tenantId, folderId);
        });
      try {
        const res = await as(ctx, member)
          .post(`/api/v1/records/${id}/move`)
          .send({ folderId: targetId })
          .expect(404);
        expect(res.body.message).toMatch(/Target folder/);
      } finally {
        requireSpy.mockRestore();
        findSpy.mockRestore();
      }
      const record = await as(ctx, admin).get(`/api/v1/records/${id}`).expect(200);
      expect(record.body.record.folderId).toBe(ws.rootId);
      expect((await trashedFolderOf(sourceId))?.recordCount).toBe(0);
      expect((await trashedFolderOf(targetId))?.recordCount).toBe(0);
      const audit = await as(ctx, admin).get(`/api/v1/audit?action=RECORD_MOVED`).expect(200);
      const moves = (
        audit.body.items as Array<{ resource: { id: string }; context: Record<string, unknown> }>
      ).filter((e) => e.resource.id === id);
      expect(moves).toEqual([
        expect.objectContaining({
          context: { fromFolderId: sourceId, toFolderId: ws.rootId, movedToRoot: true },
        }),
      ]);
    });

    it('refuses a create whose folder was trashed after it was checked, and stores nothing', async () => {
      const folderId = await newFolder('Doomed create target');
      const folders = ctx.app.get(AccessService);
      const requireLive = folders.requireFolder.bind(folders);
      const spy = vi.spyOn(folders, 'requireFolder').mockImplementationOnce(async (...args) => {
        const folder = await requireLive(...args);
        await as(ctx, admin).delete(`/api/v1/folders/${folderId}`).expect(204);
        return folder;
      });
      try {
        await as(ctx, member)
          .post('/api/v1/records')
          .send({
            name: 'Created into trashed',
            contentTypeId: ws.typeId,
            folderId,
            metadata: { supplier: 'X', amount: 1 },
          })
          .expect(404);
      } finally {
        spy.mockRestore();
      }
      const found = await as(ctx, admin).get('/api/v1/records?q=created into trashed').expect(200);
      expect(found.body.total).toBe(0);
      const trash = await as(ctx, admin).get('/api/v1/trash').expect(200);
      expect(
        trash.body.records.some((r: { name: string }) => r.name === 'Created into trashed'),
      ).toBe(false);
      expect((await trashedFolderOf(folderId))?.recordCount).toBe(0);
    });
  });

  describe('orphan blobs', () => {
    let owner: Actor;
    let ownWs: Workspace;

    beforeAll(async () => {
      owner = await signUp(ctx, { tenantName: 'Orphan Co' });
      ownWs = await workspace(ctx, owner, 'Orphans');
    });

    it('sweeps the blob of a create refused after its upload was stored', async () => {
      const folderId = (
        await as(ctx, owner)
          .post('/api/v1/folders')
          .send({ name: 'Trashed during upload', parentId: ownWs.rootId })
          .expect(201)
      ).body.id as string;
      const before = await blobFiles(owner.tenantId);
      const blobs = ctx.app.get(BlobsService);
      const ingest = blobs.ingest.bind(blobs);
      const spy = vi.spyOn(blobs, 'ingest').mockImplementationOnce(async (tenantId, upload) => {
        await as(ctx, owner).delete(`/api/v1/folders/${folderId}`).expect(204);
        return ingest(tenantId, upload);
      });
      try {
        await as(ctx, owner)
          .post('/api/v1/records')
          .field('name', 'Orphan maker')
          .field('contentTypeId', ownWs.typeId)
          .field('folderId', folderId)
          .field('metadata', JSON.stringify({ supplier: 'Acme', amount: 1 }))
          .attach('file', Buffer.from('orphan bytes from a refused create'), 'orphan.txt')
          .expect(404);
      } finally {
        spy.mockRestore();
      }
      expect(await blobFiles(owner.tenantId)).toEqual(before);
    });

    it('sweeps the blob of a version refused after its upload was stored', async () => {
      const { id } = await createRecord(ctx, owner, ownWs, { name: 'Version orphan' });
      const before = await blobFiles(owner.tenantId);
      const blobs = ctx.app.get(BlobsService);
      const ingest = blobs.ingest.bind(blobs);
      const spy = vi.spyOn(blobs, 'ingest').mockImplementationOnce(async (tenantId, upload) => {
        await as(ctx, owner).delete(`/api/v1/records/${id}`).expect(204);
        return ingest(tenantId, upload);
      });
      try {
        await as(ctx, owner)
          .post(`/api/v1/records/${id}/versions`)
          .attach('file', Buffer.from('orphan bytes from a refused version'), 'late.txt')
          .expect(404);
      } finally {
        spy.mockRestore();
      }
      expect(await blobFiles(owner.tenantId)).toEqual(before);
    });

    it('sweeps an orphan even when more than a sweep’s worth of older blobs are still in use', async () => {
      const busy = await signUp(ctx, { tenantName: 'Busy Blobs Co' });
      const blobs = ctx.app.get(BlobsService);
      const connection = ctx.app.get<Connection>(getConnectionToken());
      const tenant = new Types.ObjectId(busy.tenantId);
      const incoming = await mkdtemp(join(tmpdir(), 'contora-sweep-'));
      const ingestText = async (content: string) => {
        const path = join(incoming, `${new Types.ObjectId().toHexString()}.txt`);
        await writeFile(path, content);
        return blobs.ingest(busy.tenantId, { path, originalName: 'f.txt', mimeType: 'text/plain' });
      };
      try {
        const inUse = await Promise.all(
          Array.from({ length: SWEEP_LIMIT + 1 }, (_, i) => ingestText(`in use ${i}`)),
        );
        const orphan = await ingestText('nobody references me');
        await connection.collection('record_versions').insertMany(
          inUse.map((file, i) => ({
            tenantId: tenant,
            recordId: new Types.ObjectId(),
            number: i + 1,
            file,
          })),
        );
        const blobsCollection = connection.collection('blobs');
        await blobsCollection.updateMany(
          { tenantId: tenant, _id: { $in: inUse.map((f) => f.blobId) } },
          { $set: { lastUsedAt: new Date(Date.now() - 2 * 3600_000) } },
        );
        await blobsCollection.updateOne(
          { _id: orphan.blobId },
          { $set: { lastUsedAt: new Date(Date.now() - 3600_000) } },
        );
        expect(await blobFiles(busy.tenantId)).toHaveLength(SWEEP_LIMIT + 2);

        expect(await blobs.sweepUnreferenced(busy.tenantId)).toBe(1);

        expect(await blobsCollection.countDocuments({ _id: orphan.blobId })).toBe(0);
        expect(await blobs.usage(busy.tenantId)).toMatchObject({ files: SWEEP_LIMIT + 1 });
        expect(await blobFiles(busy.tenantId)).toHaveLength(SWEEP_LIMIT + 1);
      } finally {
        await rm(incoming, { recursive: true, force: true });
      }
    });

    it('never fails the request when the sweep itself fails', async () => {
      const { id } = await createRecord(ctx, owner, ownWs, { name: 'Sweep fails' });
      const blobs = ctx.app.get(BlobsService);
      const ingest = blobs.ingest.bind(blobs);
      const ingestSpy = vi
        .spyOn(blobs, 'ingest')
        .mockImplementationOnce(async (tenantId, upload) => {
          await as(ctx, owner).delete(`/api/v1/records/${id}`).expect(204);
          return ingest(tenantId, upload);
        });
      const releaseSpy = vi
        .spyOn(blobs, 'releaseUnreferenced')
        .mockRejectedValueOnce(new Error('storage offline'));
      try {
        const res = await as(ctx, owner)
          .post(`/api/v1/records/${id}/versions`)
          .attach('file', Buffer.from('bytes whose sweep fails'), 'late.txt')
          .expect(404);
        expect(res.body.code).toBe('NOT_FOUND');
      } finally {
        ingestSpy.mockRestore();
        releaseSpy.mockRestore();
      }
    });
  });

  describe('check-out and check-in', () => {
    it('rechecks the check-out after a slow upload, so a lock taken meanwhile wins', async () => {
      const { id } = await createRecord(ctx, admin, ws);
      const blobs = ctx.app.get(BlobsService);
      const ingest = blobs.ingest.bind(blobs);
      const spy = vi.spyOn(blobs, 'ingest').mockImplementationOnce(async (tenantId, upload) => {
        await as(ctx, member).post(`/api/v1/records/${id}/checkout`).expect(200);
        return ingest(tenantId, upload);
      });
      try {
        const res = await as(ctx, admin)
          .post(`/api/v1/records/${id}/versions`)
          .attach('file', Buffer.from('late upload'), 'late.txt')
          .expect(409);
        expect(res.body.code).toBe('RECORD_CHECKED_OUT');
      } finally {
        spy.mockRestore();
      }
      const history = await as(ctx, admin).get(`/api/v1/records/${id}/versions`).expect(200);
      expect(history.body).toHaveLength(1);
    });

    it('refuses a rename that races a check-out, atomically', async () => {
      const { id } = await createRecord(ctx, admin, ws, { name: 'Before' });
      const types = ctx.app.get(ContentTypesService);
      const require = types.require.bind(types);
      const spy = vi.spyOn(types, 'require').mockImplementationOnce(async (tenantId, typeId) => {
        await as(ctx, member).post(`/api/v1/records/${id}/checkout`).expect(200);
        return require(tenantId, typeId);
      });
      try {
        const res = await as(ctx, admin)
          .patch(`/api/v1/records/${id}`)
          .send({ name: 'After' })
          .expect(409);
        expect(res.body.code).toBe('RECORD_CHECKED_OUT');
      } finally {
        spy.mockRestore();
      }
      const record = await as(ctx, admin).get(`/api/v1/records/${id}`).expect(200);
      expect(record.body.record.name).toBe('Before');
    });

    it('drops a version whose record was trashed during the upload', async () => {
      const { id } = await createRecord(ctx, admin, ws);
      const blobs = ctx.app.get(BlobsService);
      const ingest = blobs.ingest.bind(blobs);
      const spy = vi.spyOn(blobs, 'ingest').mockImplementationOnce(async (tenantId, upload) => {
        await as(ctx, admin).delete(`/api/v1/records/${id}`).expect(204);
        return ingest(tenantId, upload);
      });
      try {
        await as(ctx, member)
          .post(`/api/v1/records/${id}/versions`)
          .attach('file', Buffer.from('too late'), 'late.txt')
          .expect(404);
      } finally {
        spy.mockRestore();
      }
      await as(ctx, admin).post(`/api/v1/trash/records/${id}/restore`).expect(200);
      const history = await as(ctx, admin).get(`/api/v1/records/${id}/versions`).expect(200);
      expect(history.body).toHaveLength(1);
    });

    it('lets only the holder add versions; others get 409; check-in releases', async () => {
      const { id } = await createRecord(ctx, admin, ws);
      const out = await as(ctx, member).post(`/api/v1/records/${id}/checkout`).expect(200);
      expect(out.body.checkedOut).toMatchObject({
        id: member.userId,
        displayName: member.displayName,
      });
      await as(ctx, member).post(`/api/v1/records/${id}/checkout`).expect(200);
      const blocked = await as(ctx, admin)
        .post(`/api/v1/records/${id}/versions`)
        .send({ metadata: { supplier: 'Z', amount: 3 } })
        .expect(409);
      expect(blocked.body).toEqual({
        statusCode: 409,
        code: 'RECORD_CHECKED_OUT',
        message: `This record is checked out by ${member.displayName}`,
        requestId: blocked.headers['x-request-id'],
      });
      await as(ctx, admin).post(`/api/v1/records/${id}/versions/1/restore`).send({}).expect(409);
      await as(ctx, admin).post(`/api/v1/records/${id}/checkout`).expect(409);
      await as(ctx, admin).post(`/api/v1/records/${id}/checkin`).expect(409);
      await as(ctx, member)
        .post(`/api/v1/records/${id}/versions`)
        .send({ metadata: { supplier: 'Mine', amount: 3 } })
        .expect(201);
      const released = await as(ctx, member).post(`/api/v1/records/${id}/checkin`).expect(200);
      expect(released.body.checkedOut).toBeNull();
      await as(ctx, admin)
        .post(`/api/v1/records/${id}/versions`)
        .send({ metadata: { supplier: 'Admin', amount: 4 } })
        .expect(201);
      const notOut = await as(ctx, admin).post(`/api/v1/records/${id}/checkin`).expect(409);
      expect(notOut.body.code).toBe('NOT_CHECKED_OUT');
    });

    it('lets an admin force-release but not a member', async () => {
      const { id } = await createRecord(ctx, admin, ws);
      await as(ctx, admin).post(`/api/v1/records/${id}/checkout`).expect(200);
      await as(ctx, member).post(`/api/v1/records/${id}/force-release`).expect(403);
      const second = await addMember(ctx, admin, 'admin');
      const released = await as(ctx, second)
        .post(`/api/v1/records/${id}/force-release`)
        .expect(200);
      expect(released.body.checkedOut).toBeNull();
      const audit = await as(ctx, admin).get(`/api/v1/audit?resourceId=${id}`).expect(200);
      expect(audit.body.items.map((e: { action: string }) => e.action)).toEqual(
        expect.arrayContaining(['RECORD_CREATED', 'RECORD_CHECKED_OUT', 'RECORD_FORCE_RELEASED']),
      );
    });

    it('lets exactly one of two racing check-outs win; the other gets 409', async () => {
      const { id } = await createRecord(ctx, admin, ws);
      const second = await addMember(ctx, admin);
      await grantRootEdit(ctx, admin, second);
      const state = ctx.app.get(RecordState);
      const requireLive = state.requireLive.bind(state);
      const spy = vi.spyOn(state, 'requireLive').mockImplementationOnce(async (...args) => {
        const read = await requireLive(...args);
        await as(ctx, second).post(`/api/v1/records/${id}/checkout`).expect(200);
        return read;
      });
      try {
        const res = await as(ctx, member).post(`/api/v1/records/${id}/checkout`).expect(409);
        expect(res.body.code).toBe('RECORD_CHECKED_OUT');
        expect(res.body.message).toBe(`This record is checked out by ${second.displayName}`);
        expect(spy).toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
      const record = await as(ctx, admin).get(`/api/v1/records/${id}`).expect(200);
      expect(record.body.record.checkedOut).toMatchObject({ id: second.userId });
      const audit = await as(ctx, admin)
        .get(`/api/v1/audit?action=RECORD_CHECKED_OUT&resourceId=${id}`)
        .expect(200);
      expect(audit.body.items.map((e: { actor: { id: string } }) => e.actor.id)).toEqual([
        second.userId,
      ]);

      await as(ctx, second).post(`/api/v1/records/${id}/checkin`).expect(200);
      const both = await Promise.all([
        as(ctx, member).post(`/api/v1/records/${id}/checkout`),
        as(ctx, second).post(`/api/v1/records/${id}/checkout`),
      ]);
      expect(both.map((r) => r.status).sort((a, b) => a - b)).toEqual([200, 409]);
      expect(both.find((r) => r.status === 409)?.body.code).toBe('RECORD_CHECKED_OUT');
      const winner = both[0].status === 200 ? member : second;
      const held = await as(ctx, admin).get(`/api/v1/records/${id}`).expect(200);
      expect(held.body.record.checkedOut).toMatchObject({ id: winner.userId });
    });

    it('lets a check-in release only the holder’s own check-out, atomically', async () => {
      const { id } = await createRecord(ctx, admin, ws);
      const second = await addMember(ctx, admin);
      await grantRootEdit(ctx, admin, second);
      await as(ctx, member).post(`/api/v1/records/${id}/checkout`).expect(200);
      const state = ctx.app.get(RecordState);
      const requireLive = state.requireLive.bind(state);
      const spy = vi.spyOn(state, 'requireLive').mockImplementationOnce(async (...args) => {
        const read = await requireLive(...args);
        await as(ctx, admin).post(`/api/v1/records/${id}/force-release`).expect(200);
        await as(ctx, second).post(`/api/v1/records/${id}/checkout`).expect(200);
        return read;
      });
      try {
        const res = await as(ctx, member).post(`/api/v1/records/${id}/checkin`).expect(409);
        expect(res.body.code).toBe('RECORD_CHECKED_OUT');
        expect(spy).toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
      const record = await as(ctx, admin).get(`/api/v1/records/${id}`).expect(200);
      expect(record.body.record.checkedOut).toMatchObject({ id: second.userId });
    });

    it('force-releases only the check-out it read, atomically', async () => {
      const { id } = await createRecord(ctx, admin, ws);
      const second = await addMember(ctx, admin);
      await grantRootEdit(ctx, admin, second);
      await as(ctx, member).post(`/api/v1/records/${id}/checkout`).expect(200);
      const state = ctx.app.get(RecordState);
      const requireLive = state.requireLive.bind(state);
      const spy = vi.spyOn(state, 'requireLive').mockImplementationOnce(async (...args) => {
        const read = await requireLive(...args);
        await as(ctx, member).post(`/api/v1/records/${id}/checkin`).expect(200);
        await as(ctx, second).post(`/api/v1/records/${id}/checkout`).expect(200);
        return read;
      });
      try {
        const res = await as(ctx, admin).post(`/api/v1/records/${id}/force-release`).expect(409);
        expect(res.body.code).toBe('RECORD_CHECKED_OUT');
        expect(spy).toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
      const record = await as(ctx, admin).get(`/api/v1/records/${id}`).expect(200);
      expect(record.body.record.checkedOut).toMatchObject({ id: second.userId });
      const audit = await as(ctx, admin).get(`/api/v1/audit?resourceId=${id}`).expect(200);
      expect(audit.body.items.map((e: { action: string }) => e.action)).not.toContain(
        'RECORD_FORCE_RELEASED',
      );
    });

    it('does not check in or force-release a record trashed meanwhile', async () => {
      const { id } = await createRecord(ctx, admin, ws);
      const state = ctx.app.get(RecordState);
      const requireLive = state.requireLive.bind(state);
      const trashMeanwhile = () =>
        vi.spyOn(state, 'requireLive').mockImplementationOnce(async (...args) => {
          const read = await requireLive(...args);
          await as(ctx, admin).delete(`/api/v1/records/${id}`).expect(204);
          return read;
        });
      await as(ctx, admin).post(`/api/v1/records/${id}/checkout`).expect(200);
      let spy = trashMeanwhile();
      try {
        await as(ctx, admin).post(`/api/v1/records/${id}/checkin`).expect(404);
        expect(spy).toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
      await as(ctx, admin).post(`/api/v1/trash/records/${id}/restore`).expect(200);
      await as(ctx, admin).post(`/api/v1/records/${id}/checkout`).expect(200);
      spy = trashMeanwhile();
      try {
        await as(ctx, admin).post(`/api/v1/records/${id}/force-release`).expect(404);
        expect(spy).toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('tenant isolation', () => {
    it('never exposes a record, its versions or its files to another tenant', async () => {
      const { id } = await createRecord(ctx, admin, ws, {
        file: { content: 'secret', name: 's.txt' },
      });
      const otherActor = as(ctx, other);
      await otherActor.get(`/api/v1/records/${id}`).expect(404);
      await otherActor.get(`/api/v1/records/${id}/content`).expect(404);
      await otherActor.get(`/api/v1/records/${id}/versions`).expect(404);
      await otherActor.get(`/api/v1/records/${id}/versions/1`).expect(404);
      await otherActor.get(`/api/v1/records/${id}/versions/1/content`).expect(404);
      await otherActor.patch(`/api/v1/records/${id}`).send({ name: 'Stolen' }).expect(404);
      await otherActor
        .post(`/api/v1/records/${id}/versions`)
        .send({ metadata: { supplier: 'x', amount: 1 } })
        .expect(404);
      await otherActor.post(`/api/v1/records/${id}/versions/1/restore`).send({}).expect(404);
      await otherActor.post(`/api/v1/records/${id}/checkout`).expect(404);
      await as(ctx, admin).post(`/api/v1/records/${id}/checkout`).expect(200);
      await otherActor.post(`/api/v1/records/${id}/checkin`).expect(404);
      await otherActor.post(`/api/v1/records/${id}/force-release`).expect(404);
      await as(ctx, admin).post(`/api/v1/records/${id}/checkin`).expect(200);
      await otherActor
        .post('/api/v1/records')
        .send({
          name: 'x',
          contentTypeId: ws.typeId,
          folderId: ws.folderId,
          metadata: { supplier: 'a', amount: 1 },
        })
        .expect(404);
      const list = await otherActor.get('/api/v1/records?q=invoice').expect(200);
      expect(list.body.items.some((r: { id: string }) => r.id === id)).toBe(false);
      await as(ctx, admin).get('/api/v1/records/not-an-id').expect(404);
    });
  });
});
