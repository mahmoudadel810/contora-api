import request, { type Agent, type Test } from 'supertest';
import { AuthService } from '../../src/auth/auth.service.js';
import type { TestApp } from './test-app.js';

let counter = 0;

export const DEFAULT_PASSWORD = 'Passw0rd!long';

export interface Actor {
  userId: string;
  tenantId: string;
  email: string;
  password: string;
  displayName: string;
  role: 'admin' | 'member';
  token: string;
  agent: Agent;
}

export interface Authed {
  get: (url: string) => Test;
  post: (url: string) => Test;
  patch: (url: string) => Test;
  put: (url: string) => Test;
  delete: (url: string) => Test;
}

export function uniqueEmail(prefix = 'user'): string {
  counter += 1;
  return `${prefix}${counter}-${Date.now()}@example.test`;
}

export function agentFor(ctx: TestApp): Agent {
  return request.agent(ctx.app.getHttpServer());
}

export async function signUp(
  ctx: TestApp,
  overrides: Partial<{
    email: string;
    password: string;
    displayName: string;
    tenantName: string;
  }> = {},
): Promise<Actor> {
  const body = {
    tenantName: overrides.tenantName ?? `Tenant ${counter + 1}`,
    email: overrides.email ?? uniqueEmail(),
    password: overrides.password ?? DEFAULT_PASSWORD,
    displayName: overrides.displayName ?? 'Test Admin',
  };
  const agent = agentFor(ctx);
  const res = await agent.post('/api/v1/auth/sign-up').send(body).expect(201);
  return {
    userId: res.body.user.id,
    tenantId: res.body.tenant.id,
    email: body.email,
    password: body.password,
    displayName: body.displayName,
    role: 'admin',
    token: res.body.accessToken,
    agent,
  };
}

export async function signIn(ctx: TestApp, email: string, password: string): Promise<Actor> {
  const agent = agentFor(ctx);
  const res = await agent.post('/api/v1/auth/sign-in').send({ email, password }).expect(200);
  return {
    userId: res.body.user.id,
    tenantId: res.body.tenant.id,
    email,
    password,
    displayName: res.body.user.displayName,
    role: res.body.user.role,
    token: res.body.accessToken,
    agent,
  };
}

export function as(ctx: TestApp, actor: Pick<Actor, 'token'>): Authed {
  const server = ctx.app.getHttpServer();
  const withToken = (test: Test) => test.set('Authorization', `Bearer ${actor.token}`);
  return {
    get: (url) => withToken(request(server).get(url)),
    post: (url) => withToken(request(server).post(url)),
    patch: (url) => withToken(request(server).patch(url)),
    put: (url) => withToken(request(server).put(url)),
    delete: (url) => withToken(request(server).delete(url)),
  };
}

export async function addMember(
  ctx: TestApp,
  admin: Pick<Actor, 'tenantId'>,
  role: 'admin' | 'member' = 'member',
): Promise<Actor> {
  const email = uniqueEmail(role);
  await ctx.app.get(AuthService).createMember(admin.tenantId, {
    email,
    password: DEFAULT_PASSWORD,
    displayName: `Test ${role}`,
    role,
  });
  return signIn(ctx, email, DEFAULT_PASSWORD);
}

export function withSession(actor: Pick<Actor, 'token' | 'agent'>): Authed {
  const withToken = (test: Test) => test.set('Authorization', `Bearer ${actor.token}`);
  return {
    get: (url) => withToken(actor.agent.get(url)),
    post: (url) => withToken(actor.agent.post(url)),
    patch: (url) => withToken(actor.agent.patch(url)),
    put: (url) => withToken(actor.agent.put(url)),
    delete: (url) => withToken(actor.agent.delete(url)),
  };
}
