import { HttpException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { FieldDefinition } from '../../content-types/field-types.js';
import {
  assertBase,
  changesMetadata,
  idOrRef,
  mergeMetadata,
  metadataDelta,
  plannedRef,
  staleError,
} from './proposal.js';

const FIELDS: FieldDefinition[] = [
  { key: 'supplier', label: 'Supplier', type: 'text', required: true },
  { key: 'amount', label: 'Amount', type: 'number', required: true },
  { key: 'paid', label: 'Paid', type: 'boolean', required: false },
  { key: 'labels', label: 'Labels', type: 'multiselect', required: false, options: ['a', 'b'] },
];

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    return error instanceof HttpException
      ? ((error.getResponse() as { code?: string }).code ?? 'NONE')
      : 'NOT_HTTP';
  }
  return undefined;
};

describe('metadataDelta', () => {
  it('converts text values by field type and keeps unknown keys as sent for validation', () => {
    expect(
      metadataDelta(FIELDS, [
        { key: 'supplier', value: 'Acme' },
        { key: 'amount', value: ' 12.5 ' },
        { key: 'paid', value: 'Yes' },
        { key: 'labels', value: 'a, b' },
        { key: 'mystery', value: '7' },
      ]),
    ).toEqual({ supplier: 'Acme', amount: 12.5, paid: true, labels: ['a', 'b'], mystery: '7' });
  });

  it('reads a JSON array for multi-valued fields and leaves unparseable numbers as text', () => {
    expect(
      metadataDelta(FIELDS, [
        { key: 'labels', value: '["b"]' },
        { key: 'amount', value: 'twelve' },
        { key: 'paid', value: 'perhaps' },
      ]),
    ).toEqual({ labels: ['b'], amount: 'twelve', paid: 'perhaps' });
  });

  it('turns a null or blank value into a clear (null)', () => {
    expect(
      metadataDelta(FIELDS, [
        { key: 'supplier', value: null },
        { key: 'amount', value: '   ' },
      ]),
    ).toEqual({ supplier: null, amount: null });
    expect(metadataDelta(FIELDS, null)).toEqual({});
  });
});

describe('mergeMetadata and changesMetadata', () => {
  it('applies a delta without touching its inputs; null removes the key', () => {
    const current = { supplier: 'Acme', amount: 10 };
    const merged = mergeMetadata(current, { amount: 12, supplier: null, paid: false });
    expect(merged).toEqual({ amount: 12, paid: false });
    expect(current).toEqual({ supplier: 'Acme', amount: 10 });
  });

  it('tells a delta that changes nothing from one that does', () => {
    const current = { supplier: 'Acme', labels: ['a'] };
    expect(changesMetadata(current, { supplier: 'Acme', labels: ['a'] })).toBe(false);
    expect(changesMetadata(current, { amount: null })).toBe(false);
    expect(changesMetadata(current, { labels: ['a', 'b'] })).toBe(true);
    expect(changesMetadata(current, { supplier: null })).toBe(true);
  });
});

describe('assertBase', () => {
  it('passes when the base is unchanged or not recorded, and is 409 ACTION_STALE once it moved', () => {
    expect(codeOf(() => assertBase({ versionNumber: 3 }, 'versionNumber', 3))).toBeUndefined();
    expect(codeOf(() => assertBase(null, 'versionNumber', 4))).toBeUndefined();
    expect(codeOf(() => assertBase({}, 'schemaVersion', 9))).toBeUndefined();
    expect(codeOf(() => assertBase({ versionNumber: 3 }, 'versionNumber', 4))).toBe('ACTION_STALE');
    expect(codeOf(() => assertBase({ parentId: null }, 'parentId', 'a'.repeat(24)))).toBe(
      'ACTION_STALE',
    );
    expect(staleError().getStatus()).toBe(409);
  });
});

describe('idOrRef and plannedRef', () => {
  it('needs exactly one of an id and a Ref', () => {
    expect(idOrRef('folderId', 'folderRef', 'f', null)).toEqual({ id: 'f', ref: null });
    expect(idOrRef('folderId', 'folderRef', null, 'r')).toEqual({ id: null, ref: 'r' });
    expect(codeOf(() => idOrRef('folderId', 'folderRef', 'f', 'r'))).toBe('VALIDATION_FAILED');
    expect(codeOf(() => idOrRef('folderId', 'folderRef', null, null))).toBe('VALIDATION_FAILED');
  });

  it('resolves a Ref only to an earlier action of this turn made by an allowed tool', () => {
    const planned = {
      id: 'a'.repeat(24),
      tool: 'folders_propose_create',
      step: 1,
      args: {},
      creates: 'Repository / New',
    };
    const ctx = { planned: (id: string) => (id === planned.id ? planned : null) };
    expect(plannedRef(ctx, planned.id, ['folders_propose_create'])).toBe(planned);
    expect(codeOf(() => plannedRef(ctx, 'b'.repeat(24), ['folders_propose_create']))).toBe(
      'INVALID_REF',
    );
    expect(codeOf(() => plannedRef(ctx, planned.id, ['schema_propose_create_type']))).toBe(
      'INVALID_REF',
    );
  });
});
