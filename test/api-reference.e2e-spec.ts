import type { Express } from 'express';
import { ApiReferenceService } from '../src/api-reference/api-reference.service.js';
import type { OpenApiDocument } from '../src/api-reference/openapi.js';
import { as, signUp } from './helpers/actors.js';
import { createTestApp, type TestApp } from './helpers/test-app.js';

interface RouterLayer {
  route?: { path: string | string[]; methods: Record<string, boolean> };
}

function expressRoutes(ctx: TestApp): string[] {
  const express = ctx.app.getHttpAdapter().getInstance() as Express & {
    router: { stack: RouterLayer[] };
  };
  const routes: string[] = [];
  for (const layer of express.router.stack) {
    if (!layer.route) continue;
    const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
    for (const path of paths) {
      for (const [method, on] of Object.entries(layer.route.methods)) {
        if (on) routes.push(`${method.toUpperCase()} ${path}`);
      }
    }
  }
  return routes;
}

function documentedRoutes(document: OpenApiDocument): string[] {
  return Object.entries(document.paths).flatMap(([path, operations]) =>
    Object.keys(operations).map(
      (method) => `${method.toUpperCase()} ${document.servers[0].url}${path}`,
    ),
  );
}

const toOpenApi = (route: string) => route.replace(/:([A-Za-z0-9_]+)/g, '{$1}');

describe('API reference (e2e)', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await ctx.stop();
  });

  it('serves an OpenAPI 3.1 document without sign-in', async () => {
    const res = await ctx.http().get('/api/v1/openapi.json').expect(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body).toMatchObject({
      openapi: '3.1.0',
      info: { title: 'Contora API' },
      servers: [{ url: '/api/v1' }],
    });
  });

  it('documents every route the server answers, and nothing else (drift check)', async () => {
    const served = expressRoutes(ctx).map(toOpenApi).sort();
    expect(served.length).toBeGreaterThan(90);
    const res = await ctx.http().get('/api/v1/openapi.json').expect(200);
    const documented = documentedRoutes(res.body as OpenApiDocument).sort();
    expect(served.filter((route) => !documented.includes(route))).toEqual([]);
    expect(documented.filter((route) => !served.includes(route))).toEqual([]);
    expect(ctx.app.get(ApiReferenceService).reference().problems).toEqual([]);
  });

  it('carries request schemas, access and error codes from the code', async () => {
    const { body } = await ctx.http().get('/api/v1/openapi.json').expect(200);
    const doc = body as OpenApiDocument;

    const create = doc.paths['/records']?.post;
    const form = create?.requestBody?.content['multipart/form-data']?.schema as {
      properties: Record<string, unknown>;
    };
    expect(Object.keys(form.properties)).toEqual(
      expect.arrayContaining(['name', 'contentTypeId', 'folderId', 'metadata', 'file']),
    );
    expect(create?.responses['201']).toBeDefined();
    expect(create?.responses['413']?.description).toContain('PAYLOAD_TOO_LARGE');

    const search = doc.paths['/records']?.get;
    expect(search?.parameters?.map((p) => p.name)).toEqual(
      expect.arrayContaining(['q', 'folderId', 'tag', 'page', 'pageSize']),
    );

    const move = doc.paths['/records/{id}/move']?.post;
    expect(move?.requestBody?.content['application/json']?.schema).toMatchObject({
      type: 'object',
      properties: { folderId: { type: 'string' } },
      required: ['folderId'],
      additionalProperties: false,
    });
    expect(move?.parameters).toEqual([
      { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
    ]);
    expect(move?.responses['200']).toBeDefined();
    expect(Object.keys(move?.responses ?? {})).toEqual(['200', '400', '401', '403', '404']);
    expect(move?.['x-scope']).toBe('record');
    const comment = doc.paths['/records/{id}/comments']?.post;
    expect(Object.keys(comment?.responses ?? {})).not.toContain('403');

    const changeRole = doc.paths['/members/{id}']?.patch;
    expect(changeRole?.['x-access']).toBe('members.manage');
    expect(changeRole?.description).toContain('Admins only');
    expect(changeRole?.responses['403']?.description).toContain('FORBIDDEN');
    expect(changeRole?.responses['409']?.description).toContain('LAST_ADMIN');

    const changePassword = doc.paths['/auth/change-password']?.post;
    expect(changePassword?.responses['429']?.description).toContain('RATE_LIMITED');
    expect(changePassword?.security).toBeUndefined();

    const signIn = doc.paths['/auth/sign-in']?.post;
    expect(signIn?.security).toEqual([]);
    expect(signIn?.responses['401']?.description).toContain('UNAUTHENTICATED');
    expect(doc.paths['/records/{id}']?.delete?.responses['204']).toEqual({
      description: 'No content',
    });
  });

  it('contains no tenant data', async () => {
    const admin = await signUp(ctx, { tenantName: 'Reference Secret Tenant' });
    const root = await as(ctx, admin).get('/api/v1/folders/root').expect(200);
    await as(ctx, admin)
      .post('/api/v1/folders')
      .send({ name: 'Reference secret folder', parentId: root.body.folder.id })
      .expect(201);
    const json = await ctx.http().get('/api/v1/openapi.json').expect(200);
    const page = await ctx.http().get('/api/v1/reference').expect(200);
    for (const text of [JSON.stringify(json.body), page.text]) {
      expect(text).not.toContain('Reference Secret Tenant');
      expect(text).not.toContain('Reference secret folder');
      expect(text).not.toContain(admin.email);
    }
  });

  it('serves a readable page without scripts, under the API’s CSP', async () => {
    const res = await ctx.http().get('/api/v1/reference').expect(200);
    expect(res.headers['content-type']).toMatch(/^text\/html/);
    expect(res.headers['content-security-policy']).toContain("script-src 'self'");
    expect(res.text).toMatch(/<style>/);
    expect(res.headers['content-security-policy']).toMatch(
      /(^|;)\s*style-src [^;]*'unsafe-inline'/,
    );
    expect(res.text).not.toMatch(/<script/i);
    expect(res.text).not.toMatch(/https?:\/\//);
    expect(res.text).toContain('<code>/records/{id}/versions</code>');
    expect(res.text).toContain('href="openapi.json"');
  });
});
