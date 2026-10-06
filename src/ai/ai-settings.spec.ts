import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config/env.js';
import { aiSettingsOf } from './ai-settings.js';

const base = {
  MONGODB_URI: 'mongodb://localhost:27017/test',
  JWT_SECRET: 'x'.repeat(40),
};

const FAKE_KEY = 'fake-azure-key-for-unit-tests';

const complete = {
  ...base,
  AI_PROVIDER: 'azure',
  AZURE_OPENAI_RESOURCE_NAME: 'my-resource',
  AZURE_OPENAI_API_KEY: FAKE_KEY,
  AI_MODEL: 'gpt-main',
};

describe('aiSettingsOf', () => {
  it('is disabled without any AI variable, with nothing reported missing as partial', () => {
    const settings = aiSettingsOf(loadConfig(base));
    expect(settings.enabled).toBe(false);
    expect(settings.partial).toBe(false);
    expect(settings.azure).toBeNull();
  });

  it('uses the documented defaults for the limits', () => {
    expect(aiSettingsOf(loadConfig(base)).limits).toEqual({
      temperature: undefined,
      maxOutputTokens: 2000,
      maxSteps: 6,
      maxInputChars: 4000,
      maxHistoryTurns: 20,
      requestTimeoutMs: 120000,
      userRatePerMinute: 10,
      tenantDailyTurns: 500,
      userDailyTurns: 100,
      actionTtlMinutes: 15,
    });
  });

  it('is enabled with a complete Azure configuration, and the sub model defaults to the main one', () => {
    const settings = aiSettingsOf(loadConfig(complete));
    expect(settings.enabled).toBe(true);
    expect(settings.missing).toEqual([]);
    expect(settings.azure).toEqual({
      apiKey: FAKE_KEY,
      resourceName: 'my-resource',
      baseURL: null,
      apiVersion: 'v1',
      useDeploymentBasedUrls: true,
      model: 'gpt-main',
      modelSub: 'gpt-main',
    });
  });

  it('prefers the base URL over the resource name', () => {
    const settings = aiSettingsOf(
      loadConfig({
        ...complete,
        AZURE_OPENAI_RESOURCE_NAME: '',
        AZURE_OPENAI_BASE_URL: 'https://example.openai.azure.com/openai',
        AZURE_OPENAI_API_VERSION: '2025-03-01-preview',
        AZURE_OPENAI_USE_DEPLOYMENT_URLS: 'false',
        AI_MODEL_SUB: 'gpt-small',
      }),
    );
    expect(settings.enabled).toBe(true);
    expect(settings.azure).toMatchObject({
      baseURL: 'https://example.openai.azure.com/openai',
      resourceName: null,
      apiVersion: '2025-03-01-preview',
      useDeploymentBasedUrls: false,
      modelSub: 'gpt-small',
    });
  });

  it('reads AZURE_OPENAI_USE_DEPLOYMENT_URLS as a flag: blank is the default, any case works', () => {
    const urls = (value: string) =>
      aiSettingsOf(loadConfig({ ...complete, AZURE_OPENAI_USE_DEPLOYMENT_URLS: value })).azure
        ?.useDeploymentBasedUrls;
    expect(urls('')).toBe(true);
    expect(urls('FALSE')).toBe(false);
    expect(urls(' true ')).toBe(true);
    expect(() => loadConfig({ ...complete, AZURE_OPENAI_USE_DEPLOYMENT_URLS: 'maybe' })).toThrow(
      /AZURE_OPENAI_USE_DEPLOYMENT_URLS/,
    );
  });

  it('reports the missing variable names of a partial configuration and stays disabled', () => {
    const settings = aiSettingsOf(
      loadConfig({ ...base, AI_PROVIDER: 'azure', AZURE_OPENAI_RESOURCE_NAME: 'r' }),
    );
    expect(settings.enabled).toBe(false);
    expect(settings.partial).toBe(true);
    expect(settings.missing).toEqual(['AZURE_OPENAI_API_KEY', 'AI_MODEL']);
    expect(settings.azure).toBeNull();
  });

  it('treats a key without AI_PROVIDER as partial, naming AI_PROVIDER', () => {
    const settings = aiSettingsOf(loadConfig({ ...base, AZURE_OPENAI_API_KEY: FAKE_KEY }));
    expect(settings.enabled).toBe(false);
    expect(settings.partial).toBe(true);
    expect(settings.missing).toContain('AI_PROVIDER');
    expect(settings.missing).toContain('AZURE_OPENAI_RESOURCE_NAME');
  });

  it('treats an unknown provider as not configured', () => {
    const settings = aiSettingsOf(loadConfig({ ...complete, AI_PROVIDER: 'openai' }));
    expect(settings.enabled).toBe(false);
    expect(settings.missing).toEqual(['AI_PROVIDER']);
  });

  it('clamps AI_MAX_OUTPUT_TOKENS to 16000 instead of refusing it', () => {
    const config = loadConfig({ ...complete, AI_MAX_OUTPUT_TOKENS: '64000' });
    expect(config.AI_MAX_OUTPUT_TOKENS).toBe(16000);
    expect(aiSettingsOf(config).limits.maxOutputTokens).toBe(16000);
  });

  it('reads the numeric limits', () => {
    const settings = aiSettingsOf(
      loadConfig({
        ...complete,
        AI_TEMPERATURE: '0',
        AI_MAX_STEPS: '3',
        AI_MAX_INPUT_CHARS: '100',
        AI_REQUEST_TIMEOUT_MS: '500',
        AI_USER_RATE_LIMIT: '2',
        AI_TENANT_DAILY_TURN_LIMIT: '7',
        AI_USER_DAILY_TURN_LIMIT: '1',
      }),
    );
    expect(settings.limits).toMatchObject({
      temperature: 0,
      maxSteps: 3,
      maxInputChars: 100,
      requestTimeoutMs: 500,
      userRatePerMinute: 2,
      tenantDailyTurns: 7,
      userDailyTurns: 1,
    });
  });

  it('never fails start-up for a partial configuration', () => {
    expect(() => loadConfig({ ...base, AI_PROVIDER: 'azure' })).not.toThrow();
    expect(() => loadConfig({ ...base, AI_PROVIDER: '', AZURE_OPENAI_API_KEY: '' })).not.toThrow();
  });

  it('names the variable, never the value, when a number is malformed', () => {
    expect(() => loadConfig({ ...complete, AI_MAX_STEPS: 'many' })).toThrow(/AI_MAX_STEPS/);
    try {
      loadConfig({ ...complete, AI_MAX_STEPS: 'many' });
    } catch (error) {
      expect(String(error)).not.toContain(FAKE_KEY);
    }
  });
});
