import { z } from 'zod';

export const FIELD_TYPES = [
  'text',
  'textarea',
  'number',
  'boolean',
  'date',
  'email',
  'select',
  'multiselect',
  'url',
  'user',
  'phone',
  'datetime',
  'time',
  'currency',
  'percentage',
  'radio',
  'checkboxes',
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export type FieldValue = string | number | boolean | string[];

const WITH_OPTIONS: ReadonlySet<FieldType> = new Set<FieldType>([
  'select',
  'multiselect',
  'radio',
  'checkboxes',
]);

const WITH_BOUNDS: ReadonlySet<FieldType> = new Set<FieldType>([
  'number',
  'currency',
  'percentage',
]);

export interface FieldDefinition {
  key: string;
  label: string;
  type: FieldType;
  required: boolean;
  options?: string[];
  defaultValue?: FieldValue;
  min?: number;
  max?: number;
  maxLength?: number;
  currency?: string;
}

interface FieldTypeHandler {
  valueSchema(field: FieldDefinition): z.ZodType<FieldValue>;
  searchText(value: unknown): string | null;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function isRealDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
}

const asText = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : null;

const USER_ID = /^[a-f0-9]{24}$/;

const PHONE = /^\+?[0-9][0-9 ()\-.]{3,28}[0-9]$/;
const UTC_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{3})?)?Z$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export function canonicalInstant(value: string): string | null {
  if (!UTC_DATETIME.test(value)) return null;
  const full = value.length === 17 ? `${value.slice(0, 16)}:00.000Z` : value;
  const padded = full.length === 20 ? `${full.slice(0, 19)}.000Z` : full;
  const parsed = new Date(padded);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === padded ? padded : null;
}

const isCheckable = (value: number): boolean => Number.isSafeInteger(Math.round(value * 100));
const hasAtMostTwoDecimals = (value: number): boolean => Math.round(value * 100) / 100 === value;

export function effectiveBounds(field: Pick<FieldDefinition, 'type' | 'min' | 'max'>): {
  min?: number;
  max?: number;
} {
  const percentage = field.type === 'percentage';
  return {
    min: field.min ?? (percentage ? 0 : undefined),
    max: field.max ?? (percentage ? 100 : undefined),
  };
}

function boundedNumber(field: FieldDefinition) {
  const { min, max } = effectiveBounds(field);
  let schema = z.number();
  if (min !== undefined) schema = schema.min(min);
  if (max !== undefined) schema = schema.max(max);
  return schema;
}

const numberText = (value: unknown): string | null =>
  typeof value === 'number' ? String(value) : null;

const amount: FieldTypeHandler = {
  valueSchema: (field) =>
    boundedNumber(field)
      .refine(isCheckable, 'Too large')
      .refine(
        (value) => !isCheckable(value) || hasAtMostTwoDecimals(value),
        'At most two decimals',
      ),
  searchText: numberText,
};

const select: FieldTypeHandler = {
  valueSchema: (field) => {
    const options = field.options ?? [];
    return z.string().refine((value) => options.includes(value), 'Not one of the allowed options');
  },
  searchText: asText,
};

const multiselect: FieldTypeHandler = {
  valueSchema: (field) => {
    const options = field.options ?? [];
    return z
      .array(
        z.string().refine((value) => options.includes(value), 'Not one of the allowed options'),
      )
      .min(1)
      .max(options.length)
      .refine((values) => new Set(values).size === values.length, 'Options must not repeat');
  },
  searchText: (value) =>
    Array.isArray(value) && value.length > 0 ? value.map(String).join(' ') : null,
};

const registry: Record<FieldType, FieldTypeHandler> = {
  text: {
    valueSchema: (field) =>
      z
        .string()
        .trim()
        .min(1)
        .max(field.maxLength ?? 1000),
    searchText: asText,
  },
  textarea: {
    valueSchema: (field) =>
      z
        .string()
        .trim()
        .min(1)
        .max(field.maxLength ?? 20000),
    searchText: asText,
  },
  number: {
    valueSchema: boundedNumber,
    searchText: numberText,
  },
  boolean: {
    valueSchema: () => z.boolean(),
    searchText: () => null,
  },
  date: {
    valueSchema: () =>
      z.string().regex(DATE_ONLY, 'Expected YYYY-MM-DD').refine(isRealDate, 'Invalid date'),
    searchText: asText,
  },
  email: {
    valueSchema: () => z.string().trim().toLowerCase().pipe(z.email('Invalid email address')),
    searchText: asText,
  },
  select,
  multiselect,
  url: {
    valueSchema: () =>
      z
        .string()
        .trim()
        .max(2000)
        .pipe(z.url({ protocol: /^https?$/, error: 'Expected an http or https address' })),
    searchText: asText,
  },
  user: {
    valueSchema: () => z.string().regex(USER_ID, 'Expected a user of this tenant'),
    searchText: () => null,
  },
  phone: {
    valueSchema: () => z.string().trim().max(30).regex(PHONE, 'Expected a phone number'),
    searchText: asText,
  },
  datetime: {
    valueSchema: () =>
      z
        .string()
        .regex(UTC_DATETIME, 'Expected YYYY-MM-DDTHH:mm[:ss[.sss]]Z (UTC)')
        .refine((value) => canonicalInstant(value) !== null, 'Invalid date and time')
        .transform((value) => canonicalInstant(value) as string),
    searchText: asText,
  },
  time: {
    valueSchema: () => z.string().regex(TIME, 'Expected HH:mm between 00:00 and 23:59'),
    searchText: asText,
  },
  currency: amount,
  percentage: amount,
  radio: select,
  checkboxes: multiselect,
};

