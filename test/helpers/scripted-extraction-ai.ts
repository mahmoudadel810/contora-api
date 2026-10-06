import { MockLanguageModelV3 } from 'ai/test';
import {
  AiProvider,
  APICallError,
  aiDisabled,
  type AiProviderStatus,
  type ModelTier,
} from '../../src/ai-extraction/deps.js';

type GenerateOptions = Parameters<MockLanguageModelV3['doGenerate']>[0];
type GenerateResult = Awaited<ReturnType<MockLanguageModelV3['doGenerate']>>;
export type GenerateStep = GenerateResult | ((options: GenerateOptions) => Promise<GenerateResult>);

export interface AnswerField {
  value: unknown;
  confidence: number;
  sourceSnippet: string | null;
}

export const EXTRACTION_USAGE = {
  inputTokens: { total: 120, noCache: 120, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 30, text: 30, reasoning: 0 },
};

const UNMETERED = {
  inputTokens: {
    total: undefined,
    noCache: undefined,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
};

export function rawText(text: string, options: { metered?: boolean } = {}): GenerateStep {
  return {
    content: [{ type: 'text', text }],
    finishReason: { unified: 'stop', raw: 'stop' },
    usage: options.metered === false ? UNMETERED : EXTRACTION_USAGE,
    warnings: [],
  } as GenerateResult;
}

export function answer(fields: Record<string, AnswerField>): GenerateStep {
  return rawText(JSON.stringify(fields));
}

export function nullAnswer(keys: string[]): GenerateStep {
  return answer(
    Object.fromEntries(
      keys.map((key) => [key, { value: null, confidence: 0, sourceSnippet: null }]),
    ),
  );
}

export const filtered: GenerateStep = {
  content: [],
  finishReason: { unified: 'content-filter', raw: 'content_filter' },
  usage: EXTRACTION_USAGE,
  warnings: [],
} as GenerateResult;

export function providerError(statusCode: number, headers?: Record<string, string>): GenerateStep {
  return () =>
    Promise.reject(
      new APICallError({
        message: `Scripted provider error ${statusCode}`,
        url: 'https://scripted.invalid/chat/completions',
        requestBodyValues: {},
        statusCode,
        responseHeaders: headers,
        isRetryable: statusCode === 408 || statusCode === 429 || statusCode >= 500,
      }),
    );
}

export function throws(error: Error): GenerateStep {
  return () => Promise.reject(error);
}

export function hangs(seen: { signal?: AbortSignal } = {}): GenerateStep {
  return (options) => {
    seen.signal = options.abortSignal;
    return new Promise<GenerateResult>((_, reject) => {
      const abort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      if (options.abortSignal?.aborted) abort();
      else options.abortSignal?.addEventListener('abort', abort, { once: true });
    });
  };
}

export function stalls(): GenerateStep {
  return () => new Promise<GenerateResult>(() => undefined);
}

export function after(before: () => Promise<void>, step: GenerateStep): GenerateStep {
  return async (options) => {
    await before();
    return typeof step === 'function' ? step(options) : step;
  };
}

export class ScriptedExtractionProvider extends AiProvider {
  enabled = true;
  private queue: GenerateStep[] = [];
  readonly mock = new MockLanguageModelV3({
    provider: 'scripted',
    modelId: 'scripted-extraction',
    doGenerate: async (options) => {
      const step = this.queue.shift();
      if (!step) throw new Error('The extraction script has no step left');
      return typeof step === 'function' ? step(options) : step;
    },
  });

  script(...steps: GenerateStep[]): this {
    this.queue = [...steps];
    return this;
  }

  remaining(): number {
    return this.queue.length;
  }

  calls(): GenerateOptions[] {
    return this.mock.doGenerateCalls;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  status(): AiProviderStatus {
    return this.enabled
      ? { enabled: true, reason: null, model: 'scripted-extraction' }
      : { enabled: false, reason: 'NOT_CONFIGURED', model: null };
  }

  model(_tier: ModelTier): MockLanguageModelV3 {
    if (!this.enabled) throw aiDisabled();
    return this.mock;
  }

  promptsText(): string {
    return JSON.stringify(this.mock.doGenerateCalls.map((call) => call.prompt));
  }
}
