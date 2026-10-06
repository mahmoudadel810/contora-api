import { getConnectionToken } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import { createTestApp, type TestApp } from './helpers/test-app.js';

describe('health (e2e)', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await ctx.stop();
  });

  it('GET /api/v1/health returns ok', async () => {
    const res = await ctx.http().get('/api/v1/health').expect(200);
    expect(res.body.status).toBe('ok');
  });

  it('starts only once every model’s indexes exist, so unique-index races are real', async () => {
    const connection = ctx.app.get<Connection>(getConnectionToken());
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

  it('has the audit index behind the record activity feed', async () => {
    const connection = ctx.app.get<Connection>(getConnectionToken());
    const indexes = await connection.collection('audit_entries').indexes();
    expect(indexes.map((index) => JSON.stringify(index.key))).toContain(
      JSON.stringify({
        tenantId: 1,
        'resource.type': 1,
        'resource.id': 1,
        createdAt: -1,
        _id: -1,
      }),
    );
  });

  it('unknown routes return the uniform error shape', async () => {
    const res = await ctx.http().get('/api/v1/nope').expect(404);
    expect(res.body).toEqual({
      statusCode: 404,
      code: 'NOT_FOUND',
      message: 'Cannot GET /api/v1/nope',
      requestId: res.headers['x-request-id'],
    });
  });
});
