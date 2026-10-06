import { rename } from 'node:fs/promises';
import { Logger } from '@nestjs/common';
import { AuditService } from '../src/audit/audit.service.js';
import { currentRequestId } from '../src/common/request-context.js';
import { APP_CONFIG, type AppConfig } from '../src/config/env.js';
import { HealthController } from '../src/health/health.controller.js';
import { NotificationsService } from '../src/notifications/notifications.service.js';
import { as, signUp, type Actor } from './helpers/actors.js';
import { createTestApp, type TestApp } from './helpers/test-app.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('observability (e2e)', () => {
  let ctx: TestApp;
  let admin: Actor;

  beforeAll(async () => {
    ctx = await createTestApp();
    admin = await signUp(ctx, { tenantName: 'Observed Co' });
  });

  afterAll(async () => {
    await ctx.stop();
  });

  describe('request ids', () => {
    it('creates an id when the client sends none', async () => {
      const a = await ctx.http().get('/api/v1/health').expect(200);
      const b = await ctx.http().get('/api/v1/health').expect(200);
      expect(a.headers['x-request-id']).toMatch(UUID);
      expect(b.headers['x-request-id']).toMatch(UUID);
      expect(a.headers['x-request-id']).not.toBe(b.headers['x-request-id']);
    });

    it('keeps a valid incoming id', async () => {
      for (const id of ['abc', 'trace_01-XYZ', 'x'.repeat(64)]) {
        const res = await ctx.http().get('/api/v1/health').set('X-Request-Id', id).expect(200);
        expect(res.headers['x-request-id']).toBe(id);
      }
    });

    it('replaces an invalid incoming id with a new one', async () => {
      for (const id of ['x'.repeat(65), 'has space', 'a.b', 'semi;colon', '<script>']) {
        const res = await ctx.http().get('/api/v1/health').set('X-Request-Id', id).expect(200);
        expect(res.headers['x-request-id'], id).toMatch(UUID);
      }
    });

    it('puts the id into error bodies, for unknown routes, auth and validation failures', async () => {
      const notFound = await ctx.http().get('/api/v1/nope').set('X-Request-Id', 'req-404');
      expect(notFound.status).toBe(404);
      expect(notFound.headers['x-request-id']).toBe('req-404');
      expect(notFound.body).toEqual({
        statusCode: 404,
        code: 'NOT_FOUND',
        message: 'Cannot GET /api/v1/nope',
        requestId: 'req-404',
      });

      const unauthenticated = await ctx.http().get('/api/v1/records').expect(401);
      expect(unauthenticated.body.requestId).toMatch(UUID);
      expect(unauthenticated.body.requestId).toBe(unauthenticated.headers['x-request-id']);

      const invalid = await ctx
        .http()
        .post('/api/v1/auth/sign-in')
        .set('X-Request-Id', 'req-400')
        .send({ email: 'not-an-email' })
        .expect(400);
      expect(invalid.body).toMatchObject({ code: 'VALIDATION_FAILED', requestId: 'req-400' });

      const malformed = await ctx
        .http()
        .post('/api/v1/auth/sign-in')
        .set('Content-Type', 'application/json')
        .set('X-Request-Id', 'req-json')
        .send('{"email":')
        .expect(400);
      expect(malformed.body).toMatchObject({ code: 'BAD_REQUEST', requestId: 'req-json' });
    });

    it('makes the id available to code running inside the request, after body parsing', async () => {
      const audit = ctx.app.get(AuditService);
      const seen: Array<string | undefined> = [];
      const record = audit.record.bind(audit);
      const spy = vi.spyOn(audit, 'record').mockImplementation(async (tenantId, input) => {
        seen.push(currentRequestId());
        return record(tenantId, input);
      });
      try {
        await ctx
          .http()
          .post('/api/v1/auth/sign-up')
          .set('X-Request-Id', 'req-als')
          .send({
            tenantName: 'Context Co',
            email: `als-${Date.now()}@example.test`,
            password: 'Passw0rd!long',
            displayName: 'Ctx',
          })
          .expect(201);
      } finally {
        spy.mockRestore();
      }
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every((id) => id === 'req-als')).toBe(true);
    });

    it('answers unexpected errors with a generic 500 carrying the id, and logs who and where only', async () => {
      const notifications = ctx.app.get(NotificationsService);
      const listSpy = vi
        .spyOn(notifications, 'list')
        .mockRejectedValueOnce(new Error('internal detail'));
      const logSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      try {
        const res = await as(ctx, admin)
          .get('/api/v1/notifications?unread=true')
          .set('X-Request-Id', 'req-500')
          .expect(500);
        expect(res.body).toEqual({
          statusCode: 500,
          code: 'INTERNAL_ERROR',
          message: 'Unexpected server error',
          requestId: 'req-500',
        });
        expect(logSpy).toHaveBeenCalledOnce();
        const [fields, stack] = logSpy.mock.calls[0];
        expect(fields).toEqual({
          message: 'Unexpected server error',
          method: 'GET',
          route: '/api/v1/notifications',
          status: 500,
          tenantId: admin.tenantId,
          userId: admin.userId,
          requestId: 'req-500',
        });
        expect(String(stack)).toContain('internal detail');
        expect(JSON.stringify(fields)).not.toContain(admin.token);
      } finally {
        listSpy.mockRestore();
        logSpy.mockRestore();
      }
    });

    it('lets the web app read the id across origins', async () => {
      const config = ctx.app.get<AppConfig>(APP_CONFIG);
      const res = await ctx.http().get('/api/v1/health').set('Origin', config.FRONTEND_URL);
      expect(res.headers['access-control-expose-headers']).toContain('X-Request-Id');
    });
  });

  describe('readiness', () => {
    it('keeps /health as liveness', async () => {
      const res = await ctx.http().get('/api/v1/health').expect(200);
      expect(res.body.status).toBe('ok');
    });

    it('is ready when Mongo answers and storage is writable, without signing in', async () => {
      const res = await ctx.http().get('/api/v1/health/ready').expect(200);
      expect(res.body).toEqual({ status: 'ok', mongo: 'ok', storage: 'ok' });
    });

    it('answers 503 naming Mongo when the ping fails', async () => {
      const health = ctx.app.get(HealthController);
      const spy = vi.spyOn(health, 'pingMongo').mockRejectedValueOnce(new Error('down'));
      try {
        const res = await ctx.http().get('/api/v1/health/ready').expect(503);
        expect(res.body).toEqual({ status: 'error', mongo: 'error', storage: 'ok' });
      } finally {
        spy.mockRestore();
      }
    });

    it('answers 503 naming storage when the storage directory is gone', async () => {
      const dir = ctx.app.get<AppConfig>(APP_CONFIG).STORAGE_DIR;
      await rename(dir, `${dir}-moved`);
      try {
        const res = await ctx.http().get('/api/v1/health/ready').expect(503);
        expect(res.body).toEqual({ status: 'error', mongo: 'ok', storage: 'error' });
      } finally {
        await rename(`${dir}-moved`, dir);
      }
      await ctx.http().get('/api/v1/health/ready').expect(200);
    });
  });
});
