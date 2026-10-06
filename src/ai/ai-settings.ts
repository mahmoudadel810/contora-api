import type { AppConfig } from '../config/env.js';

export interface AzureSettings {
  apiKey: string;
  resourceName: string | null;
  baseURL: string | null;
  apiVersion: string;
  useDeploymentBasedUrls: boolean;
  model: string;
  modelSub: string;
}

export interface AiLimits {
  temperature: number | undefined;
  maxOutputTokens: number;
  maxSteps: number;
  maxInputChars: number;
  maxHistoryTurns: number;
  requestTimeoutMs: number;
  userRatePerMinute: number;
  tenantDailyTurns: number;
  userDailyTurns: number;
  actionTtlMinutes: number;
}

export interface AiSettings {
  enabled: boolean;
  missing: string[];
  partial: boolean;
  azure: AzureSettings | null;
  limits: AiLimits;
}

const SUPPORTED_PROVIDERS: ReadonlySet<string> = new Set(['azure']);

export function aiSettingsOf(config: AppConfig): AiSettings {
  const limits: AiLimits = {
    temperature: config.AI_TEMPERATURE,
    maxOutputTokens: config.AI_MAX_OUTPUT_TOKENS ?? 2000,
    maxSteps: config.AI_MAX_STEPS ?? 6,
    maxInputChars: config.AI_MAX_INPUT_CHARS ?? 4000,
    maxHistoryTurns: config.AI_MAX_HISTORY_TURNS ?? 20,
    requestTimeoutMs: config.AI_REQUEST_TIMEOUT_MS ?? 120000,
    userRatePerMinute: config.AI_USER_RATE_LIMIT ?? 10,
    tenantDailyTurns: config.AI_TENANT_DAILY_TURN_LIMIT ?? 500,
    userDailyTurns: config.AI_USER_DAILY_TURN_LIMIT ?? 100,
    actionTtlMinutes: config.AI_ACTION_TTL_MINUTES ?? 15,
  };

  const provider = config.AI_PROVIDER;
  const apiKey = config.AZURE_OPENAI_API_KEY;
  const baseURL = config.AZURE_OPENAI_BASE_URL ?? null;
  const resourceName = baseURL ? null : (config.AZURE_OPENAI_RESOURCE_NAME ?? null);
  const model = config.AI_MODEL;

  const missing: string[] = [];
  if (!provider || !SUPPORTED_PROVIDERS.has(provider)) missing.push('AI_PROVIDER');
  if (!baseURL && !resourceName) missing.push('AZURE_OPENAI_RESOURCE_NAME');
  if (!apiKey) missing.push('AZURE_OPENAI_API_KEY');
  if (!model) missing.push('AI_MODEL');

  const anySet = [
    config.AI_PROVIDER,
    config.AZURE_OPENAI_RESOURCE_NAME,
    config.AZURE_OPENAI_BASE_URL,
    config.AZURE_OPENAI_API_KEY,
    config.AI_MODEL,
  ].some((value) => value !== undefined);

  if (missing.length > 0 || !apiKey || !model) {
    return { enabled: false, missing, partial: anySet, azure: null, limits };
  }
  return {
    enabled: true,
    missing: [],
    partial: false,
    azure: {
      apiKey,
      resourceName,
      baseURL,
      apiVersion: config.AZURE_OPENAI_API_VERSION ?? 'v1',
      useDeploymentBasedUrls: config.AZURE_OPENAI_USE_DEPLOYMENT_URLS,
      model,
      modelSub: config.AI_MODEL_SUB ?? model,
    },
    limits,
  };
}

export const AI_SETTINGS = 'AI_SETTINGS';
