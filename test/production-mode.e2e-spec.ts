import { ConsoleLogger } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import type { MockInstance } from 'vitest';
import type { AccessLogEntry } from '../src/common/access-log.js';
import { as, signUp, type Actor } from './helpers/actors.js';
import { createTestApp, type TestApp } from './helpers/test-app.js';

interface Logged {
  message: unknown;
  context?: string;
  json?: boolean;
}

describe('production mode (e2e)', () => {
  let ctx: TestApp;
  let admin: Actor;
  let logSpy: MockInstance;
  const logged: Logged[] = [];

  const accessLines = (): AccessLogEntry[] =>
    logged
      .filter((line) => line.context === 'Access')
      .map((line) => line.message as AccessLogEntry);

  const lineFor = async (requestId: string): Promise<AccessLogEntry> => {
    await vi.waitFor(() => expect(accessLines().some((l) => l.requestId === requestId)).toBe(true));
    const line = accessLines().find((l) => l.requestId === requestId);
    if (!line) throw new Error(`no access log line for ${requestId}`);
    return line;
  };

  beforeAll(async () => {
    logSpy = vi.spyOn(ConsoleLogger.prototype, 'log').mockImplementation(function capture(
      this: ConsoleLogger,
      message: unknown,
    ) {
      const self = this as unknown as { context?: string; options?: { json?: boolean } };
      logged.push({ message, context: self.context, json: self.options?.json });
    });
    ctx = await createTestApp([], { NODE_ENV: 'production', COOKIE_SECURE: 'true' });
    admin = await signUp(ctx, { tenantName: 'Prod Co' });
  });

  afterAll(async () => {
    await ctx.stop();
    logSpy.mockRestore();
  });

  it('turns autoIndex off and still builds every declared index before start-up completes', async () => {
    const connection = ctx.app.get<Connection>(getConnectionToken());
    expect(connection.get('autoIndex')).toBe(false);
    const models = Object.values(connection.models);
    expect(models.length).toBeGreaterThan(10);
    const existing = await Promise.all(
      models.map((model) => model.collection.indexes().catch(() => [])),
    );
    models.forEach((model, i) => {
      const keys = existing[i].map((index) => JSON.stringify(index.key));
      for (const [fields] of model.schema.indexes()) {
        expect(keys, `${model.modelName} index ${JSON.stringify(fields)}`).toContain(
          JSON.stringify(fields),
        );
      }
    });
  });

  it('writes one structured JSON access log line per request, with the route pattern', async () => {
    const res = await as(ctx, admin)
      .get('/api/v1/records?q=do-not-log-me&pageSize=5')
      .set('X-Request-Id', 'prod-list')
      .expect(200);
    const line = await lineFor('prod-list');
    expect(line).toEqual({
      method: 'GET',
      route: '/api/v1/records',
      status: 200,
      durationMs: expect.any(Number),
      tenantId: admin.tenantId,
      userId: admin.userId,
      requestId: res.headers['x-request-id'],
    });
    expect(JSON.stringify(line)).not.toContain('do-not-log-me');
    expect(JSON.stringify(line)).not.toContain(admin.token);
    expect(logged.find((l) => l.message === line)?.json).toBe(true);
    expect(accessLines().filter((l) => l.requestId === 'prod-list')).toHaveLength(1);
  });

  it('logs the pattern rather than the id for parameterised routes, and failures too', async () => {
    await as(ctx, admin)
      .get('/api/v1/records/0123456789abcdef01234567')
      .set('X-Request-Id', 'prod-404')
      .expect(404);
    expect(await lineFor('prod-404')).toMatchObject({
      route: '/api/v1/records/:id',
      status: 404,
      tenantId: admin.tenantId,
    });

    await ctx
      .http()
      .get('/api/v1/nowhere?token=secret')
      .set('X-Request-Id', 'prod-none')
      .expect(404);
    const unmatched = await lineFor('prod-none');
    expect(unmatched).toMatchObject({ route: '/api/v1/nowhere', status: 404 });
    expect(unmatched.tenantId).toBeUndefined();
    expect(JSON.stringify(unmatched)).not.toContain('secret');
  });

  it('does not log the health probes', async () => {
    await ctx.http().get('/api/v1/health').set('X-Request-Id', 'probe-live').expect(200);
    await ctx.http().get('/api/v1/health/ready').set('X-Request-Id', 'probe-ready').expect(200);
    await ctx.http().get('/api/v1/nope').set('X-Request-Id', 'probe-after').expect(404);
    await lineFor('probe-after');
    const ids = accessLines().map((l) => l.requestId);
    expect(ids).not.toContain('probe-live');
    expect(ids).not.toContain('probe-ready');
  });
});
