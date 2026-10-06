import { HttpException } from '@nestjs/common';
import { Types } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';
import type { Principal } from '../../auth/principal.js';
import { errors } from '../../common/errors.js';
import type { FieldDefinition } from '../../content-types/field-types.js';
import type { ExecuteContext, PlannedAction } from './proposal.js';
import {
  recordsProposeCheckin,
  recordsProposeCreate,
  recordsProposeMove,
  recordsProposeNewVersion,
  recordsProposeRename,
  recordsProposeSetTags,
  recordsProposeTrash,
} from './records.proposals.js';
import type { ToolServices } from './tool.js';

const RECORD = 'a'.repeat(24);
const OTHER_RECORD = 'b'.repeat(24);
const FOLDER = 'c'.repeat(24);
const TARGET_FOLDER = 'd'.repeat(24);
const TYPE = 'e'.repeat(24);
const PLANNED_FOLDER = 'f'.repeat(24);
const CREATED_FOLDER = '1'.repeat(24);

const principal: Principal = {
  userId: '9'.repeat(24),
  tenantId: '8'.repeat(24),
  role: 'member',
  email: 'member@example.test',
  displayName: 'Member',
};

const FIELDS: FieldDefinition[] = [
  { key: 'supplier', label: 'Supplier', type: 'text', required: true },
  { key: 'amount', label: 'Amount', type: 'number', required: true },
];

function recordDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: new Types.ObjectId(RECORD),
    id: RECORD,
    name: 'Invoice 42',
    currentVersion: 3,
    folderId: new Types.ObjectId(FOLDER),
    checkedOutBy: null as Types.ObjectId | null,
    checkedOutByName: null as string | null,
    tags: ['old'],
    metadata: { supplier: 'Acme', amount: 10 } as Record<string, unknown>,
    ...overrides,
  };
}

function fakeServices(doc = recordDoc()) {
  const view = (id: string, name = doc.name) => ({ id, name, folderName: 'Finance' });
  return {
    access: {
      requireRecord: vi.fn(async (_p: Principal, id: string) => ({
        ...doc,
        id,
        _id: new Types.ObjectId(id),
      })),
      requireFolder: vi.fn(async (_p: Principal, id: string) => ({
        _id: new Types.ObjectId(id),
        id,
      })),
    },
    records: {
      get: vi.fn(async (_p: Principal, id: string) => ({
        record: { id, name: doc.name, metadata: doc.metadata, file: null },
        contentType: { fields: FIELDS },
        breadcrumbs: [
          { id: 'r', name: 'Repository' },
          { id: FOLDER, name: 'Finance' },
        ],
      })),
      create: vi.fn(async (_p: Principal, input: { name: string }) => view(RECORD, input.name)),
      rename: vi.fn(async (_p: Principal, id: string, input: { name: string }) =>
        view(id, input.name),
      ),
      move: vi.fn(async (_p: Principal, id: string) => view(id)),
      changeTags: vi.fn(async (_p: Principal, id: string) => view(id)),
      addVersion: vi.fn(async () => ({ versionNumber: 4 })),
      getVersion: vi.fn(async () => ({ versionNumber: 1 })),
      restoreVersion: vi.fn(async () => ({ versionNumber: 4 })),
      checkOut: vi.fn(async (_p: Principal, id: string) => view(id)),
      checkIn: vi.fn(async (_p: Principal, id: string) => view(id)),
    },
    folders: {
      get: vi.fn(async (_p: Principal, id: string) => ({
        breadcrumbs: [
          { id: 'r', name: 'Repository' },
          { id, name: id === TARGET_FOLDER ? 'Archive' : 'Finance' },
        ],
      })),
    },
    contentTypes: {
      get: vi.fn(async () => ({
        id: TYPE,
        name: 'Invoice',
        status: 'active',
        fields: FIELDS,
        schemaVersion: 2,
      })),
    },
    trash: { trashRecord: vi.fn(async () => undefined) },
    bulk: {
      trashRecords: vi.fn(async (_p: Principal, ids: string[]) => ({
        succeeded: ids.length,
        failed: 0,
        results: ids.map((id) => ({ id, ok: true })),
      })),
    },
  };
}

