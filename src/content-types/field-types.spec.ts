import {
  buildMetadataSchema,
  effectiveBounds,
  FieldDefinitionSchema,
  metadataSearchText,
  type FieldDefinition,
} from './field-types.js';

const fields: FieldDefinition[] = [
  { key: 'title', label: 'Title', type: 'text', required: true, maxLength: 10 },
  { key: 'notes', label: 'Notes', type: 'textarea', required: false },
  { key: 'amount', label: 'Amount', type: 'number', required: false, min: 0, max: 100 },
  { key: 'signed', label: 'Signed', type: 'boolean', required: false, defaultValue: false },
  { key: 'due', label: 'Due', type: 'date', required: false },
  { key: 'contact', label: 'Contact', type: 'email', required: false },
  {
    key: 'kind',
    label: 'Kind',
    type: 'select',
    required: true,
    options: ['Invoice', 'Receipt'],
    defaultValue: 'Invoice',
  },
];

function unknownKeysOf(
  issues: Array<{ code: string; path: PropertyKey[]; keys?: string[] }>,
): string[] {
  return issues.flatMap((issue) =>
    issue.code === 'unrecognized_keys' ? (issue.keys ?? []) : [issue.path.join('.')],
  );
}

describe('buildMetadataSchema', () => {
  const schema = buildMetadataSchema(fields);

  it('accepts a complete valid record', () => {
    const parsed = schema.parse({
      title: 'Hello',
      notes: 'n',
      amount: 5,
      signed: true,
      due: '2026-02-28',
      contact: 'A@B.io',
      kind: 'Receipt',
    });
    expect(parsed.contact).toBe('a@b.io');
    expect(parsed.kind).toBe('Receipt');
  });

  it('applies default values for missing fields and treats blanks as missing', () => {
    const parsed = schema.parse({ title: 'Hello', notes: '', amount: null });
    expect(parsed).toEqual({ title: 'Hello', signed: false, kind: 'Invoice' });
  });

  it('rejects missing required, wrong types, out-of-range, bad dates and unknown keys', () => {
    const result = buildMetadataSchema(
      fields.map((f) => ({ ...f, defaultValue: undefined })),
    ).safeParse({
      notes: 'n',
      amount: 101,
      signed: 'yes',
      due: '2026-13-01',
      contact: 'nope',
      kind: 'Other',
      extra: 1,
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(unknownKeysOf(result.error.issues)).toEqual(
      expect.arrayContaining(['title', 'amount', 'signed', 'due', 'contact', 'kind', 'extra']),
    );
  });

  it('enforces maxLength on text', () => {
    expect(schema.safeParse({ title: 'x'.repeat(11) }).success).toBe(false);
  });
});

describe('FieldDefinitionSchema', () => {
  it('rejects a select without options and options on non-select', () => {
    expect(
      FieldDefinitionSchema.safeParse({ key: 'a', label: 'A', type: 'select', required: false })
        .success,
    ).toBe(false);
    expect(
      FieldDefinitionSchema.safeParse({
        key: 'a',
        label: 'A',
        type: 'text',
        required: false,
        options: ['x'],
      }).success,
    ).toBe(false);
  });

  it('rejects bad keys and min greater than max', () => {
    expect(
      FieldDefinitionSchema.safeParse({ key: 'Bad Key', label: 'A', type: 'text', required: false })
        .success,
    ).toBe(false);
    expect(
      FieldDefinitionSchema.safeParse({
        key: 'n',
        label: 'N',
        type: 'number',
        required: false,
        min: 5,
        max: 1,
      }).success,
    ).toBe(false);
  });

  it('validates the default value against the field type and options', () => {
    expect(
      FieldDefinitionSchema.safeParse({ key: 'n', label: 'N', type: 'number', defaultValue: 'x' })
        .success,
    ).toBe(false);
    expect(
      FieldDefinitionSchema.safeParse({
        key: 's',
        label: 'S',
        type: 'select',
        options: ['A'],
        defaultValue: 'B',
      }).success,
    ).toBe(false);
    expect(
      FieldDefinitionSchema.safeParse({
        key: 'd',
        label: 'D',
        type: 'date',
        defaultValue: '2026-01-31',
      }).success,
    ).toBe(true);
  });
});

describe('metadataSearchText', () => {
  it('joins searchable values and skips booleans and blanks', () => {
    const text = metadataSearchText(fields, {
      title: 'Hello',
      amount: 5,
      signed: true,
      contact: 'a@b.io',
      kind: 'Invoice',
    });
    expect(text).toBe('Hello 5 a@b.io Invoice');
  });
});

describe('multi-select, URL and user fields', () => {
  const extra: FieldDefinition[] = [
    {
      key: 'teams',
      label: 'Teams',
      type: 'multiselect',
      required: false,
      options: ['Legal', 'Finance', 'HR'],
      defaultValue: ['Legal'],
    },
    { key: 'link', label: 'Link', type: 'url', required: false },
    { key: 'owner', label: 'Owner', type: 'user', required: false },
  ];
  const schema = buildMetadataSchema(extra);

  it('accepts valid values and applies a multi-select default', () => {
    expect(
      schema.parse({ link: 'https://example.com/a?b=1', owner: '64b000000000000000000001' }),
    ).toEqual({
      teams: ['Legal'],
      link: 'https://example.com/a?b=1',
      owner: '64b000000000000000000001',
    });
    expect(schema.parse({ teams: ['HR', 'Finance'] }).teams).toEqual(['HR', 'Finance']);
  });

  it('rejects unknown or repeated options, non-http links and malformed user ids; an empty list is unset', () => {
    const bad = (value: Record<string, unknown>) => schema.safeParse(value).success;
    expect(bad({ teams: ['Sales'] })).toBe(false);
    expect(bad({ teams: ['HR', 'HR'] })).toBe(false);
    expect(schema.parse({ teams: [] }).teams).toEqual(['Legal']);
    expect(bad({ teams: 'HR' })).toBe(false);
    expect(bad({ link: 'javascript:alert(1)' })).toBe(false);
    expect(bad({ link: 'ftp://example.com/file' })).toBe(false);
    expect(bad({ link: 'not a url' })).toBe(false);
    expect(bad({ owner: 'alice' })).toBe(false);
  });

  it('checks definitions: options for multi-select, defaults within options, no user default', () => {
    const define = (field: Record<string, unknown>) =>
      FieldDefinitionSchema.safeParse({ key: 'f', label: 'F', ...field }).success;
    expect(define({ type: 'multiselect' })).toBe(false);
    expect(define({ type: 'multiselect', options: ['A'], defaultValue: ['B'] })).toBe(false);
    expect(define({ type: 'multiselect', options: ['A', 'B'], defaultValue: ['B'] })).toBe(true);
    expect(define({ type: 'url', options: ['A'] })).toBe(false);
    expect(define({ type: 'user', defaultValue: '64b000000000000000000001' })).toBe(false);
    expect(define({ type: 'user' })).toBe(true);
  });

  it('makes multi-select values and links searchable, but not user ids', () => {
    expect(
      metadataSearchText(extra, {
        teams: ['Legal', 'HR'],
        link: 'https://x.io',
        owner: '64b000000000000000000001',
      }),
    ).toBe('Legal HR https://x.io');
  });
});

describe('content type builder field types', () => {
  const define = (field: Record<string, unknown>) =>
    FieldDefinitionSchema.safeParse({ key: 'f', label: 'F', ...field });
  const accepts = (field: Record<string, unknown>) => define(field).success;
  const messagesOf = (field: Record<string, unknown>) => {
    const result = define(field);
    return result.success ? [] : result.error.issues.map((issue) => issue.message);
  };
  const valueOk = (field: Omit<FieldDefinition, 'key' | 'label' | 'required'>, value: unknown) =>
    buildMetadataSchema([{ key: 'f', label: 'F', required: true, ...field }]).safeParse({
      f: value,
    }).success;

  describe('phone', () => {
    it('accepts international and local numbers, trimmed, and refuses letters and short or long input', () => {
      const schema = buildMetadataSchema([{ key: 'f', label: 'F', type: 'phone', required: true }]);
      expect(schema.parse({ f: '  +49 (30) 1234-567  ' }).f).toBe('+49 (30) 1234-567');
      expect(valueOk({ type: 'phone' }, '030.1234.567')).toBe(true);
      expect(valueOk({ type: 'phone' }, '12345')).toBe(true);
      expect(valueOk({ type: 'phone' }, '1234')).toBe(false);
      expect(valueOk({ type: 'phone' }, 'call me')).toBe(false);
      expect(valueOk({ type: 'phone' }, '+49 30 1234 567-')).toBe(false);
      expect(valueOk({ type: 'phone' }, `+${'1'.repeat(30)}`)).toBe(false);
      expect(valueOk({ type: 'phone' }, 4930123)).toBe(false);
    });

    it('validates a default and takes no options, bounds or currency', () => {
      expect(accepts({ type: 'phone', defaultValue: '+1 555 0100' })).toBe(true);
      expect(accepts({ type: 'phone', defaultValue: 'none' })).toBe(false);
      expect(accepts({ type: 'phone', options: ['1'] })).toBe(false);
      expect(accepts({ type: 'phone', min: 1 })).toBe(false);
      expect(accepts({ type: 'phone', currency: 'EUR' })).toBe(false);
    });
  });

  describe('datetime', () => {
    it('accepts a real UTC instant in ISO form and stores it in canonical form', () => {
      const schema = buildMetadataSchema([
        { key: 'f', label: 'F', type: 'datetime', required: true },
      ]);
      expect(schema.parse({ f: '2026-09-30T14:30Z' }).f).toBe('2026-09-30T14:30:00.000Z');
      expect(valueOk({ type: 'datetime' }, '2026-09-30T14:30:15Z')).toBe(true);
      expect(valueOk({ type: 'datetime' }, '2026-09-30T14:30:15.250Z')).toBe(true);
      expect(valueOk({ type: 'datetime' }, '2028-02-29T00:00Z')).toBe(true);
    });

    it('refuses impossible instants, offsets, missing Z and plain dates', () => {
      for (const bad of [
        '2026-02-30T10:00Z',
        '2026-09-30T24:00Z',
        '2026-09-30T14:60Z',
        '2026-09-30T14:30:60Z',
        '2026-09-30T14:30',
        '2026-09-30T14:30+02:00',
        '2026-09-30',
        '2026-09-30 14:30Z',
        '2026-09-30T14:30:15.25Z',
        'yesterday',
      ]) {
        expect(valueOk({ type: 'datetime' }, bad), bad).toBe(false);
      }
    });

    it('validates a default', () => {
      expect(accepts({ type: 'datetime', defaultValue: '2026-01-01T09:00Z' })).toBe(true);
      expect(accepts({ type: 'datetime', defaultValue: '2026-13-01T09:00Z' })).toBe(false);
    });
  });

  describe('time', () => {
    it('accepts HH:mm from 00:00 to 23:59 only', () => {
      expect(valueOk({ type: 'time' }, '00:00')).toBe(true);
      expect(valueOk({ type: 'time' }, '09:05')).toBe(true);
      expect(valueOk({ type: 'time' }, '23:59')).toBe(true);
      for (const bad of ['24:00', '9:05', '12:60', '12:30:00', '1230', 'noon']) {
        expect(valueOk({ type: 'time' }, bad), bad).toBe(false);
      }
    });

    it('validates a default', () => {
      expect(accepts({ type: 'time', defaultValue: '08:30' })).toBe(true);
      expect(accepts({ type: 'time', defaultValue: '25:00' })).toBe(false);
    });
  });

  describe('currency', () => {
    const eur = { type: 'currency', currency: 'EUR' } as const;

    it('takes a number with at most two decimals, within min and max', () => {
      expect(valueOk(eur, 1250)).toBe(true);
      expect(valueOk(eur, 19.99)).toBe(true);
      expect(valueOk(eur, -3.5)).toBe(true);
      expect(valueOk(eur, 0.125)).toBe(false);
      expect(valueOk(eur, '19.99')).toBe(false);
      expect(valueOk({ ...eur, min: 0, max: 100 }, 100)).toBe(true);
      expect(valueOk({ ...eur, min: 0, max: 100 }, -0.01)).toBe(false);
      expect(valueOk({ ...eur, min: 0, max: 100 }, 100.01)).toBe(false);
    });

    it('needs an ISO 4217 code, which no other type takes', () => {
      expect(accepts(eur)).toBe(true);
      expect(accepts({ ...eur, min: 0, max: 1000 })).toBe(true);
      expect(messagesOf({ type: 'currency' })).toEqual(['Currency fields need a currency code']);
      expect(accepts({ type: 'currency', currency: 'eur' })).toBe(false);
      expect(accepts({ type: 'currency', currency: 'EURO' })).toBe(false);
      expect(messagesOf({ type: 'number', currency: 'EUR' })).toEqual([
        'Only currency fields take a currency code',
      ]);
      expect(accepts({ ...eur, options: ['A'] })).toBe(false);
    });

    it('validates a default', () => {
      expect(accepts({ ...eur, defaultValue: 0 })).toBe(true);
      expect(accepts({ ...eur, defaultValue: 1.005 })).toBe(false);
      expect(accepts({ ...eur, min: 10, defaultValue: 5 })).toBe(false);
    });

    it('makes the number searchable', () => {
      expect(
        metadataSearchText([{ key: 'f', label: 'F', required: false, ...eur }], { f: 19.5 }),
      ).toBe('19.5');
    });
  });

  describe('percentage', () => {
    it('defaults to bounds 0 to 100 and takes at most two decimals', () => {
      expect(valueOk({ type: 'percentage' }, 0)).toBe(true);
      expect(valueOk({ type: 'percentage' }, 100)).toBe(true);
      expect(valueOk({ type: 'percentage' }, 12.5)).toBe(true);
      expect(valueOk({ type: 'percentage' }, -1)).toBe(false);
      expect(valueOk({ type: 'percentage' }, 100.5)).toBe(false);
      expect(valueOk({ type: 'percentage' }, 33.333)).toBe(false);
    });

    it('lets min and max widen or narrow the bounds', () => {
      expect(valueOk({ type: 'percentage', max: 200 }, 150)).toBe(true);
      expect(valueOk({ type: 'percentage', min: -50 }, -20)).toBe(true);
      expect(valueOk({ type: 'percentage', min: 10, max: 20 }, 25)).toBe(false);
      expect(accepts({ type: 'percentage', min: 10, max: 20 })).toBe(true);
    });

    it('validates a default and takes no currency', () => {
      expect(accepts({ type: 'percentage', defaultValue: 20 })).toBe(true);
      expect(accepts({ type: 'percentage', defaultValue: 120 })).toBe(false);
      expect(accepts({ type: 'percentage', currency: 'EUR' })).toBe(false);
    });
  });

  describe('radio and checkboxes', () => {
    const options = ['Low', 'Medium', 'High'];

    it('radio takes exactly one of the options', () => {
      expect(valueOk({ type: 'radio', options }, 'Medium')).toBe(true);
      expect(valueOk({ type: 'radio', options }, 'Urgent')).toBe(false);
      expect(valueOk({ type: 'radio', options }, ['Low'])).toBe(false);
    });

    it('checkboxes take distinct options as a list', () => {
      expect(valueOk({ type: 'checkboxes', options }, ['High', 'Low'])).toBe(true);
      expect(valueOk({ type: 'checkboxes', options }, ['Low', 'Low'])).toBe(false);
      expect(valueOk({ type: 'checkboxes', options }, ['Urgent'])).toBe(false);
      expect(valueOk({ type: 'checkboxes', options }, 'Low')).toBe(false);
    });

    it('need options, and validate defaults against them', () => {
      expect(messagesOf({ type: 'radio' })).toEqual([
        'Select, multi-select, radio and checkbox fields need at least one option',
      ]);
      expect(accepts({ type: 'checkboxes' })).toBe(false);
      expect(accepts({ type: 'radio', options, defaultValue: 'Low' })).toBe(true);
      expect(accepts({ type: 'radio', options, defaultValue: 'None' })).toBe(false);
      expect(accepts({ type: 'checkboxes', options, defaultValue: ['Low'] })).toBe(true);
      expect(accepts({ type: 'checkboxes', options, defaultValue: ['None'] })).toBe(false);
    });

    it('are searchable like select and multi-select', () => {
      expect(
        metadataSearchText(
          [
            { key: 'r', label: 'R', type: 'radio', required: false, options },
            { key: 'c', label: 'C', type: 'checkboxes', required: false, options },
          ],
          { r: 'High', c: ['Low', 'Medium'] },
        ),
      ).toBe('High Low Medium');
    });
  });

  it('refuses options, min and max on the types that do not take them, with the new messages', () => {
    expect(messagesOf({ type: 'text', options: ['A'] })).toEqual([
      'Only select, multi-select, radio and checkbox fields take options',
    ]);
    expect(messagesOf({ type: 'time', max: 5 })).toEqual([
      'Only number, currency and percentage fields take min and max',
    ]);
    expect(accepts({ type: 'datetime', min: 1 })).toBe(false);
    expect(accepts({ type: 'radio', options: ['A'], min: 1 })).toBe(false);
  });

  it('keeps plain numbers free of the two-decimal rule', () => {
    expect(valueOk({ type: 'number' }, 0.125)).toBe(true);
  });

  it('makes phone, datetime and time values searchable as written', () => {
    expect(
      metadataSearchText(
        [
          { key: 'p', label: 'P', type: 'phone', required: false },
          { key: 'd', label: 'D', type: 'datetime', required: false },
          { key: 't', label: 'T', type: 'time', required: false },
        ],
        { p: '+49 30 1234', d: '2026-09-30T14:30Z', t: '09:15' },
      ),
    ).toBe('+49 30 1234 2026-09-30T14:30Z 09:15');
  });
});

describe('edge cases', () => {
  const define = (field: Record<string, unknown>) =>
    FieldDefinitionSchema.safeParse({ key: 'f', label: 'F', type: 'text', ...field });
  const issuesOf = (field: Record<string, unknown>) => {
    const result = define(field);
    return result.success
      ? []
      : result.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        }));
  };
  const parseOne = (field: Omit<FieldDefinition, 'key' | 'label'>, value: unknown) =>
    buildMetadataSchema([{ key: 'f', label: 'F', ...field }]).safeParse({ f: value });

  it('refuses keys named after Object.prototype members', () => {
    for (const key of [
      'constructor',
      'valueOf',
      'toString',
      'hasOwnProperty',
      'isPrototypeOf',
      'propertyIsEnumerable',
      'toLocaleString',
    ]) {
      expect(issuesOf({ key }), key).toEqual([
        { path: 'key', message: 'This key is reserved; choose another label' },
      ]);
    }
    expect(define({ key: 'constructor2' }).success).toBe(true);
  });

  it('reads only own properties, so a missing field never picks up an inherited member', () => {
    const schema = buildMetadataSchema([
      { key: 'valueOf', label: 'Value of', type: 'text', required: false },
      { key: 'toString', label: 'To string', type: 'text', required: false, defaultValue: 'x' },
    ]);
    expect(schema.parse({})).toEqual({ toString: 'x' });
    expect(schema.parse({ valueOf: 'kept' })).toEqual({ valueOf: 'kept', toString: 'x' });
    expect(
      metadataSearchText([{ key: 'valueOf', label: 'V', type: 'text', required: false }], {}),
    ).toBe('');
  });

  it('stores a datetime default in canonical form too', () => {
    const schema = buildMetadataSchema([
      {
        key: 'f',
        label: 'F',
        type: 'datetime',
        required: false,
        defaultValue: '2026-01-01T09:00Z',
      },
    ]);
    expect(schema.parse({}).f).toBe('2026-01-01T09:00:00.000Z');
    expect(schema.parse({ f: '2026-01-01T09:00:15Z' }).f).toBe('2026-01-01T09:00:15.000Z');
  });

  it('checks two decimals exactly, and refuses amounts too large to check', () => {
    const eur = { type: 'currency', currency: 'EUR', required: true } as const;
    expect(parseOne(eur, 0.1 + 0.2).success).toBe(false);
    expect(parseOne(eur, 1.005).success).toBe(false);
    expect(parseOne(eur, 1.13).success).toBe(true);
    expect(parseOne(eur, 4.35).success).toBe(true);
    expect(parseOne(eur, 90_000_000_000_000).success).toBe(true);
    const huge = parseOne(eur, 1e21);
    expect(huge.success).toBe(false);
    expect(huge.error?.issues.map((issue) => issue.message)).toContain('Too large');
    expect(parseOne(eur, -1e21).success).toBe(false);
    expect(parseOne({ type: 'percentage', required: true, max: 200 }, -1).success).toBe(false);
  });

  it('explains a percentage bound that clashes with the default one', () => {
    expect(issuesOf({ type: 'percentage', min: 150 })).toEqual([
      { path: 'min', message: "min must not exceed max (a percentage's max defaults to 100)" },
    ]);
    expect(issuesOf({ type: 'percentage', max: -5 })).toEqual([
      { path: 'max', message: "max must not be below min (a percentage's min defaults to 0)" },
    ]);
    expect(issuesOf({ type: 'number', min: 5, max: 1 })).toEqual([
      { path: 'min', message: 'min must not exceed max' },
    ]);
  });

  it('exposes the effective bounds', () => {
    expect(effectiveBounds({ type: 'percentage' })).toEqual({ min: 0, max: 100 });
    expect(effectiveBounds({ type: 'percentage', max: 200 })).toEqual({ min: 0, max: 200 });
    expect(effectiveBounds({ type: 'currency', min: 0 })).toEqual({ min: 0, max: undefined });
    expect(effectiveBounds({ type: 'number' })).toEqual({ min: undefined, max: undefined });
  });
});