export function isReservedKey(key: string): boolean {
  return key in Object.prototype;
}

export function valueSchemaFor(field: FieldDefinition): z.ZodType<FieldValue> {
  return registry[field.type].valueSchema(field);
}

export const FieldDefinitionSchema = z
  .object({
    key: z
      .string()
      .regex(
        /^[a-z][a-zA-Z0-9]{0,39}$/,
        'Key must start with a lowercase letter and contain only letters and digits',
      )
      .refine((key) => !isReservedKey(key), 'This key is reserved; choose another label'),
    label: z.string().trim().min(1).max(80),
    type: z.enum(FIELD_TYPES),
    required: z.boolean().default(false),
    options: z.array(z.string().trim().min(1).max(80)).min(1).max(100).optional(),
    defaultValue: z
      .union([z.string(), z.number(), z.boolean(), z.array(z.string()).max(100)])
      .optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    maxLength: z.number().int().positive().max(20000).optional(),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/, 'Expected an ISO 4217 currency code, such as EUR')
      .optional(),
  })
  .strict()
  .superRefine((field, ctx) => {
    if (WITH_OPTIONS.has(field.type) && !field.options) {
      ctx.addIssue({
        code: 'custom',
        path: ['options'],
        message: 'Select, multi-select, radio and checkbox fields need at least one option',
      });
    }
    if (!WITH_OPTIONS.has(field.type) && field.options) {
      ctx.addIssue({
        code: 'custom',
        path: ['options'],
        message: 'Only select, multi-select, radio and checkbox fields take options',
      });
    }
    if (field.type === 'currency' && field.currency === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['currency'],
        message: 'Currency fields need a currency code',
      });
    }
    if (field.type !== 'currency' && field.currency !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['currency'],
        message: 'Only currency fields take a currency code',
      });
    }
    if (field.type === 'user' && field.defaultValue !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['defaultValue'],
        message: 'User fields take no default value',
      });
      return;
    }
    if (field.options && new Set(field.options).size !== field.options.length) {
      ctx.addIssue({ code: 'custom', path: ['options'], message: 'Options must be unique' });
    }
    if ((field.min !== undefined || field.max !== undefined) && !WITH_BOUNDS.has(field.type)) {
      ctx.addIssue({
        code: 'custom',
        path: ['min'],
        message: 'Only number, currency and percentage fields take min and max',
      });
    }
    const { min, max } = effectiveBounds(field);
    if (min !== undefined && max !== undefined && min > max) {
      if (field.type === 'percentage' && field.max === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['min'],
          message: "min must not exceed max (a percentage's max defaults to 100)",
        });
      } else if (field.type === 'percentage' && field.min === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['max'],
          message: "max must not be below min (a percentage's min defaults to 0)",
        });
      } else {
        ctx.addIssue({ code: 'custom', path: ['min'], message: 'min must not exceed max' });
      }
    }
    if (field.maxLength !== undefined && field.type !== 'text' && field.type !== 'textarea') {
      ctx.addIssue({
        code: 'custom',
        path: ['maxLength'],
        message: 'Only text fields take maxLength',
      });
    }
    if (field.defaultValue !== undefined && (!WITH_OPTIONS.has(field.type) || field.options)) {
      const result = registry[field.type]
        .valueSchema(field as FieldDefinition)
        .safeParse(field.defaultValue);
      if (!result.success) {
        ctx.addIssue({
          code: 'custom',
          path: ['defaultValue'],
          message: `Default value is not a valid ${field.type}: ${result.error.issues[0]?.message ?? 'invalid'}`,
        });
      }
    }
  });

const emptyAsMissing = (value: unknown): unknown =>
  value === '' || value === null || (Array.isArray(value) && value.length === 0)
    ? undefined
    : value;

const ownPropertiesOnly = (input: unknown): unknown =>
  input !== null && typeof input === 'object' && !Array.isArray(input)
    ? Object.assign(Object.create(null) as object, input)
    : input;

export function buildMetadataSchema(fields: FieldDefinition[]): z.ZodType<Record<string, unknown>> {
  const shape: Record<string, z.ZodType> = {};
  for (const field of fields) {
    const value = registry[field.type].valueSchema(field);
    const withDefault =
      field.defaultValue === undefined
        ? value
        : field.type === 'datetime'
          ? value.prefault(field.defaultValue)
          : value.default(field.defaultValue);
    shape[field.key] = z.preprocess(
      emptyAsMissing,
      field.required || field.defaultValue !== undefined ? withDefault : value.optional(),
    );
  }
  return z.preprocess(ownPropertiesOnly, z.object(shape).strict());
}

export function metadataSearchText(
  fields: FieldDefinition[],
  metadata: Record<string, unknown>,
): string {
  return fields
    .map((field) =>
      registry[field.type].searchText(
        Object.hasOwn(metadata, field.key) ? metadata[field.key] : undefined,
      ),
    )
    .filter((text): text is string => text !== null)
    .join(' ');
}
