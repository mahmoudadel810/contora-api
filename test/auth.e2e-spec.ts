import { JwtService } from '@nestjs/jwt';
import { getModelToken } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import { AuditEntry } from '../src/audit/audit-entry.schema.js';
import { RefreshToken } from '../src/auth/refresh-token.schema.js';
import { agentFor, as, signIn, signUp, uniqueEmail } from './helpers/actors.js';
import { createTestApp, type TestApp } from './helpers/test-app.js';

function refreshCookieOf(res: { headers: Record<string, unknown> }): string {
  const cookies = res.headers['set-cookie'] as string[] | undefined;
  const cookie = cookies?.find((c) => c.startsWith('mecm_refresh='));
  if (!cookie) throw new Error('no refresh cookie');
  return cookie;
}

describe('auth (e2e)', () => {
  let ctx: TestApp;
  let audit: Model<AuditEntry>;
  let refreshTokens: Model<RefreshToken>;

  beforeAll(async () => {
    ctx = await createTestApp();
    audit = ctx.app.get(getModelToken(AuditEntry.name));
    refreshTokens = ctx.app.get(getModelToken(RefreshToken.name));
  });

  afterAll(async () => {
    await ctx.stop();
  });

  describe('sign-up', () => {
    it('creates a tenant with the user as its admin and sets an httpOnly refresh cookie', async () => {
      const email = uniqueEmail('Mixed');
      const res = await ctx
        .http()
        .post('/api/v1/auth/sign-up')
        .send({
          tenantName: 'Acme Corp',
          displayName: 'Ada',
          email: `  ${email.toUpperCase()} `,
          password: 'Passw0rd!long',
        })
        .expect(201);
      expect(res.body.user).toMatchObject({
        email: email.toLowerCase(),
        displayName: 'Ada',
        role: 'admin',
        status: 'active',
      });
      expect(res.body.user).not.toHaveProperty('passwordHash');
      expect(res.body.tenant).toMatchObject({
        name: 'Acme Corp',
        slug: 'acme-corp',
      });
      expect(res.body.expiresIn).toBe(3600);
      const cookie = refreshCookieOf(res);
      expect(cookie).toMatch(/HttpOnly/i);
      expect(cookie).toMatch(/Path=\/api\/v1\/auth/);
      expect(cookie).toMatch(/SameSite=Lax/i);
      expect(
        await audit.countDocuments({
          action: 'SIGN_UP',
          'actor.email': email.toLowerCase(),
        }),
      ).toBe(1);
    });

    it('gives each sign-up its own tenant with a unique slug', async () => {
      const a = await signUp(ctx, { tenantName: 'Same Name' });
      const b = await signUp(ctx, { tenantName: 'Same Name' });
      expect(a.tenantId).not.toBe(b.tenantId);
      const me = await as(ctx, b).get('/api/v1/auth/me').expect(200);
      expect(me.body.tenant.slug).toBe('same-name-2');
    });

    it('rejects a duplicate email with 409 EMAIL_TAKEN', async () => {
      const first = await signUp(ctx);
      const res = await ctx
        .http()
        .post('/api/v1/auth/sign-up')
        .send({
          tenantName: 'Other',
          displayName: 'Dup',
          email: first.email,
          password: 'Passw0rd!long',
        })
        .expect(409);
      expect(res.body).toEqual({
        statusCode: 409,
        code: 'EMAIL_TAKEN',
        message: 'An account with this email already exists',
        requestId: res.headers['x-request-id'],
      });
    });

    it('rejects invalid bodies with field details', async () => {
      const res = await ctx
        .http()
        .post('/api/v1/auth/sign-up')
        .send({
          tenantName: '',
          email: 'not-an-email',
          password: 'short',
          displayName: '',
          extra: 1,
        })
        .expect(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
      const paths = (res.body.details as Array<{ path: string }>).map((d) => d.path);
      expect(paths).toEqual(
        expect.arrayContaining(['tenantName', 'email', 'password', 'displayName', 'extra']),
      );
    });

    it('answers malformed JSON with 400, not 500', async () => {
      const res = await ctx
        .http()
        .post('/api/v1/auth/sign-in')
        .set('Content-Type', 'application/json')
        .send('{"email":')
        .expect(400);
      expect(res.body.code).toBe('BAD_REQUEST');
    });
  });

  describe('sign-in', () => {
    it('returns a session for valid credentials', async () => {
      const user = await signUp(ctx);
      const session = await signIn(ctx, user.email, user.password);
      expect(session.userId).toBe(user.userId);
      expect(session.tenantId).toBe(user.tenantId);
      await as(ctx, session).get('/api/v1/auth/me').expect(200);
    });

    it('rejects a wrong password and an unknown email with the same 401 and audits the failure without the password', async () => {
      const user = await signUp(ctx);
      const wrong = await ctx
        .http()
        .post('/api/v1/auth/sign-in')
        .set('X-Request-Id', 'enumeration-check')
        .send({ email: user.email, password: 'definitely-wrong' })
        .expect(401);
      const unknown = await ctx
        .http()
        .post('/api/v1/auth/sign-in')
        .set('X-Request-Id', 'enumeration-check')
        .send({ email: uniqueEmail('ghost'), password: 'whatever1' })
        .expect(401);
      expect(wrong.body).toEqual(unknown.body);
      const failed = await audit
        .findOne({ action: 'SIGN_IN_FAILED', 'actor.email': user.email })
        .lean();
      expect(failed).not.toBeNull();
      expect(failed?.context).toEqual({ email: user.email, reason: 'credentials' });
      expect(JSON.stringify(failed)).not.toContain('definitely-wrong');
    });
  });

  describe('refresh rotation', () => {
    it('rotates the refresh cookie and issues a new access token', async () => {
      const user = await signUp(ctx);
      const res = await user.agent.post('/api/v1/auth/refresh').expect(200);
      expect(typeof res.body.accessToken).toBe('string');
      expect(res.body.user.id).toBe(user.userId);
      await as(ctx, { token: res.body.accessToken }).get('/api/v1/auth/me').expect(200);
      await user.agent.post('/api/v1/auth/refresh').expect(200);
    });

    it('revokes the whole family when a rotated token is replayed after the grace window', async () => {
      const user = await signUp(ctx);
      const first = await user.agent.post('/api/v1/auth/refresh').expect(200);
      const stale = refreshCookieOf(first).split(';')[0];
      await user.agent.post('/api/v1/auth/refresh').expect(200);
      await refreshTokens
        .updateMany(
          { userId: new Types.ObjectId(user.userId), rotatedAt: { $ne: null } },
          { rotatedAt: new Date(Date.now() - 60_000) },
        )
        .exec();
      const attacker = await ctx
        .http()
        .post('/api/v1/auth/refresh')
        .set('Cookie', stale)
        .expect(401);
      expect(attacker.body.code).toBe('UNAUTHENTICATED');
      await user.agent.post('/api/v1/auth/refresh').expect(401);
      expect(
        await audit.countDocuments({ action: 'TOKEN_REUSE_DETECTED', 'actor.email': user.email }),
      ).toBeGreaterThanOrEqual(1);
    });

    it('tolerates a just-rotated token presented again within the grace window (lost response)', async () => {
      const user = await signUp(ctx);
      const original = (
        await ctx
          .http()
          .post('/api/v1/auth/sign-in')
          .send({ email: user.email, password: user.password })
          .expect(200)
      ).headers['set-cookie'] as unknown as string[];
      const cookie = original.find((c) => c.startsWith('mecm_refresh='))?.split(';')[0] as string;
      await ctx.http().post('/api/v1/auth/refresh').set('Cookie', cookie).expect(200);
      const retried = await ctx
        .http()
        .post('/api/v1/auth/refresh')
        .set('Cookie', cookie)
        .expect(200);
      expect(retried.body.user.id).toBe(user.userId);
      await ctx
        .http()
        .post('/api/v1/auth/sign-out')
        .set('Cookie', refreshCookieOf(retried).split(';')[0])
        .expect(204);
      await ctx.http().post('/api/v1/auth/refresh').set('Cookie', cookie).expect(401);
    });

    it('answers a revoked, never-rotated token with 401 and raises no reuse alarm', async () => {
      const user = await signUp(ctx);
      const signedIn = await ctx
        .http()
        .post('/api/v1/auth/sign-in')
        .send({ email: user.email, password: user.password })
        .expect(200);
      const cookie = refreshCookieOf(signedIn).split(';')[0];
      await ctx.http().post('/api/v1/auth/sign-out').set('Cookie', cookie).expect(204);
      const res = await ctx.http().post('/api/v1/auth/refresh').set('Cookie', cookie).expect(401);
      expect(res.body.code).toBe('UNAUTHENTICATED');

      const other = await signIn(ctx, user.email, user.password);
      await as(ctx, user)
        .post('/api/v1/auth/change-password')
        .send({ currentPassword: user.password, newPassword: 'NewPassw0rd!' })
        .expect(200);
      await other.agent.post('/api/v1/auth/refresh').expect(401);

      expect(
        await audit.countDocuments({
          action: 'TOKEN_REUSE_DETECTED',
          'actor.id': new Types.ObjectId(user.userId),
        }),
      ).toBe(0);
    });

    it('still detects reuse of a rotated token after its family was revoked', async () => {
      const user = await signUp(ctx);
      const first = await user.agent.post('/api/v1/auth/refresh').expect(200);
      const stale = refreshCookieOf(first).split(';')[0];
      await user.agent.post('/api/v1/auth/refresh').expect(200);
      await user.agent.post('/api/v1/auth/sign-out').expect(204);
      await ctx.http().post('/api/v1/auth/refresh').set('Cookie', stale).expect(401);
      expect(
        await audit.countDocuments({
          action: 'TOKEN_REUSE_DETECTED',
          'actor.id': new Types.ObjectId(user.userId),
        }),
      ).toBe(1);
    });

    it('lets two parallel refreshes of one token both succeed without a reuse alarm', async () => {
      const user = await signUp(ctx);
      const signedIn = await ctx
        .http()
        .post('/api/v1/auth/sign-in')
        .send({ email: user.email, password: user.password })
        .expect(200);
      const cookie = refreshCookieOf(signedIn).split(';')[0];
      const results = await Promise.all(
        [1, 2].map(() => ctx.http().post('/api/v1/auth/refresh').set('Cookie', cookie)),
      );
      expect(results.map((r) => r.status)).toEqual([200, 200]);
      expect(
        await audit.countDocuments({
          action: 'TOKEN_REUSE_DETECTED',
          'actor.id': new Types.ObjectId(user.userId),
        }),
      ).toBe(0);
    });

    it('rejects refresh without a cookie', async () => {
      await agentFor(ctx).post('/api/v1/auth/refresh').expect(401);
    });
  });

  describe('sign-out', () => {
    it('revokes the refresh token, clears the cookie and records it', async () => {
      const user = await signUp(ctx);
      const res = await user.agent.post('/api/v1/auth/sign-out').expect(204);
      expect(refreshCookieOf(res)).toMatch(/mecm_refresh=;/);
      await user.agent.post('/api/v1/auth/refresh').expect(401);
      expect(
        await audit.countDocuments({
          action: 'SIGN_OUT',
          'actor.id': new Types.ObjectId(user.userId),
        }),
      ).toBe(1);
    });
  });

  describe('protected routes', () => {
    it('rejects missing, garbage and expired tokens', async () => {
      await ctx.http().get('/api/v1/auth/me').expect(401);
      await ctx.http().get('/api/v1/auth/me').set('Authorization', 'Bearer garbage').expect(401);
      const user = await signUp(ctx);
      const expired = ctx.app.get(JwtService).sign({
        sub: user.userId,
        tid: user.tenantId,
        exp: Math.floor(Date.now() / 1000) - 10,
      });
      const res = await ctx
        .http()
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${expired}`)
        .expect(401);
      expect(res.body.code).toBe('UNAUTHENTICATED');
    });

    it('rejects a token whose tenant claim does not match the user', async () => {
      const a = await signUp(ctx);
      const b = await signUp(ctx);
      const forged = ctx.app.get(JwtService).sign({ sub: a.userId, tid: b.tenantId });
      await ctx.http().get('/api/v1/auth/me').set('Authorization', `Bearer ${forged}`).expect(401);
    });
  });

  describe('account', () => {
    it('updates the display name', async () => {
      const user = await signUp(ctx);
      const res = await as(ctx, user)
        .patch('/api/v1/auth/me')
        .send({ displayName: 'Renamed' })
        .expect(200);
      expect(res.body.displayName).toBe('Renamed');
    });

    it('changes the password only with the current one and revokes other sessions', async () => {
      const user = await signUp(ctx);
      const other = await signIn(ctx, user.email, user.password);
      const bad = await as(ctx, user)
        .post('/api/v1/auth/change-password')
        .send({ currentPassword: 'nope-nope', newPassword: 'NewPassw0rd!' })
        .expect(400);
      expect(bad.body.code).toBe('WRONG_PASSWORD');
      await as(ctx, user)
        .post('/api/v1/auth/change-password')
        .send({ currentPassword: user.password, newPassword: 'NewPassw0rd!' })
        .expect(200);
      await other.agent.post('/api/v1/auth/refresh').expect(401);
      await ctx
        .http()
        .post('/api/v1/auth/sign-in')
        .send({ email: user.email, password: user.password })
        .expect(401);
      await ctx
        .http()
        .post('/api/v1/auth/sign-in')
        .send({ email: user.email, password: 'NewPassw0rd!' })
        .expect(200);
    });
  });
});
