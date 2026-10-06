import { HttpException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { Principal } from '../../auth/principal.js';
import type { FieldDefinition } from '../../content-types/field-types.js';
import type { ExecuteContext } from './proposal.js';
import {
  applyFieldDelta,
  keyedFields,
  schemaProposeArchive,
  schemaProposeCreateType,
  schemaProposeUpdateFields,
  type FieldInput,
} from './schema.proposals.js';
import type { ToolServices } from './tool.js';

const TYPE = 'a'.repeat(24);

const admin: Principal = {
  userId: '9'.repeat(24),
  tenantId: '8'.repeat(24),
  role: 'admin',
  email: 'admin@example.test',
  displayName: 'Admin',
};
const member: Principal = { ...admin, role: 'member' };

const FIELDS: FieldDefinition[] = [
  { key: 'supplier', label: 'Supplier', type: 'text', required: true },
  { key: 'amount', label: 'Amount', type: 'number', required: true },
  { key: 'dueDate', label: 'Due date', type: 'date', required: false },
];

const input = (overrides: Partial<FieldInput> = {}): FieldInput => ({
  label: 'Field',
  type: 'text',
  required: null,
  options: null,
  min: null,
  max: null,
  maxLength: null,
  currency: null,
  ...overrides,
});

function fakeServices(schemaVersion = 4, fields = FIELDS) {
  const type = {
    id: TYPE,
    name: 'Invoice',
    description: '',
    status: 'active',
    fields,
    schemaVersion,
  };
  return {
    contentTypes: {
      get: vi.fn(async () => type),
      list: vi.fn(async () => [type]),
      create: vi.fn(async (_p: Principal, body: { name: string }) => ({
        id: TYPE,
        name: body.name,
      })),
      update: vi.fn(async (_p: Principal, id: string, body: { name: string }) => ({
        id,
        name: body.name,
      })),
      setArchived: vi.fn(async (_p: Principal, id: string) => ({ id, name: 'Invoice' })),
    },
  };
}

type Fakes = ReturnType<typeof fakeServices>;

const checkCtx = (services: Fakes, principal = admin) => ({
  principal,
  services: services as unknown as ToolServices,
  planned: () => null,
});

const executeCtx = (services: Fakes): ExecuteContext => ({
  principal: admin,
  services: services as unknown as ToolServices,
  file: null,
  resolved: () => {
    throw new Error('no refs here');
  },
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

describe('keyedFields', () => {
  it('derives keys from labels, never reusing an existing key, another new one or a reserved name', () => {
    const fields = keyedFields(
      [
        input({ label: 'Amount', type: 'number' }),
        input({ label: 'Amount' }),
        input({ label: 'Constructor' }),
        input({ label: 'Price', type: 'currency', currency: 'eur' }),
      ],
      ['amount'],
    );
    expect(fields.map((field) => field.key)).toEqual([
      'amount2',
      'amount3',
      'constructor2',
      'price',
    ]);
    expect(fields[0]).toEqual({ key: 'amount2', label: 'Amount', type: 'number', required: false });
    expect(fields[3]).toMatchObject({ currency: 'EUR' });
  });
});

describe('applyFieldDelta', () => {
  const none = { add: [], relabel: [], reorder: [], setRequired: [] };

  it('relabels, requires and reorders without removing a field or changing a key', () => {
    const next = applyFieldDelta(FIELDS, {
      ...none,
      relabel: [{ key: 'amount', label: 'Total' }],
      setRequired: [{ key: 'dueDate', required: true }],
      reorder: ['dueDate'],
      add: [{ key: 'notes', label: 'Notes', type: 'textarea', required: false }],
    });
    expect(next.map((field) => field.key)).toEqual(['dueDate', 'supplier', 'amount', 'notes']);
    expect(next.find((field) => field.key === 'amount')?.label).toBe('Total');
    expect(next.find((field) => field.key === 'dueDate')?.required).toBe(true);
    for (const field of FIELDS) expect(next.map((f) => f.key)).toContain(field.key);
  });

  it('refuses unknown keys and repeated reorder keys; an added key that exists is stale', () => {
    const codeOfSync = (fn: () => unknown) => {
      try {
        fn();
      } catch (error) {
        return (error as HttpException).getResponse() as { code: string };
      }
      return null;
    };
    expect(
      codeOfSync(() =>
        applyFieldDelta(FIELDS, { ...none, relabel: [{ key: 'nope', label: 'X' }] }),
      ),
    ).toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    expect(
      codeOfSync(() => applyFieldDelta(FIELDS, { ...none, reorder: ['amount', 'amount'] })),
    ).toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    expect(
      codeOfSync(() =>
        applyFieldDelta(FIELDS, {
          ...none,
          add: [{ key: 'amount', label: 'Amount', type: 'number', required: false }],
        }),
      ),
    ).toMatchObject({ code: 'ACTION_STALE' });
  });
});

describe('schema_propose_update_fields', () => {
  it('stores the delta with the schema version it was built on, and writes nothing', async () => {
    const services = fakeServices();
    const preview = await schemaProposeUpdateFields.check(checkCtx(services), {
      id: TYPE,
      add: [input({ label: 'Amount', type: 'number' })],
      relabel: null,
      reorder: null,
      setRequired: null,
    });
    expect(preview).toMatchObject({
      base: { schemaVersion: 4 },
      args: {
        id: TYPE,
        add: [{ key: 'amount2', label: 'Amount' }],
        relabel: [],
        reorder: [],
        setRequired: [],
      },
    });
    expect(services.contentTypes.update).not.toHaveBeenCalled();
  });

  it('builds the full body from the type as it is now and calls ContentTypesService.update', async () => {
    const services = fakeServices();
    await schemaProposeUpdateFields.execute(
      executeCtx(services),
      {
        id: TYPE,
        add: [{ key: 'notes', label: 'Notes', type: 'textarea', required: false }],
        relabel: [],
        reorder: [],
        setRequired: [],
      },
      { schemaVersion: 4 },
    );
    const [, id, body] = services.contentTypes.update.mock.calls[0] as unknown as [
      Principal,
      string,
      { fields: FieldDefinition[] },
    ];
    expect(id).toBe(TYPE);
    expect(body.fields.map((field) => field.key)).toEqual([
      'supplier',
      'amount',
      'dueDate',
      'notes',
    ]);
  });

  it('is ACTION_STALE when a field was added meanwhile, and removes nothing', async () => {
    const newer = fakeServices(5, [
      ...FIELDS,
      { key: 'vat', label: 'VAT', type: 'number', required: false },
    ]);
    expect(
      await codeOf(
        schemaProposeUpdateFields.execute(
          executeCtx(newer),
          {
            id: TYPE,
            add: [],
            relabel: [{ key: 'amount', label: 'Total' }],
            reorder: [],
            setRequired: [],
          },
          { schemaVersion: 4 },
        ),
      ),
    ).toBe('ACTION_STALE');
    expect(newer.contentTypes.update).not.toHaveBeenCalled();
  });

  it('is not offered to members, and refuses them if called anyway', async () => {
    expect(schemaProposeUpdateFields.available?.(member)).toBe(false);
    expect(schemaProposeUpdateFields.available?.(admin)).toBe(true);
    expect(
      await codeOf(
        schemaProposeUpdateFields.check(checkCtx(fakeServices(), member), {
          id: TYPE,
          add: null,
          relabel: [{ key: 'amount', label: 'Total' }],
          reorder: null,
          setRequired: null,
        }),
      ),
    ).toBe('FORBIDDEN');
  });
});

describe('schema_propose_create_type and schema_propose_archive', () => {
  it('refuses a taken name and creates through ContentTypesService.create', async () => {
    const services = fakeServices();
    expect(
      await codeOf(
        schemaProposeCreateType.check(checkCtx(services), {
          name: ' invoice ',
          description: null,
          fields: [],
        }),
      ),
    ).toBe('NAME_TAKEN');
    const preview = await schemaProposeCreateType.check(checkCtx(services), {
      name: 'Contract',
      description: null,
      fields: [input({ label: 'Party' }), input({ label: 'Party' })],
    });
    expect(preview.args).toMatchObject({
      name: 'Contract',
      fields: [{ key: 'party' }, { key: 'party2' }],
    });
    await schemaProposeCreateType.execute(executeCtx(services), preview.args, null);
    expect(services.contentTypes.create).toHaveBeenCalledWith(
      admin,
      expect.objectContaining({ name: 'Contract' }),
    );
  });

  it('archives through ContentTypesService.setArchived and refuses a no-op', async () => {
    const services = fakeServices();
    expect(
      await codeOf(schemaProposeArchive.check(checkCtx(services), { id: TYPE, archived: false })),
    ).toBe('NOTHING_TO_CHANGE');
    await schemaProposeArchive.execute(executeCtx(services), { id: TYPE, archived: true }, null);
    expect(services.contentTypes.setArchived).toHaveBeenCalledWith(admin, TYPE, true);
  });
});
