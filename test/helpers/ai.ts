import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { getConnectionToken } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import { AiProvider } from '../../src/ai/ai-provider.js';
import type { Frame } from '../../src/ai/frames.js';
import type { Actor } from './actors.js';
import { reply, ScriptedAiProvider, type Step } from './scripted-ai.js';
import { createTestApp, type TestApp } from './test-app.js';

export const AI_TEST_ENV: Record<string, string> = {
  AI_PROVIDER: 'azure',
  AZURE_OPENAI_RESOURCE_NAME: 'test-resource',
  AZURE_OPENAI_API_KEY: 'fake-test-key-not-a-secret',
  AI_MODEL: 'test-model',
  AI_USER_RATE_LIMIT: '1000',
  AI_TENANT_DAILY_TURN_LIMIT: '100000',
  AI_USER_DAILY_TURN_LIMIT: '100000',
  AI_REQUEST_TIMEOUT_MS: '30000',
};

export const AI_DISABLED_ENV: Record<string, string> = Object.fromEntries(
  Object.keys(AI_TEST_ENV).map((name) => [name, '']),
);

export interface AiTestApp {
  ctx: TestApp;
  ai: ScriptedAiProvider;
  db: Connection;
}

export async function createAiApp(env: Record<string, string> = {}): Promise<AiTestApp> {
  const ai = new ScriptedAiProvider();
  const ctx = await createTestApp(
    [],
    { ...AI_TEST_ENV, ...env },
    { configure: (builder) => builder.overrideProvider(AiProvider).useValue(ai) },
  );
  return { ctx, ai, db: ctx.app.get<Connection>(getConnectionToken()) };
}

export const NO_CONTEXT = {
  page: 'other',
  recordId: null,
  folderId: null,
  contentTypeId: null,
  search: null,
  selectedRecordIds: [],
};

export function chatBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { sessionId: null, message: 'Hello', mode: 'send', context: NO_CONTEXT, ...overrides };
}

export const replies = (n: number, text = 'OK'): Step[] =>
  Array.from({ length: n }, () => reply(text));

export function framesOf(text: string): Frame[] {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Frame);
}

export interface ChatResult {
  status: number;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  frames: Frame[];
  raw: string;
}

export async function chat(
  ctx: TestApp,
  actor: Pick<Actor, 'token'>,
  body: Record<string, unknown> = chatBody(),
): Promise<ChatResult> {
  const res = await ctx
    .http()
    .post('/api/v1/ai/chat')
    .set('Authorization', `Bearer ${actor.token}`)
    .send(body)
    .buffer(true)
    .parse((response, done) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => (text += chunk));
      response.on('end', () => done(null, text));
    });
  const raw = res.body as string;
  return {
    status: res.status,
    headers: res.headers as Record<string, string>,
    body: res.status === 200 ? {} : (JSON.parse(raw) as Record<string, unknown>),
    frames: res.status === 200 ? framesOf(raw) : [],
    raw,
  };
}

export async function baseUrlOf(ctx: TestApp): Promise<string> {
  const server = ctx.app.getHttpServer() as Server;
  if (!server.listening) await new Promise<void>((resolve) => server.listen(0, resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

export interface OpenStream {
  status: number;
  waitForFrames(count: number): Promise<Frame[]>;
  abort(): void;
  done: Promise<Frame[]>;
}

export async function openChat(
  ctx: TestApp,
  actor: Pick<Actor, 'token'>,
  body: Record<string, unknown>,
): Promise<OpenStream> {
  const controller = new AbortController();
  const response = await fetch(`${await baseUrlOf(ctx)}/api/v1/ai/chat`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${actor.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: controller.signal,
  });
  let text = '';
  const complete = () => framesOf(text.slice(0, text.lastIndexOf('\n') + 1));
  const waiters: Array<{ count: number; resolve: (frames: Frame[]) => void }> = [];
  const check = () => {
    const frames = complete();
    for (const waiter of waiters.slice()) {
      if (frames.length >= waiter.count) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(frames);
      }
    }
  };
  const done = (async () => {
    const decoder = new TextDecoder();
    try {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        text += decoder.decode(chunk, { stream: true });
        check();
      }
    } catch {}
    return complete();
  })();
  return {
    status: response.status,
    waitForFrames: (count) =>
      new Promise((resolve) => {
        waiters.push({ count, resolve });
        check();
      }),
    abort: () => controller.abort(),
    done,
  };
}

export async function eventually<T>(
  probe: () => Promise<T>,
  timeoutMs = 5000,
): Promise<NonNullable<T>> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value as NonNullable<T>;
    if (Date.now() > until) throw new Error('Condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

export function searchArgs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    q: null,
    contentTypeId: null,
    folderId: null,
    includeSubfolders: null,
    tags: null,
    dateField: null,
    from: null,
    to: null,
    meta: null,
    sort: null,
    order: null,
    page: null,
    ...overrides,
  };
}
