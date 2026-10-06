import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { Folder } from '../src/folders/folder.schema.js';
import { FoldersRepository } from '../src/folders/folders.repository.js';
import { RecordEntity } from '../src/records/record.schema.js';
import { RecordState } from '../src/records/record-state.js';
import { RecordsRepository, VersionsRepository } from '../src/records/records.repository.js';
import type { FileRef } from '../src/storage/blob.schema.js';
import { BlobsService } from '../src/storage/blobs.service.js';
import { addMember, as, signUp, type Actor } from './helpers/actors.js';
import { createRecord, workspace, type Workspace, grantRootEdit } from './helpers/fixtures.js';
import { createTestApp, type TestApp } from './helpers/test-app.js';

async function blobCount(tenantId: string): Promise<number> {
  const dir = join(process.env.STORAGE_DIR as string, 'blobs', tenantId);
  const shards = await readdir(dir).catch(() => [] as string[]);
  const files = await Promise.all(
    shards.map((s) => readdir(join(dir, s)).catch(() => [] as string[])),
  );
  return files.flat().length;
}

async function ingestOrphan(ctx: TestApp, tenantId: string, content: string): Promise<FileRef> {
  const dir = await mkdtemp(join(tmpdir(), 'orphan-'));
  const path = join(dir, 'upload.bin');
  await writeFile(path, content);
  try {
    return await ctx.app
      .get(BlobsService)
      .ingest(tenantId, { path, originalName: 'o.txt', mimeType: 'text/plain' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('trash (e2e)', () => {
  let ctx: TestApp;
  let admin: Actor;
  let member: Actor;
  let other: Actor;
  let ws: Workspace;

  beforeAll(async () => {
    ctx = await createTestApp();
    admin = await signUp(ctx, { tenantName: 'Trash Co' });
    member = await addMember(ctx, admin);
    await grantRootEdit(ctx, admin, member);
    other = await signUp(ctx, { tenantName: 'Other Co' });
    ws = await workspace(ctx, admin);
  });

  afterAll(async () => {
    await ctx.stop();
  });

  it('trashes a record out of normal views and restores it', async () => {
    const { id } = await createRecord(ctx, member, ws, { name: 'Soft deleted' });
    await as(ctx, member).delete(`/api/v1/records/${id}`).expect(204);
    await as(ctx, admin).get(`/api/v1/records/${id}`).expect(404);
    const listed = await as(ctx, admin).get(`/api/v1/records?folderId=${ws.folderId}`).expect(200);
    expect(listed.body.items.some((r: { id: string }) => r.id === id)).toBe(false);
    const trash = await as(ctx, member).get('/api/v1/trash').expect(200);
    expect(trash.body.records.find((r: { id: string }) => r.id === id)).toMatchObject({
      name: 'Soft deleted',
      deletedBy: { id: member.userId },
      trashedWithFolder: false,
    });
    const restored = await as(ctx, member).post(`/api/v1/trash/records/${id}/restore`).expect(200);
    expect(restored.body.folderId).toBe(ws.folderId);
    await as(ctx, admin).get(`/api/v1/records/${id}`).expect(200);
  });

  it('refuses to trash a record checked out by someone else', async () => {
    const { id } = await createRecord(ctx, admin, ws);
    await as(ctx, admin).post(`/api/v1/records/${id}/checkout`).expect(200);
    const refused = await as(ctx, member).delete(`/api/v1/records/${id}`).expect(409);
    expect(refused.body.code).toBe('RECORD_CHECKED_OUT');
    await as(ctx, admin).post(`/api/v1/records/${id}/checkin`).expect(200);
  });

  it('trashing a folder trashes its subfolders and records; restoring brings them all back', async () => {
    const root = ws.rootId;
    const parent = (
      await as(ctx, admin)
        .post('/api/v1/folders')
        .send({ name: 'Projects', parentId: root })
        .expect(201)
    ).body.id;
    const child = (
      await as(ctx, admin)
        .post('/api/v1/folders')
        .send({ name: 'Alpha', parentId: parent })
        .expect(201)
    ).body.id;
    const inParent = await createRecord(
      ctx,
      admin,
      { ...ws, folderId: parent },
      { name: 'In parent' },
    );
    const inChild = await createRecord(
      ctx,
      admin,
      { ...ws, folderId: child },
      { name: 'In child' },
    );

    await as(ctx, member).delete(`/api/v1/folders/${parent}`).expect(204);
    await as(ctx, admin).get(`/api/v1/folders/${parent}`).expect(404);
    await as(ctx, admin).get(`/api/v1/folders/${child}`).expect(404);
    await as(ctx, admin).get(`/api/v1/records/${inChild.id}`).expect(404);
    const tree = await as(ctx, admin).get('/api/v1/folders/tree').expect(200);
    expect(tree.body.map((f: { name: string }) => f.name)).not.toContain('Projects');

    const trash = await as(ctx, admin).get('/api/v1/trash').expect(200);
    expect(trash.body.folders.find((f: { id: string }) => f.id === parent)).toMatchObject({
      name: 'Projects',
      folderCount: 2,
      recordCount: 2,
    });
    expect(trash.body.folders.some((f: { id: string }) => f.id === child)).toBe(false);
    expect(
      trash.body.records.find((r: { id: string }) => r.id === inChild.id).trashedWithFolder,
    ).toBe(true);

    await as(ctx, admin).post(`/api/v1/trash/folders/${parent}/restore`).expect(204);
    await as(ctx, admin).get(`/api/v1/folders/${child}`).expect(200);
    await as(ctx, admin).get(`/api/v1/records/${inParent.id}`).expect(200);
    await as(ctx, admin).get(`/api/v1/records/${inChild.id}`).expect(200);
  });

  it('restores a single record from a trashed folder into the root', async () => {
    const folder = (
      await as(ctx, admin)
        .post('/api/v1/folders')
        .send({ name: 'Temp', parentId: ws.rootId })
        .expect(201)
    ).body.id;
    const rec = await createRecord(ctx, admin, { ...ws, folderId: folder }, { name: 'Rescued' });
    await as(ctx, admin).delete(`/api/v1/folders/${folder}`).expect(204);
    const restored = await as(ctx, admin)
      .post(`/api/v1/trash/records/${rec.id}/restore`)
      .expect(200);
    expect(restored.body.folderId).toBe(ws.rootId);
  });

  it('refuses to restore a folder whose parent is in the trash, or whose name was reused', async () => {
    const outer = (
      await as(ctx, admin)
        .post('/api/v1/folders')
        .send({ name: 'Outer', parentId: ws.rootId })
        .expect(201)
    ).body.id;
    const inner = (
      await as(ctx, admin)
        .post('/api/v1/folders')
        .send({ name: 'Inner', parentId: outer })
        .expect(201)
    ).body.id;
    await as(ctx, admin).delete(`/api/v1/folders/${inner}`).expect(204);
    await as(ctx, admin).delete(`/api/v1/folders/${outer}`).expect(204);
    const blocked = await as(ctx, admin).post(`/api/v1/trash/folders/${inner}/restore`).expect(409);
    expect(blocked.body.code).toBe('PARENT_IN_TRASH');
    await as(ctx, admin)
      .post('/api/v1/folders')
      .send({ name: 'Outer', parentId: ws.rootId })
      .expect(201);
    const taken = await as(ctx, admin).post(`/api/v1/trash/folders/${outer}/restore`).expect(409);
    expect(taken.body.code).toBe('NAME_TAKEN');
  });

  it('lets only admins purge; purge removes versions and blobs no other version uses', async () => {
    const shared = 'shared content';
    const doomed = await createRecord(ctx, admin, ws, {
      file: { content: 'unique to doomed', name: 'u.txt' },
    });
    await as(ctx, admin)
      .post(`/api/v1/records/${doomed.id}/versions`)
      .attach('file', Buffer.from(shared), 's.txt')
      .expect(201);
    await createRecord(ctx, admin, ws, {
      name: 'Keeper',
      file: { content: shared, name: 'k.txt' },
    });
    const before = await blobCount(admin.tenantId);

    await as(ctx, admin).delete(`/api/v1/records/${doomed.id}`).expect(204);
    await as(ctx, member).delete(`/api/v1/trash/records/${doomed.id}`).expect(403);
    const purged = await as(ctx, admin).delete(`/api/v1/trash/records/${doomed.id}`).expect(200);
    expect(purged.body).toEqual({ records: 1, versions: 2, blobsReleased: 1 });
    expect(await blobCount(admin.tenantId)).toBe(before - 1);
    await as(ctx, admin).post(`/api/v1/trash/records/${doomed.id}/restore`).expect(404);

    const audit = await as(ctx, admin).get(`/api/v1/audit?resourceId=${doomed.id}`).expect(200);
    expect(audit.body.items.map((e: { action: string }) => e.action)).toEqual(
      expect.arrayContaining([
        'RECORD_CREATED',
        'VERSION_CREATED',
        'RECORD_TRASHED',
        'RECORD_PURGED',
      ]),
    );
  });

  it('purges a whole trashed folder and can empty the trash', async () => {
    const folder = (
      await as(ctx, admin)
        .post('/api/v1/folders')
        .send({ name: 'Old stuff', parentId: ws.rootId })
        .expect(201)
    ).body.id;
    await createRecord(ctx, admin, { ...ws, folderId: folder }, { name: 'Old 1' });
    await createRecord(ctx, admin, { ...ws, folderId: folder }, { name: 'Old 2' });
    await as(ctx, admin).delete(`/api/v1/folders/${folder}`).expect(204);
    await as(ctx, member).delete(`/api/v1/trash/folders/${folder}`).expect(403);
    const purged = await as(ctx, admin).delete(`/api/v1/trash/folders/${folder}`).expect(200);
    expect(purged.body.records).toBe(2);
    const loose = await createRecord(ctx, admin, ws, { name: 'Loose' });
    await as(ctx, admin).delete(`/api/v1/records/${loose.id}`).expect(204);
    await as(ctx, admin).delete('/api/v1/trash').expect(200);
    const trash = await as(ctx, admin).get('/api/v1/trash').expect(200);
    expect(trash.body).toEqual({ folders: [], records: [] });
  });

  it('purging a folder also purges what was trashed inside it earlier', async () => {
    const folder = (name: string, parentId: string) =>
      as(ctx, admin)
        .post('/api/v1/folders')
        .send({ name, parentId })
        .expect(201)
        .then((res) => res.body.id as string);
    const outer = await folder('Archive 2020', ws.rootId);
    const inner = await folder('Q1', outer);
    const early = await createRecord(ctx, admin, { ...ws, folderId: outer }, { name: 'Early' });
    await createRecord(ctx, admin, { ...ws, folderId: inner }, { name: 'In Q1' });
    await as(ctx, admin).delete(`/api/v1/folders/${inner}`).expect(204);
    await as(ctx, admin).delete(`/api/v1/records/${early.id}`).expect(204);
    await as(ctx, admin).delete(`/api/v1/folders/${outer}`).expect(204);

    const purged = await as(ctx, admin).delete(`/api/v1/trash/folders/${outer}`).expect(200);
    expect(purged.body.records).toBe(2);
    const trash = await as(ctx, admin).get('/api/v1/trash').expect(200);
    const ids = [...trash.body.folders, ...trash.body.records].map((i: { id: string }) => i.id);
    expect(ids).not.toContain(inner);
    expect(ids).not.toContain(early.id);
    await as(ctx, admin).post(`/api/v1/trash/folders/${inner}/restore`).expect(404);
  });

  async function trashedFolderWith(name: string): Promise<{ folderId: string; recordId: string }> {
    const folderId = (
      await as(ctx, admin).post('/api/v1/folders').send({ name, parentId: ws.rootId }).expect(201)
    ).body.id as string;
    const { id } = await createRecord(
      ctx,
      admin,
      { ...ws, folderId },
      { name: `${name} doc`, file: { content: `${name} bytes`, name: 'f.txt' } },
    );
    await as(ctx, admin).delete(`/api/v1/folders/${folderId}`).expect(204);
    return { folderId, recordId: id };
  }

  function afterPurgeClaim(during: () => Promise<void>) {
    const versions = ctx.app.get(VersionsRepository, { strict: false });
    const distinct = versions.distinct.bind(versions);
    return vi.spyOn(versions, 'distinct').mockImplementationOnce(async (...args) => {
      await during();
      return distinct(...args);
    });
  }

  it('answers a restore arriving after the purge claimed the record with 404; the purge completes', async () => {
    const { id } = await createRecord(ctx, admin, ws, {
      name: 'Contested',
      file: { content: 'contested bytes', name: 'c.txt' },
    });
    await as(ctx, admin).delete(`/api/v1/records/${id}`).expect(204);
    let restore = 0;
    const spy = afterPurgeClaim(async () => {
      restore = (await as(ctx, admin).post(`/api/v1/trash/records/${id}/restore`)).status;
    });
    try {
      await as(ctx, admin).delete(`/api/v1/trash/records/${id}`).expect(200);
    } finally {
      spy.mockRestore();
    }
    expect(restore).toBe(404);
    await as(ctx, admin).get(`/api/v1/records/${id}`).expect(404);
  });

  it('lets a restore landing before the purge claims the record win; the purge 404s', async () => {
    const { id } = await createRecord(ctx, admin, ws, {
      name: 'Rescued',
      file: { content: 'rescued bytes', name: 'r.txt' },
    });
    await as(ctx, admin).delete(`/api/v1/records/${id}`).expect(204);
    const records = ctx.app.get(RecordsRepository, { strict: false });
    const findById = records.findById.bind(records);
    const spy = vi.spyOn(records, 'findById').mockImplementationOnce(async (...args) => {
      const read = await findById(...args);
      await as(ctx, admin).post(`/api/v1/trash/records/${id}/restore`).expect(200);
      return read;
    });
    try {
      await as(ctx, admin).delete(`/api/v1/trash/records/${id}`).expect(404);
    } finally {
      spy.mockRestore();
    }
    const content = await as(ctx, admin).get(`/api/v1/records/${id}/content`).expect(200);
    expect(content.text).toBe('rescued bytes');
    const audit = await as(ctx, admin).get(`/api/v1/audit?resourceId=${id}`).expect(200);
    expect(audit.body.items.map((e: { action: string }) => e.action)).not.toContain(
      'RECORD_PURGED',
    );
  });

  it('answers a folder or record restore arriving after the folder purge claimed it with 404', async () => {
    for (const restoreWhat of ['folder', 'record'] as const) {
      const { folderId, recordId } = await trashedFolderWith(`Claimed ${restoreWhat}`);
      let restore = 0;
      const spy = afterPurgeClaim(async () => {
        const url =
          restoreWhat === 'folder'
            ? `/api/v1/trash/folders/${folderId}/restore`
            : `/api/v1/trash/records/${recordId}/restore`;
        restore = (await as(ctx, admin).post(url)).status;
      });
      try {
        const purged = await as(ctx, admin).delete(`/api/v1/trash/folders/${folderId}`).expect(200);
        expect(purged.body.records).toBe(1);
      } finally {
        spy.mockRestore();
      }
      expect(restore).toBe(404);
      await as(ctx, admin).get(`/api/v1/records/${recordId}`).expect(404);
      await as(ctx, admin).get(`/api/v1/folders/${folderId}`).expect(404);
    }
  });

  it('lets a folder restore landing before the folder purge claims it win; the purge 404s', async () => {
    const { folderId, recordId } = await trashedFolderWith('Rescued folder');
    const folders = ctx.app.get(FoldersRepository, { strict: false });
    const findById = folders.findById.bind(folders);
    const spy = vi.spyOn(folders, 'findById').mockImplementationOnce(async (...args) => {
      const read = await findById(...args);
      await as(ctx, admin).post(`/api/v1/trash/folders/${folderId}/restore`).expect(204);
      return read;
    });
    try {
      await as(ctx, admin).delete(`/api/v1/trash/folders/${folderId}`).expect(404);
    } finally {
      spy.mockRestore();
    }
    await as(ctx, admin).get(`/api/v1/folders/${folderId}`).expect(200);
    const content = await as(ctx, admin).get(`/api/v1/records/${recordId}/content`).expect(200);
    expect(content.text).toBe('Rescued folder bytes');
  });

  it('lets a record restore landing before the folder purge claims the record win', async () => {
    const { folderId, recordId } = await trashedFolderWith('Rescued record');
    const records = ctx.app.get(RecordsRepository, { strict: false });
    const find = records.find.bind(records);
    const spy = vi.spyOn(records, 'find').mockImplementationOnce(async (...args) => {
      const read = await find(...args);
      await as(ctx, admin).post(`/api/v1/trash/records/${recordId}/restore`).expect(200);
      return read;
    });
    try {
      const purged = await as(ctx, admin).delete(`/api/v1/trash/folders/${folderId}`).expect(200);
      expect(purged.body.records).toBe(0);
    } finally {
      spy.mockRestore();
    }
    await as(ctx, admin).get(`/api/v1/folders/${folderId}`).expect(404);
    const content = await as(ctx, admin).get(`/api/v1/records/${recordId}/content`).expect(200);
    expect(content.text).toBe('Rescued record bytes');
  });

  it('takes over a purge claim left by a purge that crashed, but respects a recent one', async () => {
    const recordsModel = ctx.app.get<Model<RecordEntity>>(getModelToken(RecordEntity.name));
    const foldersModel = ctx.app.get<Model<Folder>>(getModelToken(Folder.name));
    const claim = (minutesAgo: number) => ({
      purgeToken: `crashed-${minutesAgo}`,
      purgeClaimedAt: new Date(Date.now() - minutesAgo * 60_000),
    });

    const stale = await createRecord(ctx, admin, ws, { name: 'Stale claim' });
    const fresh = await createRecord(ctx, admin, ws, { name: 'Fresh claim' });
    for (const { id } of [stale, fresh]) {
      await as(ctx, admin).delete(`/api/v1/records/${id}`).expect(204);
    }
    await recordsModel.updateOne({ _id: stale.id }, claim(11)).exec();
    await recordsModel.updateOne({ _id: fresh.id }, claim(1)).exec();
    await as(ctx, admin).post(`/api/v1/trash/records/${stale.id}/restore`).expect(404);
    const purged = await as(ctx, admin).delete(`/api/v1/trash/records/${stale.id}`).expect(200);
    expect(purged.body).toMatchObject({ records: 1, versions: 1 });
    expect(await recordsModel.countDocuments({ _id: stale.id }).exec()).toBe(0);
    await as(ctx, admin).delete(`/api/v1/trash/records/${fresh.id}`).expect(404);
    expect(await recordsModel.countDocuments({ _id: fresh.id }).exec()).toBe(1);

    const staleFolder = await trashedFolderWith('Stale folder claim');
    const freshFolder = await trashedFolderWith('Fresh folder claim');
    const batchOf = async (folderId: string) =>
      (await foldersModel.findById(folderId).exec())?.trashBatchId as string;
    for (const [{ folderId }, minutesAgo] of [
      [staleFolder, 11],
      [freshFolder, 1],
    ] as const) {
      const trashBatchId = await batchOf(folderId);
      await foldersModel.updateMany({ trashBatchId }, claim(minutesAgo)).exec();
      await recordsModel.updateMany({ trashBatchId }, claim(minutesAgo)).exec();
    }
    const folderPurge = await as(ctx, admin)
      .delete(`/api/v1/trash/folders/${staleFolder.folderId}`)
      .expect(200);
    expect(folderPurge.body.records).toBe(1);
    expect(await foldersModel.countDocuments({ _id: staleFolder.folderId }).exec()).toBe(0);
    expect(await recordsModel.countDocuments({ _id: staleFolder.recordId }).exec()).toBe(0);
    await as(ctx, admin).delete(`/api/v1/trash/folders/${freshFolder.folderId}`).expect(404);
    expect(await foldersModel.countDocuments({ _id: freshFolder.folderId }).exec()).toBe(1);
    expect(await recordsModel.countDocuments({ _id: freshFolder.recordId }).exec()).toBe(1);
  });

  it('refuses to trash a folder when a record in it is checked out meanwhile, and keeps it all live', async () => {
    const folderId = (
      await as(ctx, admin)
        .post('/api/v1/folders')
        .send({ name: 'Racy', parentId: ws.rootId })
        .expect(201)
    ).body.id as string;
    const sub = (
      await as(ctx, admin)
        .post('/api/v1/folders')
        .send({ name: 'Sub', parentId: folderId })
        .expect(201)
    ).body.id as string;
    const mine = await createRecord(ctx, admin, { ...ws, folderId }, { name: 'Mine' });
    const theirs = await createRecord(ctx, admin, { ...ws, folderId: sub }, { name: 'Theirs' });
    await as(ctx, admin).post(`/api/v1/records/${mine.id}/checkout`).expect(200);

    const folders = ctx.app.get(FoldersRepository, { strict: false });
    const updateMany = folders.updateMany.bind(folders);
    const spy = vi.spyOn(folders, 'updateMany').mockImplementationOnce(async (...args) => {
      await as(ctx, member).post(`/api/v1/records/${theirs.id}/checkout`).expect(200);
      return updateMany(...args);
    });
    try {
      const refused = await as(ctx, admin).delete(`/api/v1/folders/${folderId}`).expect(409);
      expect(refused.body.code).toBe('RECORD_CHECKED_OUT');
    } finally {
      spy.mockRestore();
    }

    await as(ctx, admin).get(`/api/v1/folders/${folderId}`).expect(200);
    await as(ctx, admin).get(`/api/v1/folders/${sub}`).expect(200);
    const theirsNow = await as(ctx, admin).get(`/api/v1/records/${theirs.id}`).expect(200);
    expect(theirsNow.body.record.checkedOut).toMatchObject({ id: member.userId });
    const mineNow = await as(ctx, admin).get(`/api/v1/records/${mine.id}`).expect(200);
    expect(mineNow.body.record.checkedOut).toMatchObject({ id: admin.userId });
    const trash = await as(ctx, admin).get('/api/v1/trash').expect(200);
    const trashedIds = [...trash.body.folders, ...trash.body.records].map(
      (i: { id: string }) => i.id,
    );
    expect(trashedIds).not.toContain(folderId);
    expect(trashedIds).not.toContain(sub);
    expect(trashedIds).not.toContain(mine.id);
    expect(trashedIds).not.toContain(theirs.id);

    await as(ctx, member).post(`/api/v1/records/${theirs.id}/checkin`).expect(200);
    await as(ctx, admin).delete(`/api/v1/folders/${folderId}`).expect(204);
    await as(ctx, admin).get(`/api/v1/records/${mine.id}`).expect(404);
  });

  it('isolates trash between tenants', async () => {
    const { id } = await createRecord(ctx, admin, ws, { name: 'Private trash' });
    await as(ctx, admin).delete(`/api/v1/records/${id}`).expect(204);
    const otherTrash = await as(ctx, other).get('/api/v1/trash').expect(200);
    expect(otherTrash.body.records).toEqual([]);
    await as(ctx, other).post(`/api/v1/trash/records/${id}/restore`).expect(404);
    await as(ctx, other).delete(`/api/v1/trash/records/${id}`).expect(404);
    await as(ctx, other).delete(`/api/v1/records/${id}`).expect(404);
    await as(ctx, other).delete(`/api/v1/folders/${ws.folderId}`).expect(404);
    await as(ctx, other).delete(`/api/v1/folders/${ws.rootId}`).expect(404);
    await as(ctx, admin).delete(`/api/v1/folders/${ws.rootId}`).expect(400);
  });

  it('never restores or purges another tenant’s trashed folder', async () => {
    const folderId = (
      await as(ctx, admin)
        .post('/api/v1/folders')
        .send({ name: 'Private trashed folder', parentId: ws.rootId })
        .expect(201)
    ).body.id as string;
    const inside = await createRecord(ctx, admin, { ...ws, folderId }, { name: 'Inside' });
    await as(ctx, admin).delete(`/api/v1/folders/${folderId}`).expect(204);

    await as(ctx, other).post(`/api/v1/trash/folders/${folderId}/restore`).expect(404);
    await as(ctx, other).delete(`/api/v1/trash/folders/${folderId}`).expect(404);

    const trash = await as(ctx, admin).get('/api/v1/trash').expect(200);
    expect(trash.body.folders.find((f: { id: string }) => f.id === folderId)).toMatchObject({
      recordCount: 1,
    });
    await as(ctx, admin).get(`/api/v1/folders/${folderId}`).expect(404);
    await as(ctx, admin).post(`/api/v1/trash/folders/${folderId}/restore`).expect(204);
    await as(ctx, admin).get(`/api/v1/folders/${folderId}`).expect(200);
    await as(ctx, admin).get(`/api/v1/records/${inside.id}`).expect(200);
  });

  it('empties only the caller’s own trash, leaving another tenant’s trash restorable', async () => {
    const otherWs = await workspace(ctx, other, 'Other trash');
    const theirs = await createRecord(ctx, other, otherWs, { name: 'Their trashed record' });
    await as(ctx, other).delete(`/api/v1/records/${theirs.id}`).expect(204);
    const mine = await createRecord(ctx, admin, ws, { name: 'My trashed record' });
    await as(ctx, admin).delete(`/api/v1/records/${mine.id}`).expect(204);
    const folderId = (
      await as(ctx, admin)
        .post('/api/v1/folders')
        .send({ name: 'My trashed folder', parentId: ws.rootId })
        .expect(201)
    ).body.id as string;
    await as(ctx, admin).delete(`/api/v1/folders/${folderId}`).expect(204);
    const before = await as(ctx, admin).get('/api/v1/trash').expect(200);

    const emptied = await as(ctx, other).delete('/api/v1/trash').expect(200);
    expect(emptied.body).toEqual({ records: 1, versions: 1, blobsReleased: 0 });
    expect((await as(ctx, other).get('/api/v1/trash').expect(200)).body).toEqual({
      folders: [],
      records: [],
    });

    const after = await as(ctx, admin).get('/api/v1/trash').expect(200);
    expect(after.body).toEqual(before.body);
    await as(ctx, admin).post(`/api/v1/trash/records/${mine.id}/restore`).expect(200);
    await as(ctx, admin).post(`/api/v1/trash/folders/${folderId}/restore`).expect(204);
    await as(ctx, admin).get(`/api/v1/records/${mine.id}`).expect(200);
    await as(ctx, admin).get(`/api/v1/folders/${folderId}`).expect(200);
  });

  it('refuses to trash a record someone checked out between the read and the write, and keeps their lock', async () => {
    const { id } = await createRecord(ctx, admin, ws, { name: 'Contested' });
    const state = ctx.app.get(RecordState);
    const requireLive = state.requireLive.bind(state);
    const spy = vi.spyOn(state, 'requireLive').mockImplementationOnce(async (...args) => {
      const read = await requireLive(...args);
      await as(ctx, member).post(`/api/v1/records/${id}/checkout`).expect(200);
      return read;
    });
    try {
      const res = await as(ctx, admin).delete(`/api/v1/records/${id}`).expect(409);
      expect(res.body.code).toBe('RECORD_CHECKED_OUT');
      expect(res.body.message).toBe(`This record is checked out by ${member.displayName}`);
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
    const record = await as(ctx, admin).get(`/api/v1/records/${id}`).expect(200);
    expect(record.body.record.checkedOut).toMatchObject({ id: member.userId });
    const trash = await as(ctx, admin).get('/api/v1/trash').expect(200);
    expect(trash.body.records.some((r: { id: string }) => r.id === id)).toBe(false);
    const audit = await as(ctx, admin).get(`/api/v1/audit?resourceId=${id}`).expect(200);
    expect(audit.body.items.map((e: { action: string }) => e.action)).not.toContain(
      'RECORD_TRASHED',
    );
    await as(ctx, member).post(`/api/v1/records/${id}/checkin`).expect(200);
  });

  it('sweeps blobs no version references (left by refused uploads) at the end of a purge', async () => {
    const owner = await signUp(ctx, { tenantName: 'Sweep Co' });
    const ownWs = await workspace(ctx, owner, 'Sweep');
    const orphanRef = await ingestOrphan(ctx, owner.tenantId, 'orphan left by a failed request');
    expect(orphanRef.size).toBeGreaterThan(0);
    const kept = await createRecord(ctx, owner, ownWs, {
      name: 'Kept',
      file: { content: 'still referenced', name: 'k.txt' },
    });
    const doomed = await createRecord(ctx, owner, ownWs, { name: 'Doomed' });
    expect(await blobCount(owner.tenantId)).toBe(2);
    await as(ctx, owner).delete(`/api/v1/records/${doomed.id}`).expect(204);
    const purged = await as(ctx, owner).delete(`/api/v1/trash/records/${doomed.id}`).expect(200);
    expect(purged.body).toEqual({ records: 1, versions: 1, blobsReleased: 0 });
    expect(await blobCount(owner.tenantId)).toBe(1);
    const content = await as(ctx, owner).get(`/api/v1/records/${kept.id}/content`).expect(200);
    expect(content.text).toBe('still referenced');
  });
});

describe('purge and blob reuse (e2e)', () => {
  let ctx: TestApp;
  let admin: Actor;
  let ws: Workspace;

  beforeAll(async () => {
    ctx = await createTestApp([], { BLOB_REUSE_GRACE_SECONDS: '300' });
    admin = await signUp(ctx, { tenantName: 'Grace Co' });
    ws = await workspace(ctx, admin);
  });

  afterAll(async () => {
    await ctx.stop();
  });

  it('keeps a just-used blob when purging, so a concurrent identical upload never loses its file', async () => {
    const doomed = await createRecord(ctx, admin, ws, {
      file: { content: 'recently used bytes', name: 'r.txt' },
    });
    await as(ctx, admin).delete(`/api/v1/records/${doomed.id}`).expect(204);
    const purged = await as(ctx, admin).delete(`/api/v1/trash/records/${doomed.id}`).expect(200);
    expect(purged.body).toEqual({ records: 1, versions: 1, blobsReleased: 0 });
    expect(await blobCount(admin.tenantId)).toBe(1);

    const again = await createRecord(ctx, admin, ws, {
      file: { content: 'recently used bytes', name: 'again.txt' },
    });
    const content = await as(ctx, admin).get(`/api/v1/records/${again.id}/content`).expect(200);
    expect(content.text).toBe('recently used bytes');
    expect(await blobCount(admin.tenantId)).toBe(1);
  });

  it('keeps an unreferenced blob used within the grace period when a purge sweeps', async () => {
    const before = await blobCount(admin.tenantId);
    await ingestOrphan(ctx, admin.tenantId, 'just uploaded, record not written yet');
    const doomed = await createRecord(ctx, admin, ws, { name: 'Doomed in grace' });
    await as(ctx, admin).delete(`/api/v1/records/${doomed.id}`).expect(204);
    await as(ctx, admin).delete(`/api/v1/trash/records/${doomed.id}`).expect(200);
    expect(await blobCount(admin.tenantId)).toBe(before + 1);
  });

  it('keeps the blob of a refused create within the grace period', async () => {
    const before = await blobCount(admin.tenantId);
    const folderId = (
      await as(ctx, admin)
        .post('/api/v1/folders')
        .send({ name: 'Trashed during a graced upload', parentId: ws.rootId })
        .expect(201)
    ).body.id as string;
    const blobs = ctx.app.get(BlobsService);
    const ingest = blobs.ingest.bind(blobs);
    const spy = vi.spyOn(blobs, 'ingest').mockImplementationOnce(async (tenantId, upload) => {
      await as(ctx, admin).delete(`/api/v1/folders/${folderId}`).expect(204);
      return ingest(tenantId, upload);
    });
    try {
      await as(ctx, admin)
        .post('/api/v1/records')
        .field('name', 'Refused in grace')
        .field('contentTypeId', ws.typeId)
        .field('folderId', folderId)
        .field('metadata', JSON.stringify({ supplier: 'Acme', amount: 1 }))
        .attach('file', Buffer.from('graced bytes of a refused create'), 'g.txt')
        .expect(404);
    } finally {
      spy.mockRestore();
    }
    expect(await blobCount(admin.tenantId)).toBe(before + 1);
  });
});
