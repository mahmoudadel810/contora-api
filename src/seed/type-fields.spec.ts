import { ContentTypeBodySchema } from '../content-types/content-types.dto.js';
import { FIELD_TYPES, type FieldDefinition } from '../content-types/field-types.js';
import { DEMO_TYPES } from './demo-data.js';
import { fieldsToAppend } from './type-fields.js';

const text = (key: string, required: boolean): FieldDefinition => ({
  key,
  label: key,
  type: 'text',
  required,
});

describe('fieldsToAppend', () => {
  it('returns the optional demo fields the type lacks, in demo order', () => {
    const demo = [text('a', true), text('b', false), text('c', false)];
    expect(fieldsToAppend('T', [{ key: 'a' }], demo).map((f) => f.key)).toEqual(['b', 'c']);
    expect(fieldsToAppend('T', demo, demo)).toEqual([]);
  });

  it('refuses to add a required field to an existing type', () => {
    const demo = [text('a', false), text('b', true)];
    expect(() => fieldsToAppend('Contract', [{ key: 'a' }], demo)).toThrow(
      /required field\(s\) b to the existing content type "Contract"/,
    );
  });

  it('lets the current demo types top up a type that has only their required fields', () => {
    for (const type of DEMO_TYPES) {
      const requiredOnly = type.fields.filter((f) => f.required);
      expect(() => fieldsToAppend(type.name, requiredOnly, type.fields)).not.toThrow();
    }
  });
});

describe('DEMO_TYPES', () => {
  it('are valid content type bodies, since the seed creates them without the request pipe', () => {
    for (const type of DEMO_TYPES) {
      expect(ContentTypeBodySchema.safeParse(type).error?.issues).toBeUndefined();
    }
  });

  it('show every field type at least once', () => {
    const shown = new Set(DEMO_TYPES.flatMap((type) => type.fields.map((f) => f.type)));
    expect([...FIELD_TYPES].filter((type) => !shown.has(type))).toEqual([]);
  });
});
