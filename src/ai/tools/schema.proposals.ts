import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { Principal } from '../../auth/principal.js';
import { can } from '../../authorization/policy.js';
import { errors } from '../../common/errors.js';
import { parseWith } from '../../common/zod.pipe.js';
import { nameKeyOf } from '../../content-types/content-type.schema.js';
import { ContentTypeBodySchema } from '../../content-types/content-types.dto.js';
import { generateFieldKey } from '../../content-types/field-keys.js';
import {
  FIELD_TYPES,
  FieldDefinitionSchema,
  type FieldDefinition,
} from '../../content-types/field-types.js';
import type { Change } from '../blocks.js';
import { contentTypeLink } from '../links.js';
import {
  assertBase,
  defineProposal,
  nothingToChange,
  staleError,
  type Proposal,
} from './proposal.js';
import { objectId } from './search.tools.js';

const manages = (principal: Principal) => can(principal, 'contentTypes.manage');

const MAX_FIELDS = 50;

export const FieldInputSchema = z
  .object({
    label: z.string().min(1).max(80),
    type: z.enum(FIELD_TYPES),
    required: z.boolean().nullable(),
    options: z.array(z.string().max(80)).max(100).nullable(),
    min: z.number().nullable(),
    max: z.number().nullable(),
    maxLength: z.number().int().nullable(),
    currency: z.string().max(3).nullable(),
  })
  .strict();
export type FieldInput = z.output<typeof FieldInputSchema>;

export function keyedFields(
  inputs: readonly FieldInput[],
  takenKeys: Iterable<string>,
): FieldDefinition[] {
  const taken = new Set(takenKeys);
  return inputs.map((input) => {
    const key = generateFieldKey(input.label, taken);
    taken.add(key);
    return {
      key,
      label: input.label,
      type: input.type,
      required: input.required ?? false,
      ...(input.options === null ? {} : { options: input.options }),
      ...(input.min === null ? {} : { min: input.min }),
      ...(input.max === null ? {} : { max: input.max }),
      ...(input.maxLength === null ? {} : { maxLength: input.maxLength }),
      ...(input.currency === null ? {} : { currency: input.currency.toUpperCase() }),
    };
  });
}

export interface FieldDelta {
  add: FieldDefinition[];
  relabel: Array<{ key: string; label: string }>;
  reorder: string[];
  setRequired: Array<{ key: string; required: boolean }>;
}

export function applyFieldDelta(
  fields: readonly FieldDefinition[],
  delta: FieldDelta,
): FieldDefinition[] {
  const known = new Map(fields.map((field) => [field.key, field]));
  const unknown = (path: string, key: string) =>
    errors.validation([{ path, message: `There is no field with the key "${key}"` }]);
  for (const [index, { key }] of delta.relabel.entries()) {
    if (!known.has(key)) throw unknown(`relabel.${index}.key`, key);
  }
  for (const [index, { key }] of delta.setRequired.entries()) {
    if (!known.has(key)) throw unknown(`setRequired.${index}.key`, key);
  }
  const listed = new Set<string>();
  for (const [index, key] of delta.reorder.entries()) {
    if (!known.has(key)) throw unknown(`reorder.${index}`, key);
    if (listed.has(key)) {
      throw errors.validation([{ path: `reorder.${index}`, message: `"${key}" is listed twice` }]);
    }
    listed.add(key);
  }
  for (const field of delta.add) {
    if (known.has(field.key)) throw staleError();
  }
  const labels = new Map(delta.relabel.map(({ key, label }) => [key, label]));
  const required = new Map(delta.setRequired.map(({ key, required: value }) => [key, value]));
  const ordered = [
    ...delta.reorder.map((key) => known.get(key) as FieldDefinition),
    ...fields.filter((field) => !listed.has(field.key)),
  ];
  const next = [
    ...ordered.map((field) => ({
      ...field,
      ...(labels.has(field.key) ? { label: labels.get(field.key) as string } : {}),
      ...(required.has(field.key) ? { required: required.get(field.key) as boolean } : {}),
    })),
    ...delta.add,
  ];
  const nextKeys = new Set(next.map((field) => field.key));
  if (fields.some((field) => !nextKeys.has(field.key))) {
    throw new Error('A field delta must never remove a field');
  }
  return next;
}

function fieldText(field: FieldDefinition): string {
  const parts = [field.type, ...(field.required ? ['required'] : [])];
  if (field.options) parts.push(`options: ${field.options.join(', ')}`);
  if (field.currency) parts.push(field.currency);
  return `${parts.join(', ')} · key ${field.key}`;
}

