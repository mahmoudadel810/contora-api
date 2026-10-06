import { HttpException } from '@nestjs/common';
import { z } from 'zod';
import { can } from '../../authorization/policy.js';
import { toErrorBody } from '../../common/app-exception.filter.js';
import { errors } from '../../common/errors.js';
import { parseWith } from '../../common/zod.pipe.js';
import type { FieldDefinition } from '../../content-types/field-types.js';
import { validateMetadata } from '../../records/metadata.js';
import {
  CreateRecordSchema,
  MoveRecordSchema,
  NewVersionSchema,
  RenameRecordSchema,
  RestoreVersionSchema,
  TagSchema,
} from '../../records/records.dto.js';
import type { Change } from '../blocks.js';
import { recordLink } from '../links.js';
import {
  assertBase,
  assertNotHeldByOther,
  changesMetadata,
  defineProposal,
  idOrRef,
  mergeMetadata,
  metadataDelta,
  MetadataPairsSchema,
  nothingToChange,
  StoredCommentSchema,
  StoredMetadataSchema,
  StoredNameSchema,
  pathOf,
  plannedRef,
  shown,
  type BulkResult,
  type CheckContext,
  type ExecuteContext,
  type Proposal,
} from './proposal.js';
import { valueText } from './records.tools.js';
import { objectId } from './search.tools.js';

export const MAX_TRASH_IDS = 50;
const REF_PLACEHOLDER = '0'.repeat(24);

const MAX_TAGS = 20;

export const TagChangeSchema = z
  .object({
    add: z.array(TagSchema).max(MAX_TAGS),
    remove: z.array(TagSchema).max(MAX_TAGS),
  })
  .strict();

const recordResult = (id: string, name: string) => ({
  resourceType: 'record',
  id,
  name,
  link: recordLink(id),
});

async function editableRecord(ctx: CheckContext | ExecuteContext, id: string) {
  const record = await ctx.services.access.requireRecord(ctx.principal, id, 'edit');
  const detail = await ctx.services.records.get(ctx.principal, id);
  return { record, detail, path: pathOf(detail.breadcrumbs) };
}

function fieldLabel(fields: readonly FieldDefinition[], key: string): string {
  return fields.find((field) => field.key === key)?.label ?? key;
}

