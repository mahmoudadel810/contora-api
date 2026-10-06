import type { AppConfig } from '../config/env.js';
import { AI_OUTPUT_TOKENS_CEILING } from './deps.js';
import { MAX_FIELDS_CEILING } from './extraction.types.js';

const MIB = 1024 * 1024;

export const CONFIRM_DEADLINE_MS = 5 * 60 * 1000;
export const CLAIM_EXTENSION_MS = 10 * 60 * 1000;
export const QUEUED_STUCK_MS = 2 * 60 * 1000;
export const PROCESSING_GRACE_MS = 60 * 1000;
export const HOUSEKEEPING_BATCH = 200;
export const BUSY_RETRY_AFTER_SECONDS = 15;
export const MAX_RETRY_AFTER_MS = 10 * 1000;

export interface ExtractionSettings {
  maxFileMb: number;
  maxFileBytes: number;
  maxChars: number;
  maxFields: number;
  maxOutputTokens: number;
  timeoutMs: number;
  concurrency: number;
  userInFlight: number;
  userOpenJobs: number;
  tenantInFlight: number;
  userDailyLimit: number;
  tenantDailyLimit: number;
  tenantDailyTokens: number;
  stagingTtlMs: number;
  sweepIntervalMs: number;
  confirmStaleMs: number;
  vision: boolean;
  storageDir: string;
}

export const EXTRACTION_SETTINGS = 'EXTRACTION_SETTINGS';

export function extractionSettingsOf(config: AppConfig): ExtractionSettings {
  const maxFileMb = Math.min(config.AI_EXTRACTION_MAX_FILE_MB, config.MAX_UPLOAD_MB);
  return {
    maxFileMb,
    maxFileBytes: Math.floor(maxFileMb * MIB),
    maxChars: config.AI_EXTRACTION_MAX_CHARS,
    maxFields: Math.min(config.AI_EXTRACTION_MAX_FIELDS, MAX_FIELDS_CEILING),
    maxOutputTokens: Math.min(config.AI_EXTRACTION_MAX_OUTPUT_TOKENS, AI_OUTPUT_TOKENS_CEILING),
    timeoutMs: config.AI_EXTRACTION_TIMEOUT_MS,
    concurrency: config.AI_EXTRACTION_CONCURRENCY,
    userInFlight: config.AI_EXTRACTION_USER_IN_FLIGHT,
    userOpenJobs: config.AI_EXTRACTION_USER_OPEN_JOBS,
    tenantInFlight: config.AI_EXTRACTION_TENANT_IN_FLIGHT,
    userDailyLimit: config.AI_EXTRACTION_USER_DAILY_LIMIT,
    tenantDailyLimit: config.AI_EXTRACTION_TENANT_DAILY_LIMIT,
    tenantDailyTokens: config.AI_EXTRACTION_TENANT_DAILY_TOKENS,
    stagingTtlMs: config.AI_EXTRACTION_STAGING_TTL_MINUTES * 60 * 1000,
    sweepIntervalMs: config.AI_EXTRACTION_SWEEP_MINUTES * 60 * 1000,
    confirmStaleMs: Math.max(
      config.AI_EXTRACTION_CONFIRM_STALE_MINUTES * 60 * 1000,
      CONFIRM_DEADLINE_MS + 60 * 1000,
    ),
    vision: config.AI_EXTRACTION_VISION,
    storageDir: config.STORAGE_DIR,
  };
}
