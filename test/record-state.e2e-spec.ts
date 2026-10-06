import { getConnectionToken } from '@nestjs/mongoose';
import { Types, type Connection } from 'mongoose';
import type { Principal } from '../src/auth/principal.js';
import { AppError } from '../src/common/errors.js';
import { ContentTypesService } from '../src/content-types/content-types.service.js';
import { RecordState } from '../src/records/record-state.js';
import { RecordsRepository } from '../src/records/records.repository.js';
import type { RecordDocument } from '../src/records/record.schema.js';
import { addMember, as, signUp, type Actor } from './helpers/actors.js';
import { createRecord, workspace, type Workspace, grantRootEdit } from './helpers/fixtures.js';
import { createTestApp, type TestApp } from './helpers/test-app.js';

describe('record state (e2e)', () => {
  let ctx: TestApp;
  let admin: Actor;
  let member: Actor;
  let other: Actor;
  let ws: Workspace;
  let state: RecordState;

  const principal = (actor: Actor): Principal => ({
    userId: actor.userId,
    tenantId: actor.tenantId,
    role: actor.role,
    email: actor.email,
    displayName: actor.displayName,
  });

  beforeAll(async () => {
    ctx = await createTestApp();
    admin = await signUp(ctx, { tenantName: 'State Co' });
    member = await addMember(ctx, admin);
    await grantRootEdit(ctx, admin, member);
    other = await signUp(ctx, { tenantName: 'Other Co' });
    ws = await workspace(ctx, admin);
    state = ctx.app.get(RecordState);
  });

  afterAll(async () => {
    await ctx.stop();
  });

  async function record(name = 'Subject'): Promise<string> {
    return (await createRecord(ctx, admin, ws, { name })).id;
  }

  async function read(id: string): Promise<RecordDocument> {
    return state.requireLive(admin.tenantId, id);
  }

  async function refusal(intent: Promise<unknown>) {
    const error = await intent.then(
      () => null,
      (e: unknown) => e,
    );
    if (!(error instanceof AppError)) throw new Error(`expected a refusal, got ${String(error)}`);
    return { status: error.getStatus(), code: error.code, message: error.message };
  }

  const locked = (holder: Actor) => ({
    status: 409,
    code: 'RECORD_CHECKED_OUT',
    message: `This record is checked out by ${holder.displayName}`,
  });

  describe('a live record nobody holds', () => {
    it('is renamed, retagged and trashed, and each change reports the state it started from', async () => {
      const id = await record('Draft');
      const renamed = await state.rename(principal(member), id, 'Final');
      expect(renamed.before.name).toBe('Draft');
      expect(renamed.after.name).toBe('Final');
      expect(renamed.after.searchText).toContain('final');

      const tagged = await state.retag(principal(member), id, { set: ['a', 'b'] });
      expect(tagged).toMatchObject({ changed: true });
      expect(tagged.after.tags).toEqual(['a', 'b']);
      const changed = await state.retag(principal(member), id, { add: ['c'], remove: ['a'] });
      expect(changed.before.tags).toEqual(['a', 'b']);
      expect(changed.after.tags).toEqual(['b', 'c']);

      const trashed = await state.trash(principal(member), id);
      expect(trashed.after.deletedAt).not.toBeNull();
      expect(trashed.after.trashBatchId).toEqual(expect.any(String));
    });

    it('adds tags to a record stored without a tags field (created before tags existed)', async () => {
      const id = await record();
      const unset = await ctx.app
        .get<Connection>(getConnectionToken())
        .collection('records')
        .updateOne({ _id: new Types.ObjectId(id) }, { $unset: { tags: '' } });
      expect(unset.modifiedCount).toBe(1);
      const tagged = await state.retag(principal(member), id, { add: ['x'], remove: [] });
      expect(tagged.changed).toBe(true);
      expect([...(await read(id)).tags]).toEqual(['x']);
    });

    it('refuses more than 20 tags', async () => {
      const id = await record();
      const add = Array.from({ length: 21 }, (_, n) => `t${n}`);
      expect(await refusal(state.retag(principal(member), id, { add, remove: [] }))).toEqual({
        status: 400,
        code: 'TOO_MANY_TAGS',
        message: 'A record can have at most 20 tags',
      });
    });
  });

  describe('a record in the trash', () => {
    it('refuses every change with 404', async () => {
      const id = await record();
      await state.trash(principal(admin), id);
      const notFound = { status: 404, code: 'NOT_FOUND', message: 'Record not found' };
      const p = principal(admin);
      expect(await refusal(state.requireWritable(p, id))).toEqual(notFound);
      expect(await refusal(state.rename(p, id, 'x'))).toEqual(notFound);
      expect(await refusal(state.retag(p, id, { set: ['x'] }))).toEqual(notFound);
      expect(await refusal(state.retag(p, id, { add: ['x'], remove: [] }))).toEqual(notFound);
      expect(await refusal(state.trash(p, id))).toEqual(notFound);
      expect(await refusal(state.checkOut(p, id))).toEqual(notFound);
      expect(await refusal(state.release(p, id, 'force'))).toEqual(notFound);
    });
  });

  describe('a record checked out by someone else', () => {
    it('refuses rename, retag, trash and writing, and leaves the record as it was', async () => {
      const id = await record('Held');
      await state.checkOut(principal(member), id);
      const p = principal(admin);
      expect(await refusal(state.requireWritable(p, id))).toEqual(locked(member));
      expect(await refusal(state.rename(p, id, 'Taken'))).toEqual(locked(member));
      expect(await refusal(state.retag(p, id, { set: ['x'] }))).toEqual(locked(member));
      expect(await refusal(state.retag(p, id, { add: ['x'], remove: [] }))).toEqual(locked(member));
      expect(await refusal(state.trash(p, id))).toEqual(locked(member));
      expect(await refusal(state.checkOut(p, id))).toEqual(locked(member));
      expect(await refusal(state.release(p, id, 'checkIn'))).toEqual(locked(member));
      const now = await read(id);
      expect(now).toMatchObject({ name: 'Held', deletedAt: null });
      expect([...now.tags]).toEqual([]);
      expect(now.checkedOutBy?.toHexString()).toBe(member.userId);
    });

    it('lets an add-and-remove that changes nothing pass without writing', async () => {
      const id = await record();
      await state.retag(principal(admin), id, { set: ['kept'] });
      await state.checkOut(principal(member), id);
      const writes = vi.spyOn(ctx.app.get(RecordsRepository), 'updateOne');
      let unchanged;
      try {
        unchanged = await state.retag(principal(admin), id, { add: ['kept'], remove: ['gone'] });
        expect(writes).not.toHaveBeenCalled();
      } finally {
        writes.mockRestore();
      }
      expect(unchanged.changed).toBe(false);
      const stored = await read(id);
      expect(stored.updatedAt).toEqual(unchanged.before.updatedAt);
      expect([...stored.tags]).toEqual(['kept']);
    });

    it('is force-released, and the release names the holder it cleared', async () => {
      const id = await record();
      await state.checkOut(principal(member), id);
      const released = await state.release(principal(admin), id, 'force');
      expect(released.before.checkedOutBy?.toHexString()).toBe(member.userId);
      expect(released.after.checkedOutBy).toBeNull();
      expect(await refusal(state.release(principal(admin), id, 'force'))).toEqual({
        status: 409,
        code: 'NOT_CHECKED_OUT',
        message: 'This record is not checked out',
      });
    });
  });

  describe('a record you hold', () => {
    it('stays yours to change, a second check-out changes nothing, and trashing releases it', async () => {
      const id = await record('Mine');
      const me = principal(member);
      expect((await state.checkOut(me, id)).changed).toBe(true);
      const again = await state.checkOut(me, id);
      expect(again.changed).toBe(false);
      expect(again.after.checkedOutBy?.toHexString()).toBe(member.userId);
      await state.rename(me, id, 'Still mine');
      await state.retag(me, id, { add: ['x'], remove: [] });
      const trashed = await state.trash(me, id);
      expect(trashed.after).toMatchObject({ checkedOutBy: null, checkedOutByName: null });
    });
  });

  describe('a version commit', () => {
    async function commit(actor: Actor, read: RecordDocument, comment: string) {
      const type = await ctx.app
        .get(ContentTypesService)
        .require(read.tenantId.toHexString(), read.contentTypeId.toHexString());
      return state.commitVersion(principal(actor), read, type, {
        file: read.file,
        metadata: { ...read.metadata, supplier: comment },
        schemaVersion: read.schemaVersion,
        comment,
        restoredFrom: null,
      });
    }

    async function history(id: string): Promise<number[]> {
      const res = await as(ctx, admin).get(`/api/v1/records/${id}/versions`).expect(200);
      return res.body.map((v: { versionNumber: number }) => v.versionNumber);
    }

    it('moves the current version forward', async () => {
      const id = await record();
      const version = await commit(
        member,
        await state.requireWritable(principal(member), id),
        'v2',
      );
      expect(version.versionNumber).toBe(2);
      expect((await read(id)).currentVersion).toBe(2);
    });

    it('is refused and leaves no version when someone checked the record out after it was read', async () => {
      const id = await record();
      const stale = await state.requireWritable(principal(admin), id);
      await state.checkOut(principal(member), id);
      expect(await refusal(commit(admin, stale, 'late'))).toEqual(locked(member));
      expect(await history(id)).toEqual([1]);
    });

    it('is refused with 404 and leaves no version when the record was trashed after it was read', async () => {
      const id = await record();
      const stale = await state.requireWritable(principal(admin), id);
      await state.trash(principal(member), id);
      expect((await refusal(commit(admin, stale, 'late'))).status).toBe(404);
      await as(ctx, admin).post(`/api/v1/trash/records/${id}/restore`).expect(200);
      expect(await history(id)).toEqual([1]);
    });
  });

  it("never reaches another tenant's record", async () => {
    const id = await record();
    const stranger = principal(other);
    const notFound = { status: 404, code: 'NOT_FOUND', message: 'Record not found' };
    expect(await refusal(state.rename(stranger, id, 'Stolen'))).toEqual(notFound);
    expect(await refusal(state.retag(stranger, id, { set: ['x'] }))).toEqual(notFound);
    expect(await refusal(state.trash(stranger, id))).toEqual(notFound);
    expect(await refusal(state.checkOut(stranger, id))).toEqual(notFound);
    expect(await refusal(state.requireWritable(stranger, id))).toEqual(notFound);
    await state.checkOut(principal(member), id);
    expect(await refusal(state.release(stranger, id, 'checkIn'))).toEqual(notFound);
    expect(await refusal(state.release(stranger, id, 'force'))).toEqual(notFound);
    const own = await read(id);
    const type = await ctx.app
      .get(ContentTypesService)
      .require(admin.tenantId, own.contentTypeId.toHexString());
    const content = {
      file: own.file,
      metadata: own.metadata,
      schemaVersion: own.schemaVersion,
      comment: 'Stolen',
      restoredFrom: null,
    };
    expect(await refusal(state.commitVersion(stranger, own, type, content))).toEqual(notFound);
    const now = await read(id);
    expect(now).toMatchObject({ name: 'Subject', currentVersion: 1 });
    expect(now.checkedOutBy?.toHexString()).toBe(member.userId);
  });
});