type Fakes = ReturnType<typeof fakeServices>;

const checkCtx = (services: Fakes, planned: PlannedAction[] = []) => ({
  principal,
  services: services as unknown as ToolServices,
  planned: (id: string) => planned.find((action) => action.id === id) ?? null,
});

const executeCtx = (services: Fakes, resolved: Record<string, string> = {}): ExecuteContext => ({
  principal,
  services: services as unknown as ToolServices,
  file: null,
  resolved: (id) => resolved[id] as string,
});

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HttpException) return (error.getResponse() as { code: string }).code;
    throw error;
  }
  throw new Error('expected a refusal');
}

const writes = (services: Fakes) => [
  services.records.create,
  services.records.rename,
  services.records.move,
  services.records.changeTags,
  services.records.addVersion,
  services.records.restoreVersion,
  services.records.checkOut,
  services.records.checkIn,
  services.trash.trashRecord,
  services.bulk.trashRecords,
];

describe('records_propose_rename', () => {
  it('checks edit access, stores the new name and the name it was built on, and writes nothing', async () => {
    const services = fakeServices();
    const preview = await recordsProposeRename.check(checkCtx(services), {
      id: RECORD,
      name: '  Invoice 43 ',
    });
    expect(services.access.requireRecord).toHaveBeenCalledWith(principal, RECORD, 'edit');
    expect(preview).toMatchObject({
      args: { id: RECORD, name: 'Invoice 43' },
      base: { name: 'Invoice 42' },
      changes: [{ label: 'Name', before: 'Invoice 42', after: 'Invoice 43' }],
      summary: 'Repository / Finance',
      targets: { records: [RECORD], folders: [] },
      destructive: false,
      reviewEach: false,
    });
    for (const write of writes(services)) expect(write).not.toHaveBeenCalled();
  });

  it('refuses a record someone else holds, and a rename that changes nothing', async () => {
    const held = fakeServices(
      recordDoc({ checkedOutBy: new Types.ObjectId('7'.repeat(24)), checkedOutByName: 'Bob' }),
    );
    expect(
      await codeOf(recordsProposeRename.check(checkCtx(held), { id: RECORD, name: 'New' })),
    ).toBe('RECORD_CHECKED_OUT');
    expect(
      await codeOf(
        recordsProposeRename.check(checkCtx(fakeServices()), { id: RECORD, name: 'Invoice 42' }),
      ),
    ).toBe('NOTHING_TO_CHANGE');
  });

  it('confirms through RecordsService.rename, and refuses ACTION_STALE once the name moved', async () => {
    const services = fakeServices();
    const done = await recordsProposeRename.execute(
      executeCtx(services),
      { id: RECORD, name: 'Invoice 43' },
      { name: 'Invoice 42' },
    );
    expect(services.records.rename).toHaveBeenCalledWith(principal, RECORD, { name: 'Invoice 43' });
    expect(done).toMatchObject({
      status: 'done',
      result: {
        resourceType: 'record',
        id: RECORD,
        name: 'Invoice 43',
        link: `/records/${RECORD}`,
      },
      resource: { type: 'record', id: RECORD },
    });

    const moved = fakeServices(recordDoc({ name: 'Renamed by Bob' }));
    expect(
      await codeOf(
        recordsProposeRename.execute(
          executeCtx(moved),
          { id: RECORD, name: 'Invoice 43' },
          { name: 'Invoice 42' },
        ),
      ),
    ).toBe('ACTION_STALE');
    expect(moved.records.rename).not.toHaveBeenCalled();
  });

  it('passes a service refusal through unchanged', async () => {
    const services = fakeServices();
    services.records.rename.mockRejectedValueOnce(
      errors.conflict('RECORD_CHECKED_OUT', 'This record is checked out by Bob'),
    );
    expect(
      await codeOf(
        recordsProposeRename.execute(executeCtx(services), { id: RECORD, name: 'X' }, null),
      ),
    ).toBe('RECORD_CHECKED_OUT');
  });
});

