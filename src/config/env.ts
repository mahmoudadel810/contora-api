import { z } from 'zod';

const flag = (fallback: 'true' | 'false') =>
  z
    .enum(['true', 'false'])
    .default(fallback)
    .transform((value) => value === 'true');

const booleanFlag = flag('false');

const EXAMPLE_SECRET_PREFIX = 'replace-with-';
const MIN_DISTINCT_SECRET_CHARS = 10;

export const AI_OUTPUT_TOKENS_CEILING = 16000;

const blankToUndefined = (value: unknown) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

const optionalText = z.preprocess(blankToUndefined, z.string().trim().optional());

const optionalFlag = (fallback: 'true' | 'false') =>
  z.preprocess(
    (value) => (typeof value === 'string' ? blankToUndefined(value.trim().toLowerCase()) : value),
    flag(fallback),
  );

function optionalNumber<T extends z.ZodType<unknown, number>>(schema: T) {
  return z.preprocess(blankToUndefined, z.coerce.number().pipe(schema).optional());
}

const unsetIfBlank = (value: unknown) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;
const extractionNumber = (fallback: number, min: number, int = true) =>
  z.preprocess(
    unsetIfBlank,
    (int ? z.coerce.number().int() : z.coerce.number()).min(min).default(fallback),
  );
