import type { z } from 'zod';
import { AppError } from '../common/errors.js';
import {
  APICallError,
  generateText,
  NoObjectGeneratedError,
  Output,
  redactProviderError,
  type LanguageModel,
  type LanguageModelUsage,
  type RedactedProviderError,
} from './deps.js';
import type { ExtractionErrorCode, ExtractionErrorReason } from './extraction.types.js';
import { MAX_RETRY_AFTER_MS } from './extraction-settings.js';

export interface TokenUsage {
  inputTokens: number | null;
  outputTokens: number | null;
}

export type ModelOutcome =
  | {
      ok: true;
      output: Record<string, unknown>;
      usage: TokenUsage;
      modelId: string | null;
      calls: number;
    }
  | {
      ok: false;
      code: ExtractionErrorCode;
      reason: ExtractionErrorReason;
      usage: TokenUsage;
      modelId: string | null;
      calls: number;
      error: RedactedProviderError | null;
    };

export interface ModelRequest {
  model: LanguageModel;
  system: string;
  user: string;
  schema: z.ZodObject;
  maxOutputTokens: number;
}

class DeadlineReached extends Error {
  override readonly name = 'DeadlineReached';
}

function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new DeadlineReached());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DeadlineReached());
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error('Model call failed'));
      },
    );
  });
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return untilAborted(new Promise<void>((resolve) => setTimeout(resolve, ms).unref()), signal);
}

type Failure = {
  retry: boolean;
  code: ExtractionErrorCode;
  reason: ExtractionErrorReason;
  waitMs: number;
  error: RedactedProviderError | null;
};

const NETWORK_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
]);

function isNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  const cause = (error as { cause?: { code?: unknown } }).cause;
  return (
    (error.name === 'TypeError' && error.message === 'fetch failed') ||
    (typeof code === 'string' && NETWORK_CODES.has(code)) ||
    (typeof cause?.code === 'string' && NETWORK_CODES.has(cause.code))
  );
}

function isContentFilter(error: APICallError): boolean {
  const data = error.data as { error?: { code?: unknown } } | undefined;
  return error.statusCode === 400 && data?.error?.code === 'content_filter';
}

function retryAfterMs(error: APICallError): number {
  const header = error.responseHeaders?.['retry-after'];
  const seconds = header === undefined ? Number.NaN : Number(header);
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, MAX_RETRY_AFTER_MS) : 0;
}

function classify(error: unknown): Failure {
  const redacted = redactProviderError(error);
  const unavailable = (retry: boolean, reason: ExtractionErrorReason, waitMs = 0): Failure => ({
    retry,
    code: 'AI_UNAVAILABLE',
    reason,
    waitMs,
    error: redacted,
  });
  if (NoObjectGeneratedError.isInstance(error)) {
    return error.finishReason === 'content-filter'
      ? unavailable(false, 'content_filter')
      : unavailable(true, 'bad_output');
  }
  if (APICallError.isInstance(error)) {
    if (isContentFilter(error)) return unavailable(false, 'content_filter');
    const status = error.statusCode;
    const retry =
      status === undefined ? error.isRetryable : status === 408 || status === 429 || status >= 500;
    return unavailable(retry, 'provider', status === 429 ? retryAfterMs(error) : 0);
  }
  if (error instanceof AppError && error.code === 'AI_DISABLED') {
    return { retry: false, code: 'AI_DISABLED', reason: 'not_configured', waitMs: 0, error: null };
  }
  if (isNetworkError(error)) return unavailable(true, 'provider');
  return unavailable(false, 'provider');
}

class UsageMeter {
  private input = 0;
  private output = 0;
  private metered = true;

  add(usage: LanguageModelUsage | undefined): void {
    if (usage?.inputTokens === undefined || usage.outputTokens === undefined) {
      this.metered = false;
      return;
    }
    this.input += usage.inputTokens;
    this.output += usage.outputTokens;
  }

  get value(): TokenUsage {
    return this.metered
      ? { inputTokens: this.input, outputTokens: this.output }
      : { inputTokens: null, outputTokens: null };
  }
}

export async function callExtractionModel(
  request: ModelRequest,
  signal: AbortSignal,
): Promise<ModelOutcome> {
  const usage = new UsageMeter();
  let calls = 0;
  let modelId: string | null = null;
  for (let attempt = 1; ; attempt += 1) {
    if (signal.aborted) {
      return timeout(usage.value, calls, modelId);
    }
    try {
      calls += 1;
      const result = await untilAborted(
        generateText({
          model: request.model,
          system: request.system,
          messages: [{ role: 'user', content: request.user }],
          output: Output.object({ schema: request.schema }),
          maxOutputTokens: request.maxOutputTokens,
          maxRetries: 0,
          abortSignal: signal,
          providerOptions: { openai: { strictJsonSchema: true } },
        }),
        signal,
      );
      usage.add(result.totalUsage);
      modelId = result.response.modelId;
      if (result.finishReason === 'content-filter') {
        return {
          ok: false,
          code: 'AI_UNAVAILABLE',
          reason: 'content_filter',
          usage: usage.value,
          modelId,
          calls,
          error: null,
        };
      }
      return {
        ok: true,
        output: result.output as Record<string, unknown>,
        usage: usage.value,
        modelId,
        calls,
      };
    } catch (error) {
      if (NoObjectGeneratedError.isInstance(error)) {
        usage.add(error.usage);
        modelId = error.response?.modelId ?? modelId;
      }
      if (signal.aborted || error instanceof DeadlineReached) {
        return timeout(usage.value, calls, modelId);
      }
      const failure = classify(error);
      if (failure.retry && attempt === 1) {
        if (failure.waitMs > 0) {
          try {
            await sleep(failure.waitMs, signal);
          } catch {
            return timeout(usage.value, calls, modelId);
          }
        }
        continue;
      }
      return {
        ok: false,
        code: failure.code,
        reason: failure.reason,
        usage: usage.value,
        modelId,
        calls,
        error: failure.error,
      };
    }
  }
}

function timeout(usage: TokenUsage, calls: number, modelId: string | null): ModelOutcome {
  return {
    ok: false,
    code: 'EXTRACTION_TIMEOUT',
    reason: 'model',
    usage,
    modelId,
    calls,
    error: null,
  };
}