describe('records_propose_new_version', () => {
  it('stores only the changed keys and the version it was built on', async () => {
    const services = fakeServices();
    const preview = await recordsProposeNewVersion.check(checkCtx(services), {
      id: RECORD,
      metadata: [{ key: 'amount', value: '12' }],
      comment: null,
      withFile: null,
    });
    expect(preview).toMatchObject({
      args: { id: RECORD, metadata: { amount: 12 }, comment: '' },
      base: { versionNumber: 3 },
      changes: [{ label: 'Amount', before: '10', after: '12' }],
      needsFile: false,
    });
  });

  it('needs changed metadata or a file', async () => {
    expect(
      await codeOf(
        recordsProposeNewVersion.check(checkCtx(fakeServices()), {
          id: RECORD,
          metadata: [{ key: 'amount', value: '10' }],
          comment: null,
          withFile: false,
        }),
      ),
    ).toBe('NOTHING_TO_VERSION');
    const withFile = await recordsProposeNewVersion.check(checkCtx(fakeServices()), {
      id: RECORD,
      metadata: null,
      comment: 'scan',
      withFile: true,
    });
    expect(withFile).toMatchObject({ needsFile: true, args: { metadata: {} } });
  });

  it('merges the delta into the metadata as it is now, and refuses a moved version', async () => {
    const services = fakeServices(recordDoc({ metadata: { supplier: 'Acme Ltd', amount: 10 } }));
    await recordsProposeNewVersion.execute(
      executeCtx(services),
      { id: RECORD, metadata: { amount: 12 }, comment: '' },
      { versionNumber: 3 },
    );
    expect(services.records.addVersion).toHaveBeenCalledWith(
      principal,
      RECORD,
      { metadata: { supplier: 'Acme Ltd', amount: 12 }, comment: '' },
      null,
    );

    const newer = fakeServices(recordDoc({ currentVersion: 4 }));
    expect(
      await codeOf(
        recordsProposeNewVersion.execute(
          executeCtx(newer),
          { id: RECORD, metadata: { amount: 12 }, comment: '' },
          { versionNumber: 3 },
        ),
      ),
    ).toBe('ACTION_STALE');
    expect(newer.records.addVersion).not.toHaveBeenCalled();
  });
});

describe('records_propose_set_tags', () => {
  it('stores a relative change and confirms it through RecordsService.changeTags', async () => {
    const services = fakeServices();
    const preview = await recordsProposeSetTags.check(checkCtx(services), {
      id: RECORD,
      add: ['New Tag'],
      remove: ['old'],
    });
    expect(preview).toMatchObject({
      args: { id: RECORD, add: ['new tag'], remove: ['old'] },
      base: null,
      changes: [{ label: 'Tags', before: 'old', after: 'new tag' }],
    });
    await recordsProposeSetTags.execute(executeCtx(services), preview.args, null);
    expect(services.records.changeTags).toHaveBeenCalledWith(principal, RECORD, {
      add: ['new tag'],
      remove: ['old'],
    });
  });
});

describe('records_propose_move', () => {
  it('is reviewed on its own, and stale once the record left its folder', async () => {
    const services = fakeServices();
    const preview = await recordsProposeMove.check(checkCtx(services), {
      id: RECORD,
      folderId: TARGET_FOLDER,
    });
    expect(preview).toMatchObject({
      reviewEach: true,
      base: { folderId: FOLDER },
      changes: [{ label: 'Folder', before: 'Repository / Finance', after: 'Repository / Archive' }],
      targets: { records: [RECORD], folders: [TARGET_FOLDER] },
    });
    expect(services.access.requireFolder).toHaveBeenCalledWith(principal, TARGET_FOLDER, 'edit');
    expect(
      await codeOf(recordsProposeMove.check(checkCtx(services), { id: RECORD, folderId: FOLDER })),
    ).toBe('NOTHING_TO_CHANGE');

    const elsewhere = fakeServices(recordDoc({ folderId: new Types.ObjectId(TARGET_FOLDER) }));
    expect(
      await codeOf(
        recordsProposeMove.execute(
          executeCtx(elsewhere),
          { id: RECORD, folderId: TARGET_FOLDER },
          { folderId: FOLDER },
        ),
      ),
    ).toBe('ACTION_STALE');
  });
});

