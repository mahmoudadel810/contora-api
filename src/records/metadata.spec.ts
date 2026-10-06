import { AppError } from '../common/errors.js';
import type { FieldDefinition } from '../content-types/field-types.js';
import { escapeRegex, searchTextOf, validateMetadata } from './metadata.js';

const fields: FieldDefinition[] = [
  { key: 'supplier', label: 'Supplier', type: 'text', required: true },
  { key: 'amount', label: 'Amount', type: 'number', required: false, min: 0 },
  { key: 'paid', label: 'Paid', type: 'boolean', required: false },
];

describe('validateMetadata', () => {
  it('returns cleaned metadata', () => {
    expect(validateMetadata(fields, { supplier: '  Acme ', amount: 3, paid: '' })).toEqual({
      supplier: 'Acme',
      amount: 3,
    });
  });

  it('throws VALIDATION_FAILED with metadata-prefixed paths', () => {
    try {
      validateMetadata(fields, { amount: -1, extra: 'x' });
      throw new Error('did not throw');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      const details = (error as AppError).details as Array<{ path: string }>;
      expect(details.map((d) => d.path)).toEqual(
        expect.arrayContaining(['metadata.supplier', 'metadata.amount', 'metadata.extra']),
      );
    }
  });
});

describe('searchTextOf', () => {
  it('lowercases the name, searchable metadata and file name', () => {
    expect(
      searchTextOf('Q1 Invoice', fields, { supplier: 'Acme', amount: 3, paid: true }, 'scan.PDF'),
    ).toBe('q1 invoice acme 3 scan.pdf');
  });
});

describe('escapeRegex', () => {
  it('neutralises regex metacharacters', () => {
    expect(new RegExp(escapeRegex('a.b*(c)')).test('a.b*(c)')).toBe(true);
    expect(new RegExp(escapeRegex('a.b')).test('axb')).toBe(false);
  });
});