function metadataRows(
  fields: readonly FieldDefinition[],
  keys: string[],
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Change[] {
  return keys.map((key) => ({
    label: fieldLabel(fields, key),
    before: shown(Object.hasOwn(before, key) ? valueText(before[key]) : null),
    after: shown(Object.hasOwn(after, key) ? valueText(after[key]) : null),
  }));
}

const FILE_AT_CONFIRM = 'Chosen when you confirm';

function commentRows(comment: string): Change[] {
  return comment.trim() === '' ? [] : [{ label: 'Comment', before: null, after: comment }];
}

const CreateStored = z
  .object({
    name: StoredNameSchema,
    contentTypeId: objectId.nullable(),
    contentTypeRef: objectId.nullable(),
    folderId: objectId.nullable(),
    folderRef: objectId.nullable(),
    metadata: StoredMetadataSchema,
    tags: z.array(TagSchema).max(MAX_TAGS),
    comment: StoredCommentSchema,
  })
  .strict();

export const recordsProposeCreate = defineProposal({
  tool: 'records_propose_create',
  domain: 'records',
  confirmLabel: 'create',
  description:
    'Prepare a new record for the user to confirm (nothing is created until they do). Give contentTypeId or contentTypeRef, and folderId or folderRef (a Ref is the actionId of an earlier proposal in this answer that creates it). metadata is [{key, value}] with field keys and text values; ask the user for missing required fields instead of guessing. withFile: true when the user wants to attach a file (they pick it on the card).',
  input: z
    .object({
      name: z.string().min(1).max(200),
      contentTypeId: objectId.nullable(),
      contentTypeRef: objectId.nullable(),
      folderId: objectId.nullable(),
      folderRef: objectId.nullable(),
      metadata: MetadataPairsSchema,
      tags: z.array(z.string().max(40)).max(MAX_TAGS).nullable(),
      comment: z.string().max(500).nullable(),
      withFile: z.boolean().nullable(),
    })
    .strict(),
  stored: CreateStored,
  async check(ctx, input) {
    if (!can(ctx.principal, 'records.write')) throw errors.forbidden();
    const type = idOrRef(
      'contentTypeId',
      'contentTypeRef',
      input.contentTypeId,
      input.contentTypeRef,
    );
    const place = idOrRef('folderId', 'folderRef', input.folderId, input.folderRef);

    let fields: FieldDefinition[];
    let typeName: string;
    let schemaVersion: number | null = null;
    if (type.id !== null) {
      const view = await ctx.services.contentTypes.get(ctx.principal, type.id);
      if (view.status === 'archived') {
        throw errors.conflict(
          'CONTENT_TYPE_ARCHIVED',
          'Archived content types do not accept new records',
        );
      }
      fields = view.fields;
      typeName = view.name;
      schemaVersion = view.schemaVersion;
    } else {
      const planned = plannedRef(ctx, type.ref, ['schema_propose_create_type']);
      fields = (planned.args as { fields: FieldDefinition[] }).fields;
      typeName = planned.creates ?? 'the new content type';
    }

    let path: string;
    if (place.id !== null) {
      await ctx.services.access.requireFolder(ctx.principal, place.id, 'edit');
      path = pathOf((await ctx.services.folders.get(ctx.principal, place.id)).breadcrumbs);
    } else {
      path = plannedRef(ctx, place.ref, ['folders_propose_create']).creates ?? 'the new folder';
    }

    const delta = metadataDelta(fields, input.metadata);
    const values = mergeMetadata({}, delta);
    const parsed = parseWith(CreateRecordSchema, {
      name: input.name,
      contentTypeId: type.id ?? REF_PLACEHOLDER,
      folderId: place.id ?? REF_PLACEHOLDER,
      metadata: values,
      comment: input.comment ?? '',
      tags: input.tags ?? [],
    });
    const metadata = validateMetadata(fields, values);
    const needsFile = input.withFile === true;
    return {
      args: {
        name: parsed.name,
        contentTypeId: type.id,
        contentTypeRef: type.ref,
        folderId: place.id,
        folderRef: place.ref,
        metadata: values,
        tags: parsed.tags,
        comment: parsed.comment,
      },
      base: schemaVersion === null ? null : { schemaVersion },
      title: `Create record “${parsed.name}”`,
      summary: `A ${typeName} in ${path}`,
      changes: [
        { label: 'Name', before: null, after: parsed.name },
        { label: 'Content type', before: null, after: typeName },
        { label: 'Folder', before: null, after: path },
        ...metadataRows(fields, Object.keys(metadata), {}, metadata),
        ...(parsed.tags.length > 0
          ? [{ label: 'Tags', before: null, after: parsed.tags.join(', ') }]
          : []),
        ...(needsFile ? [{ label: 'File', before: null, after: FILE_AT_CONFIRM }] : []),
        ...commentRows(parsed.comment),
      ],
      targets: { records: [], folders: place.id === null ? [] : [place.id] },
      refs: [type.ref, place.ref].filter((id): id is string => id !== null),
      destructive: false,
      reviewEach: false,
      needsFile,
      creates: parsed.name,
    };
  },
  async execute(ctx, args, base) {
    const contentTypeId = args.contentTypeId ?? ctx.resolved(args.contentTypeRef as string);
    const folderId = args.folderId ?? ctx.resolved(args.folderRef as string);
    if (args.contentTypeId !== null) {
      const type = await ctx.services.contentTypes.get(ctx.principal, contentTypeId);
      assertBase(base, 'schemaVersion', type.schemaVersion);
    }
    await ctx.services.access.requireFolder(ctx.principal, folderId, 'edit');
    const input = parseWith(CreateRecordSchema, {
      name: args.name,
      contentTypeId,
      folderId,
      metadata: args.metadata,
      comment: args.comment,
      tags: args.tags,
    });
    const record = await ctx.services.records.create(ctx.principal, input, ctx.file);
    return {
      status: 'done',
      result: recordResult(record.id, record.name),
      resource: { type: 'record', id: record.id, label: record.name },
      note: `✓ Created record “${record.name}”`,
    };
  },
});

const NewVersionStored = z
  .object({
    id: objectId,
    metadata: StoredMetadataSchema,
    comment: StoredCommentSchema,
  })
  .strict();

export const recordsProposeNewVersion = defineProposal({
  tool: 'records_propose_new_version',
  domain: 'records',
  confirmLabel: 'update',
  description:
    'Prepare a new version of a record: changed metadata values ([{key, value}], null or empty clears a field) and/or a new file (withFile: true; the user picks it on the card). Only the fields you name change.',
  input: z
    .object({
      id: objectId,
      metadata: MetadataPairsSchema,
      comment: z.string().max(500).nullable(),
      withFile: z.boolean().nullable(),
    })
    .strict(),
  stored: NewVersionStored,
  async check(ctx, input) {
    const { record, detail, path } = await editableRecord(ctx, input.id);
    assertNotHeldByOther(ctx.principal, record);
    const fields = detail.contentType.fields;
    const current = detail.record.metadata;
    const delta = metadataDelta(fields, input.metadata);
    const needsFile = input.withFile === true;
    const changed = changesMetadata(current, delta);
    if (!changed && !needsFile) {
      throw errors.badRequest(
        'NOTHING_TO_VERSION',
        'Upload a file or change the metadata to create a version',
      );
    }
    const merged = mergeMetadata(current, delta);
    const parsedBody = parseWith(NewVersionSchema, {
      ...(changed ? { metadata: merged } : {}),
      comment: input.comment ?? '',
    });
    const after = changed ? validateMetadata(fields, merged) : current;
    return {
      args: { id: input.id, metadata: changed ? delta : {}, comment: parsedBody.comment },
      base: { versionNumber: record.currentVersion },
      title: `New version of “${record.name}”`,
      summary: `Version ${record.currentVersion + 1} · ${path}`,
      changes: [
        ...metadataRows(fields, changed ? Object.keys(delta) : [], current, after),
        ...(needsFile
          ? [{ label: 'File', before: shown(detail.record.file?.fileName), after: FILE_AT_CONFIRM }]
          : []),
        ...commentRows(parsedBody.comment),
      ],
      targets: { records: [input.id], folders: [] },
      refs: [],
      destructive: false,
      reviewEach: false,
      needsFile,
    };
  },
  async execute(ctx, args, base) {
    const record = await ctx.services.access.requireRecord(ctx.principal, args.id, 'edit');
    assertBase(base, 'versionNumber', record.currentVersion);
    const fields = (await ctx.services.records.get(ctx.principal, args.id)).contentType.fields;
    const known = new Set(fields.map((field) => field.key));
    const delta = Object.fromEntries(
      Object.entries(args.metadata).filter(([key]) => known.has(key)),
    );
    const changed = Object.keys(delta).length > 0;
    const input = parseWith(NewVersionSchema, {
      ...(changed ? { metadata: mergeMetadata({ ...record.metadata }, delta) } : {}),
      comment: args.comment,
    });
    const version = await ctx.services.records.addVersion(ctx.principal, args.id, input, ctx.file);
    return {
      status: 'done',
      result: recordResult(args.id, record.name),
      resource: { type: 'record', id: args.id, label: record.name },
      note: `✓ Added version ${version.versionNumber} to “${record.name}”`,
    };
  },
});

export const recordsProposeRename = defineProposal({
  tool: 'records_propose_rename',
  domain: 'records',
  confirmLabel: 'update',
  description: 'Prepare renaming one record.',
  input: z.object({ id: objectId, name: z.string().min(1).max(200) }).strict(),
  stored: z.object({ id: objectId, name: StoredNameSchema }).strict(),
  async check(ctx, input) {
    const { record, path } = await editableRecord(ctx, input.id);
    assertNotHeldByOther(ctx.principal, record);
    const { name } = parseWith(RenameRecordSchema, { name: input.name });
    if (name === record.name) throw nothingToChange('The record already has this name');
    return {
      args: { id: input.id, name },
      base: { name: record.name },
      title: `Rename “${record.name}”`,
      summary: path,
      changes: [{ label: 'Name', before: record.name, after: name }],
      targets: { records: [input.id], folders: [] },
      refs: [],
      destructive: false,
      reviewEach: false,
      needsFile: false,
    };
  },
  async execute(ctx, args, base) {
    const record = await ctx.services.access.requireRecord(ctx.principal, args.id, 'edit');
    assertBase(base, 'name', record.name);
    const view = await ctx.services.records.rename(
      ctx.principal,
      args.id,
      parseWith(RenameRecordSchema, { name: args.name }),
    );
    return {
      status: 'done',
      result: recordResult(view.id, view.name),
      resource: { type: 'record', id: view.id, label: view.name },
      note: `✓ Renamed “${record.name}” to “${view.name}”`,
    };
  },
});

export const recordsProposeMove = defineProposal({
  tool: 'records_propose_move',
  domain: 'records',
  confirmLabel: 'move',
  description: 'Prepare moving one record to another folder (the user confirms each move).',
  input: z.object({ id: objectId, folderId: objectId }).strict(),
  stored: z.object({ id: objectId, folderId: objectId }).strict(),
  async check(ctx, input) {
    const { record, path } = await editableRecord(ctx, input.id);
    await ctx.services.access.requireFolder(ctx.principal, input.folderId, 'edit');
    if (record.folderId.toHexString() === input.folderId) {
      throw nothingToChange('The record is already in this folder');
    }
    const target = pathOf(
      (await ctx.services.folders.get(ctx.principal, input.folderId)).breadcrumbs,
    );
    return {
      args: { id: input.id, folderId: input.folderId },
      base: { folderId: record.folderId.toHexString() },
      title: `Move “${record.name}”`,
      summary: `To ${target}`,
      changes: [{ label: 'Folder', before: path, after: target }],
      targets: { records: [input.id], folders: [input.folderId] },
      refs: [],
      destructive: false,
      reviewEach: true,
      needsFile: false,
    };
  },
  async execute(ctx, args, base) {
    const record = await ctx.services.access.requireRecord(ctx.principal, args.id, 'edit');
    assertBase(base, 'folderId', record.folderId.toHexString());
    await ctx.services.access.requireFolder(ctx.principal, args.folderId, 'edit');
    const view = await ctx.services.records.move(
      ctx.principal,
      args.id,
      parseWith(MoveRecordSchema, { folderId: args.folderId }),
    );
    return {
      status: 'done',
      result: recordResult(view.id, view.name),
      resource: { type: 'record', id: view.id, label: view.name },
      note: `✓ Moved “${view.name}”${view.folderName ? ` to ${view.folderName}` : ''}`,
    };
  },
});

export function applyTagChange(current: string[], change: { add: string[]; remove: string[] }) {
  return [
    ...new Set([...current.filter((tag) => !change.remove.includes(tag)), ...change.add]),
  ].sort();
}

export const recordsProposeSetTags = defineProposal({
  tool: 'records_propose_set_tags',
  domain: 'records',
  confirmLabel: 'update',
  description:
    'Prepare adding and/or removing tags on one record (relative: other tags stay). Tags are lowercase letters, digits, spaces, dashes and underscores.',
  input: z
    .object({
      id: objectId,
      add: z.array(z.string().max(40)).max(MAX_TAGS).nullable(),
      remove: z.array(z.string().max(40)).max(MAX_TAGS).nullable(),
    })
    .strict(),
  stored: TagChangeSchema.extend({ id: objectId }),
  async check(ctx, input) {
    const { record, path } = await editableRecord(ctx, input.id);
    assertNotHeldByOther(ctx.principal, record);
    const change = parseWith(TagChangeSchema, { add: input.add ?? [], remove: input.remove ?? [] });
    const before = [...(record.tags ?? [])].sort();
    const after = applyTagChange(before, change);
    if (after.join('\u0000') === before.join('\u0000')) {
      throw nothingToChange('The record already has exactly these tags');
    }
    if (after.length > MAX_TAGS) {
      throw errors.badRequest('TOO_MANY_TAGS', `A record can have at most ${MAX_TAGS} tags`);
    }
    return {
      args: { id: input.id, ...change },
      base: null,
      title: `Change the tags of “${record.name}”`,
      summary: path,
      changes: [
        { label: 'Tags', before: shown(before.join(', ')), after: shown(after.join(', ')) },
      ],
      targets: { records: [input.id], folders: [] },
      refs: [],
      destructive: false,
      reviewEach: false,
      needsFile: false,
    };
  },
  async execute(ctx, args) {
    const { id, ...change } = args;
    await ctx.services.access.requireRecord(ctx.principal, id, 'edit');
    const view = await ctx.services.records.changeTags(
      ctx.principal,
      id,
      parseWith(TagChangeSchema, change),
    );
    return {
      status: 'done',
      result: recordResult(view.id, view.name),
      resource: { type: 'record', id: view.id, label: view.name },
      note: `✓ Changed the tags of “${view.name}”`,
    };
  },
});

export const recordsProposeRestoreVersion = defineProposal({
  tool: 'records_propose_restore_version',
  domain: 'records',
  confirmLabel: 'update',
  description:
    'Prepare restoring an earlier version of a record (it becomes a new version; history stays).',
  input: z
    .object({
      id: objectId,
      versionNumber: z.number().int().positive(),
      comment: z.string().max(500).nullable(),
    })
    .strict(),
  stored: z
    .object({
      id: objectId,
      versionNumber: z.number().int().positive(),
      comment: StoredCommentSchema.nullable(),
    })
    .strict(),
  async check(ctx, input) {
    const { record, path } = await editableRecord(ctx, input.id);
    assertNotHeldByOther(ctx.principal, record);
    await ctx.services.records.getVersion(ctx.principal, input.id, input.versionNumber);
    const body = parseWith(RestoreVersionSchema, input.comment ? { comment: input.comment } : {});
    return {
      args: { id: input.id, versionNumber: input.versionNumber, comment: body.comment ?? null },
      base: { versionNumber: record.currentVersion },
      title: `Restore version ${input.versionNumber} of “${record.name}”`,
      summary: path,
      changes: [
        {
          label: 'Current version',
          before: `Version ${record.currentVersion}`,
          after: `Version ${record.currentVersion + 1}, a copy of version ${input.versionNumber}`,
        },
        ...commentRows(body.comment ?? ''),
      ],
      targets: { records: [input.id], folders: [] },
      refs: [],
      destructive: false,
      reviewEach: false,
      needsFile: false,
    };
  },
  async execute(ctx, args, base) {
    const record = await ctx.services.access.requireRecord(ctx.principal, args.id, 'edit');
    assertBase(base, 'versionNumber', record.currentVersion);
    const version = await ctx.services.records.restoreVersion(
      ctx.principal,
      args.id,
      args.versionNumber,
      parseWith(RestoreVersionSchema, args.comment ? { comment: args.comment } : {}),
    );
    return {
      status: 'done',
      result: recordResult(args.id, record.name),
      resource: { type: 'record', id: args.id, label: record.name },
      note: `✓ Restored version ${args.versionNumber} of “${record.name}” as version ${version.versionNumber}`,
    };
  },
});

const IdOnly = z.object({ id: objectId }).strict();

export const recordsProposeCheckout = defineProposal({
  tool: 'records_propose_checkout',
  domain: 'records',
  confirmLabel: 'confirm',
  description: 'Prepare checking out one record (others cannot change it until checked in).',
  input: IdOnly,
  stored: IdOnly,
  async check(ctx, input) {
    const { record, path } = await editableRecord(ctx, input.id);
    assertNotHeldByOther(ctx.principal, record);
    if (record.checkedOutBy) throw nothingToChange('You already have this record checked out');
    return {
      args: { id: input.id },
      base: null,
      title: `Check out “${record.name}”`,
      summary: path,
      changes: [{ label: 'Checked out', before: 'No', after: 'By you' }],
      targets: { records: [input.id], folders: [] },
      refs: [],
      destructive: false,
      reviewEach: false,
      needsFile: false,
    };
  },
  async execute(ctx, args) {
    await ctx.services.access.requireRecord(ctx.principal, args.id, 'edit');
    const view = await ctx.services.records.checkOut(ctx.principal, args.id);
    return {
      status: 'done',
      result: recordResult(view.id, view.name),
      resource: { type: 'record', id: view.id, label: view.name },
      note: `✓ Checked out “${view.name}”`,
    };
  },
});

export const recordsProposeCheckin = defineProposal({
  tool: 'records_propose_checkin',
  domain: 'records',
  confirmLabel: 'confirm',
  description: 'Prepare checking in one record the user has checked out.',
  input: IdOnly,
  stored: IdOnly,
  async check(ctx, input) {
    const { record, path } = await editableRecord(ctx, input.id);
    if (!record.checkedOutBy)
      throw errors.conflict('NOT_CHECKED_OUT', 'This record is not checked out');
    assertNotHeldByOther(ctx.principal, record);
    return {
      args: { id: input.id },
      base: null,
      title: `Check in “${record.name}”`,
      summary: path,
      changes: [{ label: 'Checked out', before: 'By you', after: 'No' }],
      targets: { records: [input.id], folders: [] },
      refs: [],
      destructive: false,
      reviewEach: false,
      needsFile: false,
    };
  },
  async execute(ctx, args) {
    await ctx.services.access.requireRecord(ctx.principal, args.id, 'edit');
    const view = await ctx.services.records.checkIn(ctx.principal, args.id);
    return {
      status: 'done',
      result: recordResult(view.id, view.name),
      resource: { type: 'record', id: view.id, label: view.name },
      note: `✓ Checked in “${view.name}”`,
    };
  },
});

const TrashStored = z.object({ ids: z.array(objectId).min(1).max(MAX_TRASH_IDS) }).strict();

function codeOf(error: unknown): string | null {
  return error instanceof HttpException ? toErrorBody(error).code : null;
}

export const recordsProposeTrash = defineProposal({
  tool: 'records_propose_trash',
  domain: 'records',
  confirmLabel: 'trash',
  description: `Prepare moving one or more records (at most ${MAX_TRASH_IDS}) to the trash. The user must confirm this explicitly; admins can restore from the trash.`,
  input: z.object({ ids: z.array(objectId).min(1).max(MAX_TRASH_IDS) }).strict(),
  stored: TrashStored,
  async check(ctx, input) {
    if (!can(ctx.principal, 'records.trash')) throw errors.forbidden();
    const ids = [...new Set(input.ids)];
    const changes: Change[] = [];
    let firstName = '';
    for (const id of ids) {
      const { record, path } = await editableRecord(ctx, id);
      assertNotHeldByOther(ctx.principal, record);
      firstName ||= record.name;
      changes.push({ label: record.name, before: path, after: 'Trash' });
    }
    return {
      args: { ids },
      base: null,
      title:
        ids.length === 1
          ? `Move “${firstName}” to the trash`
          : `Move ${ids.length} records to the trash`,
      summary: ids.length === 1 ? (changes[0]?.before ?? '') : 'Each record listed below',
      changes,
      targets: { records: ids, folders: [] },
      refs: [],
      destructive: true,
      reviewEach: false,
      needsFile: false,
    };
  },
  async execute(ctx, args) {
    if (args.ids.length === 1) {
      const [id] = args.ids;
      const record = await ctx.services.access.requireRecord(ctx.principal, id, 'edit');
      await ctx.services.trash.trashRecord(ctx.principal, id);
      return {
        status: 'done',
        result: { resourceType: 'record', id, name: record.name, link: null },
        resource: { type: 'record', id, label: record.name },
        note: `✓ Moved “${record.name}” to the trash`,
      };
    }
    const failed: BulkResult['failed'] = [];
    const allowed: string[] = [];
    for (const id of args.ids) {
      try {
        await ctx.services.access.requireRecord(ctx.principal, id, 'edit');
        allowed.push(id);
      } catch (error) {
        const code = codeOf(error);
        if (code === null) throw error;
        failed.push({ id, code });
      }
    }
    const bulk =
      allowed.length > 0
        ? await ctx.services.bulk.trashRecords(ctx.principal, allowed)
        : { results: [] };
    const trashed: string[] = [];
    for (const item of bulk.results) {
      if (item.ok) trashed.push(item.id);
      else failed.push({ id: item.id, code: item.code ?? 'REQUEST_FAILED' });
    }
    const count = args.ids.length - failed.length;
    return {
      status: failed.length > 0 ? 'partial' : 'done',
      result: { resourceType: 'records', count, failed },
      resource: { type: 'record', label: `${count} of ${args.ids.length} records` },
      note: `✓ Moved ${count} of ${args.ids.length} records to the trash`,
      auditContext: { recordIds: trashed },
    };
  },
});

export const RECORDS_PROPOSALS: Proposal[] = [
  recordsProposeCreate,
  recordsProposeNewVersion,
  recordsProposeRename,
  recordsProposeMove,
  recordsProposeSetTags,
  recordsProposeRestoreVersion,
  recordsProposeCheckout,
  recordsProposeCheckin,
  recordsProposeTrash,
];
