import { compare } from 'bcryptjs';
import { RefreshTokensRepository } from '../src/auth/refresh-tokens.repository.js';
import { addMember, agentFor, as, signUp, type Actor } from './helpers/actors.js';
import { createTestApp, type TestApp } from './helpers/test-app.js';

vi.mock('bcryptjs', { spy: true });

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('sign-in racing a password change or suspension (e2e)', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await ctx.stop();
  });

  async function signInAround(user: Actor, during: () => Promise<unknown>) {
    const entered = deferred();
    const gate = deferred();
    const actual = await vi.importActual<typeof import('bcryptjs')>('bcryptjs');
    vi.mocked(compare).mockImplementationOnce(async (password: string, hash: string) => {
      const result = await actual.compare(password, hash);
      entered.resolve();
      await gate.promise;
      return result;
    });
    const agent = agentFor(ctx);
    const pending = agent
      .post('/api/v1/auth/sign-in')
      .send({ email: user.email, password: user.password })
      .then((res) => res);
    await entered.promise;
    await during();
    gate.resolve();
    const res = await pending;
    return { res, agent };
  }

  it('refuses a sign-in whose password check used the password changed meanwhile', async () => {
    const user = await signUp(ctx);
    let changed = { accessToken: '' };
    const { res, agent } = await signInAround(user, async () => {
      changed = (
        await as(ctx, user)
          .post('/api/v1/auth/change-password')
          .send({ currentPassword: user.password, newPassword: 'Changed!Passw0rd' })
          .expect(200)
      ).body;
    });
    expect(res.status).toBe(401);
    await agent.post('/api/v1/auth/refresh').expect(401);
    const sessions = await as(ctx, { token: changed.accessToken })
      .get('/api/v1/auth/sessions')
      .expect(200);
    expect(sessions.body.items).toHaveLength(1);
  });

  it('refuses a sign-in of a member suspended meanwhile', async () => {
    const admin = await signUp(ctx);
    const member = await addMember(ctx, admin);
    const { res, agent } = await signInAround(member, () =>
      as(ctx, admin).post(`/api/v1/members/${member.userId}/suspend`).expect(200),
    );
    expect(res.status).toBe(401);
    await agent.post('/api/v1/auth/refresh').expect(401);
    const listed = await as(ctx, admin).get(`/api/v1/members/${member.userId}/sessions`);
    expect(listed.body.items).toEqual([]);
  });

  it('ends a sign-in that lands between the sessions revoke and the new password', async () => {
    const user = await signUp(ctx);
    const sessions = ctx.app.get(RefreshTokensRepository, { strict: false });
    const revokeAll = sessions.revokeAllForUser.bind(sessions);
    let raced: { status: number; token?: string; cookie?: string } = { status: 0 };
    const agent = agentFor(ctx);
    const spy = vi.spyOn(sessions, 'revokeAllForUser').mockImplementationOnce(async (...args) => {
      const revoked = await revokeAll(...args);
      const res = await agent
        .post('/api/v1/auth/sign-in')
        .send({ email: user.email, password: user.password });
      raced = { status: res.status, token: res.body.accessToken as string | undefined };
      return revoked;
    });
    try {
      await as(ctx, user)
        .post('/api/v1/auth/change-password')
        .send({ currentPassword: user.password, newPassword: 'Changed!Passw0rd' })
        .expect(200);
    } finally {
      spy.mockRestore();
    }
    expect(raced.status).toBe(200);
    await as(ctx, { token: raced.token as string })
      .get('/api/v1/auth/me')
      .expect(401);
    await agent.post('/api/v1/auth/refresh').expect(401);
  });
});
