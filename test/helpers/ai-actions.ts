import type { Test } from 'supertest';
import type { Frame } from '../../src/ai/frames.js';
import { as, type Actor } from './actors.js';
import { chat, chatBody, NO_CONTEXT, type AiTestApp, type ChatResult } from './ai.js';
import { delegate, reply, streamOf, toolCall, type Step } from './scripted-ai.js';
import type { TestApp } from './test-app.js';

export type ArgsOf =
  | Record<string, unknown>
  | ((prompt: string) => Record<string, unknown> | Promise<Record<string, unknown>>);

export interface ProposeCall {
  tool: string;
  args: ArgsOf;
}

export function actionIdsIn(prompt: string): string[] {
  return [...prompt.matchAll(/\\?"actionId\\?":\\?"([a-f0-9]{24})\\?"/g)].map((match) => match[1]);
}

function callStep(id: string, call: ProposeCall): Step {
  if (typeof call.args !== 'function') {
    return streamOf([toolCall(id, call.tool, call.args)], 'tool-calls');
  }
  const argsOf = call.args;
  return async (options) =>
    streamOf([toolCall(id, call.tool, await argsOf(JSON.stringify(options.prompt)))], 'tool-calls');
}

export interface Proposed {
  res: ChatResult;
  sessionId: string;
  assistantMessageId: string;
  actionIds: string[];
  confirmBlocks: Array<Record<string, unknown>>;
  planBlocks: Array<Record<string, unknown>>;
  toolFrames: Array<Record<string, unknown>>;
}

export interface ProposeOptions {
  message?: string;
  context?: Record<string, unknown>;
  sessionId?: string;
}

export function propose(
  app: AiTestApp,
  actor: Pick<Actor, 'token'>,
  domain: string,
  proposeCalls: ProposeCall[],
  options: ProposeOptions = {},
): Promise<Proposed> {
  return proposeAcross(app, actor, [{ domain, calls: proposeCalls }], options);
}

export async function proposeAcross(
  app: AiTestApp,
  actor: Pick<Actor, 'token'>,
  delegations: Array<{ domain: string; calls: ProposeCall[] }>,
  options: ProposeOptions = {},
): Promise<Proposed> {
  let step = 0;
  app.ai.script(
    [
      ...delegations.map(({ domain }, index) =>
        delegate(domain, 'Prepare what the user asked for', `d${index + 1}`),
      ),
      reply('I prepared it; please confirm.'),
    ],
    delegations.flatMap(({ calls }) => [
      ...calls.map((call) => callStep(`p${(step += 1)}`, call)),
      reply('Prepared'),
    ]),
  );
  const res = await chat(
    app.ctx,
    actor,
    chatBody({
      message: options.message ?? 'Please do it',
      context: options.context ?? NO_CONTEXT,
      sessionId: options.sessionId ?? null,
    }),
  );
  if (res.status !== 200) throw new Error(`chat answered ${res.status}: ${res.raw}`);
  const blocks = res.frames
    .filter((frame): frame is Extract<Frame, { type: 'block' }> => frame.type === 'block')
    .map((frame) => frame.block as unknown as Record<string, unknown>);
  const confirmBlocks = blocks.filter((block) => block.kind === 'confirm');
  const session = res.frames[0] as { sessionId: string; assistantMessageId: string };
  return {
    res,
    sessionId: session.sessionId,
    assistantMessageId: session.assistantMessageId,
    actionIds: confirmBlocks.map((block) => block.actionId as string),
    confirmBlocks,
    planBlocks: blocks.filter((block) => block.kind === 'plan'),
    toolFrames: res.frames.filter((frame) => frame.type === 'tool') as unknown as Array<
      Record<string, unknown>
    >,
  };
}

export const confirmPath = (id: string) => `/api/v1/ai/actions/${id}/confirm`;
export const cancelPath = (id: string) => `/api/v1/ai/actions/${id}/cancel`;

export function confirm(ctx: TestApp, actor: Pick<Actor, 'token'>, id: string, body = {}): Test {
  return as(ctx, actor).post(confirmPath(id)).send(body);
}

export async function grantEdit(
  ctx: TestApp,
  admin: Pick<Actor, 'token'>,
  member: Pick<Actor, 'userId'>,
  folderId: string,
): Promise<string> {
  const res = await as(ctx, admin)
    .put('/api/v1/access/grants')
    .send({ userId: member.userId, targetType: 'folder', targetId: folderId, level: 'edit' });
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`grant answered ${res.status}: ${JSON.stringify(res.body)}`);
  }
  return res.body.id as string;
}

export function withoutRequestId(body: Record<string, unknown>): Record<string, unknown> {
  const { requestId: _requestId, ...rest } = body;
  return rest;
}
