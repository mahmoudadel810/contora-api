import type { Block } from './blocks.js';

export type Frame =
  | { type: 'session'; sessionId: string; userMessageId: string; assistantMessageId: string }
  | { type: 'status'; origin: string; label: string }
  | { type: 'delta'; origin: 'main'; text: string }
  | {
      type: 'tool';
      origin: string;
      callId: string;
      tool: string;
      state: 'running' | 'ok' | 'error';
      code: string | null;
    }
  | { type: 'block'; block: Block }
  | {
      type: 'finish';
      usage: { inputTokens: number | null; outputTokens: number | null };
      stopped: boolean;
    }
  | { type: 'error'; code: string; message: string; retryable: boolean };

export type TerminalFrame = Extract<Frame, { type: 'finish' | 'error' }>;

export interface FrameSink {
  write(frame: Frame): void;
  end(frame: TerminalFrame): void;
}

export const NDJSON_HEADERS: Readonly<Record<string, string>> = {
  'Content-Type': 'application/x-ndjson; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Accel-Buffering': 'no',
};

interface WritableResponse {
  write(chunk: string): boolean;
  end(): void;
  readonly destroyed: boolean;
  readonly writableEnded: boolean;
}

export function responseSink(res: WritableResponse): FrameSink {
  let ended = false;
  const send = (frame: Frame) => {
    if (res.destroyed || res.writableEnded) return;
    try {
      res.write(`${JSON.stringify(frame)}\n`);
    } catch {}
  };
  return {
    write(frame) {
      if (!ended) send(frame);
    },
    end(frame) {
      if (ended) return;
      ended = true;
      send(frame);
      try {
        if (!res.writableEnded) res.end();
      } catch {}
    },
  };
}
