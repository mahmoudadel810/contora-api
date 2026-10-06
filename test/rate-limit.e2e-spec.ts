import { as, signUp, uniqueEmail, type Actor } from './helpers/actors.js';
import request from 'supertest';
import { createTestApp, type TestApp } from './helpers/test-app.js';

const attempt = (ctx: TestApp, forwardedFor?: string) => {
  const req = ctx.http().post('/api/v1/auth/sign-in');
  if (forwardedFor) req.set('X-Forwarded-For', forwardedFor);
  return req.send({ email: 'nobody@example.test', password: 'wrong-password' });
};

describe('rate limiting and security headers (e2e)', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await createTestApp([], { AUTH_RATE_LIMIT: '3' });
  });

  afterAll(async () => {
    await ctx.stop();
  });

  it('limits repeated sign-in attempts per client and ignores forged forwarding headers', async () => {
    for (let i = 0; i < 3; i += 1) await attempt(ctx).expect(401);
    const blocked = await attempt(ctx).expect(429);
    expect(blocked.body).toEqual({
      statusCode: 429,
      code: 'RATE_LIMITED',
      message: 'Too many attempts; please wait a minute and try again',
      requestId: blocked.headers['x-request-id'],
    });
    await attempt(ctx, '203.0.113.9').expect(429);
  });

  it('does not limit ordinary API routes', async () => {
    for (let i = 0; i < 6; i += 1) await ctx.http().get('/api/v1/health').expect(200);
  });

  it('sends security headers', async () => {
    const res = await ctx.http().get('/api/v1/health').expect(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

describe('rate limiting behind a trusted proxy (e2e)', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await createTestApp([], { AUTH_RATE_LIMIT: '2', TRUST_PROXY: '1' });
  });

  afterAll(async () => {
    await ctx.stop();
  });

  it('limits each forwarded client separately', async () => {
    for (let i = 0; i < 2; i += 1) await attempt(ctx, '198.51.100.1').expect(401);
    await attempt(ctx, '198.51.100.1').expect(429);
    await attempt(ctx, '198.51.100.2').expect(401);
  });
});

describe('session refresh is not rate limited (e2e)', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await createTestApp([], { AUTH_RATE_LIMIT: '2' });
  });

  afterAll(async () => {
    await ctx.stop();
  });

  it('keeps refreshing a valid session after the sign-in budget is used up', async () => {
    const agent = request.agent(ctx.app.getHttpServer());
    await agent
      .post('/api/v1/auth/sign-up')
      .send({
        tenantName: 'Busy Office',
        displayName: 'Busy',
        email: 'busy@example.test',
        password: 'Password123!',
      })
      .expect(201);
    for (let i = 0; i < 2; i += 1) await attempt(ctx).expect(401);
    await attempt(ctx).expect(429);
    for (let i = 0; i < 5; i += 1) await agent.post('/api/v1/auth/refresh').expect(200);
  });
});

describe('invitations and password changes are rate limited (e2e)', () => {
  let ctx: TestApp;
  let admin: Actor;

  beforeAll(async () => {
    ctx = await createTestApp([], { AUTH_RATE_LIMIT: '3' });
    admin = await signUp(ctx, { tenantName: 'Throttled Co' });
  });

  afterAll(async () => {
    await ctx.stop();
  });

  it('limits invitation creation, which reveals whether an email is registered', async () => {
    const invite = (email: string) =>
      as(ctx, admin).post('/api/v1/invitations').send({ email, role: 'member' });
    await invite(admin.email).expect(409);
    await invite(uniqueEmail('invitee')).expect(201);
    await invite(uniqueEmail('invitee')).expect(201);
    const blocked = await invite(uniqueEmail('invitee')).expect(429);
    expect(blocked.body.code).toBe('RATE_LIMITED');
    await as(ctx, admin).get('/api/v1/invitations').expect(200);
  });

  it('limits password change attempts', async () => {
    const change = () =>
      as(ctx, admin)
        .post('/api/v1/auth/change-password')
        .send({ currentPassword: 'not-the-password', newPassword: 'An0ther-long-password' });
    for (let i = 0; i < 3; i += 1) {
      const res = await change().expect(400);
      expect(res.body.code).toBe('WRONG_PASSWORD');
    }
    const blocked = await change().expect(429);
    expect(blocked.body.code).toBe('RATE_LIMITED');
  });
});

describe('password changes are rate limited per user, not only per client (e2e)', () => {
  let ctx: TestApp;
  let target: Actor;
  let bystander: Actor;

  beforeAll(async () => {
    ctx = await createTestApp([], { AUTH_RATE_LIMIT: '3', TRUST_PROXY: '1' });
    target = await signUp(ctx, { tenantName: 'Guessed Co' });
    bystander = await signUp(ctx, { tenantName: 'Bystander Co' });
  });

  afterAll(async () => {
    await ctx.stop();
  });

  const change = (actor: Actor, forwardedFor: string) =>
    as(ctx, actor)
      .post('/api/v1/auth/change-password')
      .set('X-Forwarded-For', forwardedFor)
      .send({ currentPassword: 'not-the-password', newPassword: 'An0ther-long-password' });

  it('limits one user guessing from many addresses, and leaves other users alone', async () => {
    for (let i = 1; i <= 3; i += 1) {
      const res = await change(target, `198.51.100.${i}`).expect(400);
      expect(res.body.code).toBe('WRONG_PASSWORD');
    }
    const blocked = await change(target, '198.51.100.99').expect(429);
    expect(blocked.body.code).toBe('RATE_LIMITED');
    const other = await change(bystander, '198.51.100.98').expect(400);
    expect(other.body.code).toBe('WRONG_PASSWORD');
  });
});