const FieldDefinitionStored = FieldDefinitionSchema;
const StoredKey = z.string().max(40);

export const schemaProposeCreateType = defineProposal({
  tool: 'schema_propose_create_type',
  domain: 'schema',
  confirmLabel: 'create',
  description:
    'Prepare a new content type (a metadata schema) with its fields. Field keys are derived from the labels by the server. Options only for select, multiselect, radio and checkboxes; currency (ISO 4217, e.g. EUR) only for currency fields; min/max for number, currency and percentage; maxLength for text and textarea.',
  input: z
    .object({
      name: z.string().min(1).max(80),
      description: z.string().max(500).nullable(),
      fields: z.array(FieldInputSchema).max(MAX_FIELDS),
    })
    .strict(),
  stored: z
    .object({
      name: z.string().trim().min(1).max(80),
      description: z.string().max(500),
      fields: z.array(FieldDefinitionStored).max(MAX_FIELDS),
    })
    .strict(),
  available: manages,
  async check(ctx, input) {
    if (!manages(ctx.principal)) throw errors.forbidden();
    const body = parseWith(ContentTypeBodySchema, {
      name: input.name,
      description: input.description ?? '',
      fields: keyedFields(input.fields, []),
    });
    const existing = await ctx.services.contentTypes.list(ctx.principal, { status: 'all' });
    if (existing.some((type) => nameKeyOf(type.name) === nameKeyOf(body.name))) {
      throw errors.conflict('NAME_TAKEN', 'A content type with this name already exists');
    }
    return {
      args: { name: body.name, description: body.description, fields: body.fields },
      base: null,
      title: `Create content type “${body.name}”`,
      summary: `${body.fields.length} field${body.fields.length === 1 ? '' : 's'}`,
      changes: [
        { label: 'Name', before: null, after: body.name },
        ...(body.description
          ? [{ label: 'Description', before: null, after: body.description }]
          : []),
        ...body.fields.map((field) => ({
          label: field.label,
          before: null,
          after: fieldText(field),
        })),
      ],
      targets: { records: [], folders: [] },
      refs: [],
      destructive: false,
      reviewEach: false,
      needsFile: false,
      creates: body.name,
    };
  },
  async execute(ctx, args) {
    const type = await ctx.services.contentTypes.create(
      ctx.principal,
      parseWith(ContentTypeBodySchema, args),
    );
    return {
      status: 'done',
      result: {
        resourceType: 'contentType',
        id: type.id,
        name: type.name,
        link: contentTypeLink(type.id),
      },
      resource: { type: 'contentType', id: type.id, label: type.name },
      note: `✓ Created content type “${type.name}”`,
    };
  },
});

const UpdateFieldsStored = z
  .object({
    id: objectId,
    add: z.array(FieldDefinitionStored).max(MAX_FIELDS),
    relabel: z
      .array(z.object({ key: StoredKey, label: z.string().trim().min(1).max(80) }).strict())
      .max(MAX_FIELDS),
    reorder: z.array(StoredKey).max(MAX_FIELDS),
    setRequired: z
      .array(z.object({ key: StoredKey, required: z.boolean() }).strict())
      .max(MAX_FIELDS),
  })
  .strict();

