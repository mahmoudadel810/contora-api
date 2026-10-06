import { loadConfig } from '../config/env.js';
import { AI_OUTPUT_TOKENS_CEILING } from './deps.js';
import { CONFIRM_DEADLINE_MS, extractionSettingsOf } from './extraction-settings.js';

const base = {
  MONGODB_URI: 'mongodb://localhost:27017/x',
  JWT_SECRET: 'a-test-secret-that-is-long-enough-000000',
};

describe('extraction settings', () => {
  it('applies the defaults when nothing is set', () => {
    const settings = extractionSettingsOf(loadConfig(base));
    expect(settings).toMatchObject({
      maxFileMb: 20,
      maxChars: 30000,
      maxFields: 24,
      maxOutputTokens: 4000,
      timeoutMs: 90000,
      concurrency: 2,
      userInFlight: 1,
      userOpenJobs: 3,
      tenantInFlight: 5,
      userDailyLimit: 50,
      tenantDailyLimit: 500,
      tenantDailyTokens: 20000000,
      stagingTtlMs: 120 * 60 * 1000,
      sweepIntervalMs: 10 * 60 * 1000,
      confirmStaleMs: 15 * 60 * 1000,
      vision: false,
    });
    expect(settings.maxFileBytes).toBe(20 * 1024 * 1024);
  });

  it('treats blank values as unset (shells and the test app blank AI_* names)', () => {
    const settings = extractionSettingsOf(
      loadConfig({
        ...base,
        AI_EXTRACTION_MAX_FILE_MB: '',
        AI_EXTRACTION_SWEEP_MINUTES: '  ',
        AI_EXTRACTION_VISION: '',
      }),
    );
    expect(settings.maxFileMb).toBe(20);
    expect(settings.sweepIntervalMs).toBe(10 * 60 * 1000);
    expect(settings.vision).toBe(false);
  });

  it('clamps across variables: file size, field count, output budget, stale-claim limit', () => {
    const settings = extractionSettingsOf(
      loadConfig({
        ...base,
        MAX_UPLOAD_MB: '5',
        AI_EXTRACTION_MAX_FILE_MB: '20',
        AI_EXTRACTION_MAX_FIELDS: '40',
        AI_EXTRACTION_MAX_OUTPUT_TOKENS: String(AI_OUTPUT_TOKENS_CEILING + 1000),
        AI_EXTRACTION_CONFIRM_STALE_MINUTES: '1',
      }),
    );
    expect(settings.maxFileMb).toBe(5);
    expect(settings.maxFields).toBe(24);
    expect(settings.maxOutputTokens).toBe(AI_OUTPUT_TOKENS_CEILING);
    expect(settings.confirmStaleMs).toBeGreaterThan(CONFIRM_DEADLINE_MS);
  });

  it('turns the periodic sweep off with 0 and reads the vision flag', () => {
    const settings = extractionSettingsOf(
      loadConfig({ ...base, AI_EXTRACTION_SWEEP_MINUTES: '0', AI_EXTRACTION_VISION: 'TRUE' }),
    );
    expect(settings.sweepIntervalMs).toBe(0);
    expect(settings.vision).toBe(true);
  });

  it('refuses a malformed value, naming the variable', () => {
    expect(() => loadConfig({ ...base, AI_EXTRACTION_CONCURRENCY: 'many' })).toThrow(
      /AI_EXTRACTION_CONCURRENCY/,
    );
    expect(() => loadConfig({ ...base, AI_EXTRACTION_CONCURRENCY: '0' })).toThrow(
      /AI_EXTRACTION_CONCURRENCY/,
    );
  });
});