describe('records_propose_checkin', () => {
  it('refuses a record that is not checked out', async () => {
    expect(
      await codeOf(recordsProposeCheckin.check(checkCtx(fakeServices()), { id: RECORD })),
    ).toBe('NOT_CHECKED_OUT');
  });
});

describe('records_propose_trash', () => {
  it('is destructive and lists every target with its path', async () => {
    const preview = await recordsProposeTrash.check(checkCtx(fakeServices()), {
      ids: [RECORD, OTHER_RECORD, RECORD],
    });
    expect(preview).toMatchObject({
      destructive: true,
      args: { ids: [RECORD, OTHER_RECORD] },
      title: 'Move 2 records to the trash',
      changes: [
        { label: 'Invoice 42', before: 'Repository / Finance', after: 'Trash' },
        { label: 'Invoice 42', before: 'Repository / Finance', after: 'Trash' },
      ],
    });
  });

  it('trashes one record through TrashService.trashRecord', async () => {
    const services = fakeServices();
    const done = await recordsProposeTrash.execute(executeCtx(services), { ids: [RECORD] }, null);
    expect(services.trash.trashRecord).toHaveBeenCalledWith(principal, RECORD);
    expect(services.bulk.trashRecords).not.toHaveBeenCalled();
    expect(done).toMatchObject({ status: 'done', result: { id: RECORD, link: null } });
  });

  it('trashes several through BulkService.trashRecords, with refused ids as failed items', async () => {
    const services = fakeServices();
    services.access.requireRecord.mockImplementation(async (_p: Principal, id: string) => {
      if (id === OTHER_RECORD) throw errors.notFound('Record');
      return { ...recordDoc(), id, _id: new Types.ObjectId(id) };
    });
    const done = await recordsProposeTrash.execute(
      executeCtx(services),
      { ids: [RECORD, OTHER_RECORD] },
      null,
    );
    expect(services.bulk.trashRecords).toHaveBeenCalledWith(principal, [RECORD]);
    expect(done).toMatchObject({
      status: 'partial',
      result: {
        resourceType: 'records',
        count: 1,
        failed: [{ id: OTHER_RECORD, code: 'NOT_FOUND' }],
      },
    });
  });
});