export const schemaProposeUpdateFields = defineProposal({
  tool: 'schema_propose_update_fields',
  domain: 'schema',
  confirmLabel: 'update',
  description:
    'Prepare changes to the fields of a content type: add new fields (keys derived from labels), relabel fields by key, reorder (the keys listed come first, in that order; new fields go last) and make fields required or optional. Fields are never removed and keys never change.',
  input: z
    .object({
      id: objectId,
      add: z.array(FieldInputSchema).max(MAX_FIELDS).nullable(),
      relabel: z
        .array(z.object({ key: z.string().max(40), label: z.string().min(1).max(80) }).strict())
        .max(MAX_FIELDS)
        .nullable(),
      reorder: z.array(z.string().max(40)).max(MAX_FIELDS).nullable(),
      setRequired: z
        .array(z.object({ key: z.string().max(40), required: z.boolean() }).strict())
        .max(MAX_FIELDS)
        .nullable(),
    })
    .strict(),
  stored: UpdateFieldsStored,
  available: manages,
  async check(ctx, input) {
    if (!manages(ctx.principal)) throw errors.forbidden();
    const type = await ctx.services.contentTypes.get(ctx.principal, input.id);
    const delta: FieldDelta = {
      add: keyedFields(
        input.add ?? [],
        type.fields.map((field) => field.key),
      ),
      relabel: input.relabel ?? [],
      reorder: input.reorder ?? [],
      setRequired: input.setRequired ?? [],
    };
    const next = applyFieldDelta(type.fields, delta);
    const body = parseWith(ContentTypeBodySchema, {
      name: type.name,
      description: type.description,
      fields: next,
    });
    if (
      isDeepStrictEqual(
        JSON.parse(JSON.stringify(type.fields)),
        JSON.parse(JSON.stringify(body.fields)),
      )
    ) {
      throw nothingToChange('These fields are already like that');
    }
    const byKey = new Map(type.fields.map((field) => [field.key, field]));
    const changes: Change[] = [
      ...delta.add.map((field) => ({ label: field.label, before: null, after: fieldText(field) })),
      ...delta.relabel
        .filter(({ key, label }) => byKey.get(key)?.label !== label)
        .map(({ key, label }) => ({
          label: `Label of ${key}`,
          before: byKey.get(key)?.label ?? null,
          after: label,
        })),
      ...delta.setRequired
        .filter(({ key, required }) => byKey.get(key)?.required !== required)
        .map(({ key, required }) => ({
          label: byKey.get(key)?.label ?? key,
          before: byKey.get(key)?.required ? 'Required' : 'Optional',
          after: required ? 'Required' : 'Optional',
        })),
    ];
    const oldOrder = type.fields.map((field) => field.label).join(', ');
    const newOrder = next
      .filter((field) => byKey.has(field.key))
      .map((field) => field.label)
      .join(', ');
    if (delta.reorder.length > 0 && oldOrder !== newOrder) {
      changes.push({ label: 'Order', before: oldOrder, after: newOrder });
    }
    return {
      args: { id: input.id, ...delta },
      base: { schemaVersion: type.schemaVersion },
      title: `Change the fields of “${type.name}”`,
      summary: `Schema version ${type.schemaVersion} → ${type.schemaVersion + 1}; no field is removed`,
      changes,
      targets: { records: [], folders: [] },
      refs: [],
      destructive: false,
      reviewEach: false,
      needsFile: false,
    };
  },
  async execute(ctx, args, base) {
    const type = await ctx.services.contentTypes.get(ctx.principal, args.id);
    assertBase(base, 'schemaVersion', type.schemaVersion);
    const { id, ...delta } = args;
    const body = parseWith(ContentTypeBodySchema, {
      name: type.name,
      description: type.description,
      fields: applyFieldDelta(type.fields, delta),
    });
    const updated = await ctx.services.contentTypes.update(ctx.principal, id, body);
    return {
      status: 'done',
      result: { resourceType: 'contentType', id, name: updated.name, link: contentTypeLink(id) },
      resource: { type: 'contentType', id, label: updated.name },
      note: `✓ Changed the fields of “${updated.name}”`,
    };
  },
});

export const schemaProposeArchive = defineProposal({
  tool: 'schema_propose_archive',
  domain: 'schema',
  confirmLabel: 'update',
  description:
    'Prepare archiving (archived: true; no new records of that type) or unarchiving (false) a content type.',
  input: z.object({ id: objectId, archived: z.boolean() }).strict(),
  stored: z.object({ id: objectId, archived: z.boolean() }).strict(),
  available: manages,
  async check(ctx, input) {
    if (!manages(ctx.principal)) throw errors.forbidden();
    const type = await ctx.services.contentTypes.get(ctx.principal, input.id);
    const target = input.archived ? 'archived' : 'active';
    if (type.status === target) throw nothingToChange(`The content type is already ${target}`);
    return {
      args: { id: input.id, archived: input.archived },
      base: null,
      title: `${input.archived ? 'Archive' : 'Unarchive'} content type “${type.name}”`,
      summary: input.archived
        ? 'Existing records stay; no new records of this type can be created'
        : 'New records of this type can be created again',
      changes: [{ label: 'Status', before: type.status, after: target }],
      targets: { records: [], folders: [] },
      refs: [],
      destructive: false,
      reviewEach: false,
      needsFile: false,
    };
  },
  async execute(ctx, args) {
    const type = await ctx.services.contentTypes.setArchived(ctx.principal, args.id, args.archived);
    return {
      status: 'done',
      result: {
        resourceType: 'contentType',
        id: type.id,
        name: type.name,
        link: contentTypeLink(type.id),
      },
      resource: { type: 'contentType', id: type.id, label: type.name },
      note: `✓ ${args.archived ? 'Archived' : 'Unarchived'} content type “${type.name}”`,
    };
  },
});

export const SCHEMA_PROPOSALS: Proposal[] = [
  schemaProposeCreateType,
  schemaProposeUpdateFields,
  schemaProposeArchive,
];