const extractionFlag = z.preprocess(
  (value) => (typeof value === 'string' ? unsetIfBlank(value.trim().toLowerCase()) : value),
  booleanFlag,
);

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    MONGODB_URI: z.string().min(1),
    JWT_SECRET: z.string().min(32),
    JWT_EXPIRES_IN: z
      .string()
      .regex(/^\d+(s|m|h|d)$/, 'Use a duration such as 15m or 1h')
      .default('15m'),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(7),
    COOKIE_SECURE: booleanFlag,
    ALLOW_INSECURE_COOKIES: booleanFlag,
    FRONTEND_URL: z.url().default('http://localhost:4300'),
    STORAGE_DIR: z.string().min(1).default('./storage'),
    MAX_UPLOAD_MB: z.coerce.number().positive().default(100),
    INVITATION_TTL_DAYS: z.coerce.number().int().positive().default(7),
    AUTH_RATE_LIMIT: z.coerce.number().int().positive().default(20),
    TRUST_PROXY: z.coerce.number().int().min(0).max(10).default(0),
    BLOB_REUSE_GRACE_SECONDS: z.coerce.number().int().min(0).default(60),
    COMMENT_MENTION_MAX_RECIPIENTS: z.coerce.number().int().min(1).max(200).default(50),
    AI_PROVIDER: optionalText,
    AZURE_OPENAI_RESOURCE_NAME: optionalText,
    AZURE_OPENAI_BASE_URL: optionalText,
    AZURE_OPENAI_API_KEY: optionalText,
    AZURE_OPENAI_API_VERSION: optionalText,
    AZURE_OPENAI_USE_DEPLOYMENT_URLS: optionalFlag('true'),
    AI_MODEL: optionalText,
    AI_MODEL_SUB: optionalText,
    AI_TEMPERATURE: optionalNumber(z.number().min(0).max(2)),
    AI_MAX_OUTPUT_TOKENS: optionalNumber(
      z
        .number()
        .int()
        .positive()
        .transform((tokens) => Math.min(tokens, AI_OUTPUT_TOKENS_CEILING)),
    ),
    AI_MAX_STEPS: optionalNumber(z.number().int().min(1).max(50)),
    AI_MAX_INPUT_CHARS: optionalNumber(z.number().int().min(1).max(20000)),
    AI_MAX_HISTORY_TURNS: optionalNumber(z.number().int().min(0).max(200)),
    AI_REQUEST_TIMEOUT_MS: optionalNumber(z.number().int().min(100)),
    AI_USER_RATE_LIMIT: optionalNumber(z.number().int().positive()),
    AI_TENANT_DAILY_TURN_LIMIT: optionalNumber(z.number().int().min(0)),
    AI_USER_DAILY_TURN_LIMIT: optionalNumber(z.number().int().min(0)),
    AI_ACTION_TTL_MINUTES: optionalNumber(z.number().int().positive()),
    AI_EXTRACTION_MAX_FILE_MB: extractionNumber(20, 0.001, false),
    AI_EXTRACTION_MAX_CHARS: extractionNumber(30000, 1000),
    AI_EXTRACTION_MAX_FIELDS: extractionNumber(24, 1),
    AI_EXTRACTION_MAX_OUTPUT_TOKENS: extractionNumber(4000, 1),
    AI_EXTRACTION_TIMEOUT_MS: extractionNumber(90000, 100),
    AI_EXTRACTION_CONCURRENCY: extractionNumber(2, 1),
    AI_EXTRACTION_USER_IN_FLIGHT: extractionNumber(1, 1),
    AI_EXTRACTION_USER_OPEN_JOBS: extractionNumber(3, 1),
    AI_EXTRACTION_TENANT_IN_FLIGHT: extractionNumber(5, 1),
    AI_EXTRACTION_USER_DAILY_LIMIT: extractionNumber(50, 0),
    AI_EXTRACTION_TENANT_DAILY_LIMIT: extractionNumber(500, 0),
    AI_EXTRACTION_TENANT_DAILY_TOKENS: extractionNumber(20000000, 0),
    AI_EXTRACTION_STAGING_TTL_MINUTES: extractionNumber(120, 1),
    AI_EXTRACTION_SWEEP_MINUTES: extractionNumber(10, 0),
    AI_EXTRACTION_CONFIRM_STALE_MINUTES: extractionNumber(15, 1),
    AI_EXTRACTION_VISION: extractionFlag,
    SEARCH_MAX_TIME_MS: z.coerce.number().int().positive().default(3000),
    SEARCH_RATE_LIMIT: z.coerce.number().int().positive().default(60),
    SEARCH_EXPORT_RATE_LIMIT: z.coerce.number().int().positive().default(10),
  })
  .superRefine((config, ctx) => {
    if (config.NODE_ENV !== 'production') return;
    if (config.JWT_SECRET.startsWith(EXAMPLE_SECRET_PREFIX)) {
      ctx.addIssue({
        code: 'custom',
        path: ['JWT_SECRET'],
        message: 'Replace the example value with a random secret',
      });
    } else if (new Set(config.JWT_SECRET).size < MIN_DISTINCT_SECRET_CHARS) {
      ctx.addIssue({
        code: 'custom',
        path: ['JWT_SECRET'],
        message: `Use a random secret with at least ${MIN_DISTINCT_SECRET_CHARS} distinct characters`,
      });
    }
    if (!config.COOKIE_SECURE && !config.ALLOW_INSECURE_COOKIES) {
      ctx.addIssue({
        code: 'custom',
        path: ['COOKIE_SECURE'],
        message:
          'Must be true in production (HTTPS); set ALLOW_INSECURE_COOKIES=true to serve over plain HTTP deliberately',
      });
    }
  });

export type AppConfig = z.infer<typeof envSchema>;

export const APP_CONFIG = 'APP_CONFIG';

export function loadConfig(source: Record<string, string | undefined> = process.env): AppConfig {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const problems = result.error.issues.map(
      (issue) => `${issue.path.join('.')}: ${issue.message}`,
    );
    throw new Error(`Invalid environment configuration: ${problems.join('; ')}`);
  }
  return result.data;
}

export function durationToSeconds(duration: string): number {
  const match = /^(\d+)(s|m|h|d)$/.exec(duration);
  if (!match) throw new Error(`Invalid duration: ${duration}`);
  const unit = { s: 1, m: 60, h: 3600, d: 86400 }[match[2] as 's' | 'm' | 'h' | 'd'];
  return Number(match[1]) * unit;
}