describe('records_propose_create', () => {
  const plannedFolder: PlannedAction = {
    id: PLANNED_FOLDER,
    tool: 'folders_propose_create',
    step: 1,
    args: {},
    creates: 'Repository / 2026',
  };

  it('validates the metadata against the live type and refers to a planned folder by Ref', async () => {
    const services = fakeServices();
    const preview = await recordsProposeCreate.check(checkCtx(services, [plannedFolder]), {
      name: 'Invoice 50',
      contentTypeId: TYPE,
      contentTypeRef: null,
      folderId: null,
      folderRef: PLANNED_FOLDER,
      metadata: [
        { key: 'supplier', value: 'Acme' },
        { key: 'amount', value: '50' },
      ],
      tags: null,
      comment: null,
      withFile: true,
    });
    expect(preview).toMatchObject({
      args: {
        name: 'Invoice 50',
        contentTypeId: TYPE,
        folderId: null,
        folderRef: PLANNED_FOLDER,
        metadata: { supplier: 'Acme', amount: 50 },
      },
      base: { schemaVersion: 2 },
      summary: 'A Invoice in Repository / 2026',
      targets: { records: [], folders: [] },
      refs: [PLANNED_FOLDER],
      needsFile: true,
    });
    expect(services.access.requireFolder).not.toHaveBeenCalled();
    expect(services.records.create).not.toHaveBeenCalled();
  });

  it('refuses missing required metadata with VALIDATION_FAILED, and an unknown Ref', async () => {
    const input = {
      name: 'Invoice 51',
      contentTypeId: TYPE,
      contentTypeRef: null,
      folderId: FOLDER,
      folderRef: null,
      metadata: [{ key: 'supplier', value: 'Acme' }],
      tags: null,
      comment: null,
      withFile: null,
    };
    expect(await codeOf(recordsProposeCreate.check(checkCtx(fakeServices()), input))).toBe(
      'VALIDATION_FAILED',
    );
    expect(
      await codeOf(
        recordsProposeCreate.check(checkCtx(fakeServices()), {
          ...input,
          folderId: null,
          folderRef: PLANNED_FOLDER,
          metadata: [
            { key: 'supplier', value: 'Acme' },
            { key: 'amount', value: '1' },
          ],
        }),
      ),
    ).toBe('INVALID_REF');
  });

  it('resolves the Ref to the created folder and calls RecordsService.create', async () => {
    const services = fakeServices();
    const args = {
      name: 'Invoice 50',
      contentTypeId: TYPE,
      contentTypeRef: null,
      folderId: null,
      folderRef: PLANNED_FOLDER,
      metadata: { supplier: 'Acme', amount: 50 },
      tags: [],
      comment: '',
    };
    await recordsProposeCreate.execute(
      executeCtx(services, { [PLANNED_FOLDER]: CREATED_FOLDER }),
      args,
      { schemaVersion: 2 },
    );
    expect(services.access.requireFolder).toHaveBeenCalledWith(principal, CREATED_FOLDER, 'edit');
    expect(services.records.create).toHaveBeenCalledWith(
      principal,
      expect.objectContaining({ folderId: CREATED_FOLDER, contentTypeId: TYPE }),
      null,
    );
    expect(
      await codeOf(
        recordsProposeCreate.execute(
          executeCtx(services, { [PLANNED_FOLDER]: CREATED_FOLDER }),
          args,
          { schemaVersion: 1 },
        ),
      ),
    ).toBe('ACTION_STALE');
  });
});

describe('proposal details', () => {
  it('shows a comment the model set as a Comment row', async () => {
    const preview = await recordsProposeNewVersion.check(checkCtx(fakeServices()), {
      id: RECORD,
      metadata: [{ key: 'amount', value: '11' }],
      comment: 'Fixed the total',
      withFile: null,
    });
    expect(preview.changes).toContainEqual({
      label: 'Comment',
      before: null,
      after: 'Fixed the total',
    });
  });

  it('writes back only keys of the type as it is now', async () => {
    const services = fakeServices();
    await recordsProposeNewVersion.execute(
      executeCtx(services),
      { id: RECORD, metadata: { amount: 12, removedField: 'x' }, comment: '' },
      { versionNumber: 3 },
    );
    expect(services.records.addVersion).toHaveBeenCalledWith(
      principal,
      RECORD,
      { metadata: { supplier: 'Acme', amount: 12 }, comment: '' },
      null,
    );
  });

  it('counts the folder, never the content type, as a create target', async () => {
    const preview = await recordsProposeCreate.check(checkCtx(fakeServices()), {
      name: 'Invoice 60',
      contentTypeId: TYPE,
      contentTypeRef: null,
      folderId: FOLDER,
      folderRef: null,
      metadata: [
        { key: 'supplier', value: 'Acme' },
        { key: 'amount', value: '1' },
      ],
      tags: null,
      comment: null,
      withFile: null,
    });
    expect(preview.targets).toEqual({ records: [], folders: [FOLDER] });
  });

  it('puts the trashed record ids into the bulk audit context', async () => {
    const done = await recordsProposeTrash.execute(
      executeCtx(fakeServices()),
      { ids: [RECORD, OTHER_RECORD] },
      null,
    );
    expect(done.auditContext).toEqual({ recordIds: [RECORD, OTHER_RECORD] });
  });

  it('re-validates stored arguments with their own bounds', () => {
    expect(recordsProposeCreate.stored.safeParse({ name: 'x'.repeat(201) }).success).toBe(false);
    const parsed = recordsProposeNewVersion.stored.parse({ id: RECORD, comment: '' });
    expect(parsed).toEqual({ id: RECORD, metadata: {}, comment: '' });
  });
});
