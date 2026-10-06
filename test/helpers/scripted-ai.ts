import { simulateReadableStream } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { AiProvider, type AiProviderStatus, type ModelTier } from '../../src/ai/ai-provider.js';

type DoStreamOptions = Parameters<MockLanguageModelV3['doStream']>[0];
type DoStreamResult = Awaited<ReturnType<MockLanguageModelV3['doStream']>>;
export type Step = DoStreamResult | ((options: DoStreamOptions) => Promise<DoStreamResult>);
type Part = Record<string, unknown>;

export const USAGE = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

function finishOf(finish: 'tool-calls' | 'stop'): Part {
  return { type: 'finish', finishReason: { unified: finish, raw: finish }, usage: USAGE };
}

export function streamOf(parts: Part[], finish: 'tool-calls' | 'stop'): DoStreamResult {
  return {
    stream: simulateReadableStream({
      chunks: [{ type: 'stream-start', warnings: [] }, ...parts, finishOf(finish)] as never[],
    }),
  };
}

export const toolCall = (id: string, name: string, input: unknown): Part => ({
  type: 'tool-call',
  toolCallId: id,
  toolName: name,
  input: JSON.stringify(input),
});

export const textParts = (id: string, text: string): Part[] => [
  { type: 'text-start', id },
  { type: 'text-delta', id, delta: text },
  { type: 'text-end', id },
];

export const reply = (text: string): Step => streamOf(textParts('t', text), 'stop');

export const calls = (...parts: Part[]): Step => streamOf(parts, 'tool-calls');

export const delegate = (domain: string, task: string, id = 'd1'): Step =>
  calls(toolCall(id, 'delegate', { domain, task }));

export const fails =
  (error: Error): Step =>
  () =>
    Promise.reject(error);

export function hangs(seen: { signal?: AbortSignal }, text = 'Working'): Step {
  return (options) => {
    seen.signal = options.abortSignal;
    return Promise.resolve({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: 'stream-start', warnings: [] } as never);
          controller.enqueue({ type: 'text-start', id: 't' } as never);
          controller.enqueue({ type: 'text-delta', id: 't', delta: text } as never);
          const abort = () =>
            controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          if (options.abortSignal?.aborted) abort();
          else options.abortSignal?.addEventListener('abort', abort, { once: true });
        },
      }),
    });
  };
}

export function breaksAfterFirstPart(error: Error): Step {
  return () =>
    Promise.resolve({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: 'stream-start', warnings: [] } as never);
          controller.enqueue({ type: 'text-start', id: 't' } as never);
          controller.enqueue({ type: 'text-delta', id: 't', delta: 'Partial' } as never);
          setTimeout(() => controller.error(error), 5);
        },
      }),
    });
}

function scriptedModel(tier: ModelTier, steps: Step[]): MockLanguageModelV3 {
  const queue = [...steps];
  return new MockLanguageModelV3({
    provider: 'scripted',
    modelId: `scripted-${tier}`,
    doStream: async (options) => {
      const step = queue.shift();
      if (!step) throw new Error(`The ${tier} script has no step left`);
      return typeof step === 'function' ? step(options) : step;
    },
  });
}

export class ScriptedAiProvider extends AiProvider {
  main = scriptedModel('main', []);
  sub = scriptedModel('sub', []);

  script(main: Step[], sub: Step[] = []): this {
    this.main = scriptedModel('main', main);
    this.sub = scriptedModel('sub', sub);
    return this;
  }

  isEnabled(): boolean {
    return true;
  }

  status(): AiProviderStatus {
    return { enabled: true, reason: null, model: 'scripted-main' };
  }

  model(tier: ModelTier): MockLanguageModelV3 {
    return tier === 'main' ? this.main : this.sub;
  }

  promptsText(): string {
    return JSON.stringify([
      ...this.main.doStreamCalls.map((call) => call.prompt),
      ...this.sub.doStreamCalls.map((call) => call.prompt),
    ]);
  }
}

export function stalls(seen: { signal?: AbortSignal }): Step {
  return (options) => {
    seen.signal = options.abortSignal;
    return Promise.resolve({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: 'stream-start', warnings: [] } as never);
          controller.enqueue({ type: 'text-start', id: 't' } as never);
          controller.enqueue({ type: 'text-delta', id: 't', delta: 'Stalled' } as never);
        },
      }),
    });
  };
}
