import { z } from 'zod';
import { buildOpenApi, jsonSchemaOf } from './openapi.js';
import type { DiscoveredRoute } from './route-discovery.js';
import { openApiPath } from './route-discovery.js';
import type { RouteDoc } from './route-docs.js';

const route = (overrides: Partial<DiscoveredRoute> = {}): DiscoveredRoute => ({
  method: 'get',
  path: '/things/{id}',
  controller: 'ThingsController',
  handler: 'get',
  isPublic: false,
  throttled: false,
  status: 200,
  inputs: [],
  ...overrides,
});

const doc = (overrides: Partial<RouteDoc> = {}): RouteDoc => ({
  summary: 'A thing',
  access: 'records.read',
  scope: 'record',
  response: 'The thing',
  ...overrides,
});

describe('openApiPath', () => {
  it('joins controller and method paths in OpenAPI syntax', () => {
    expect(openApiPath('records/:id/comments', ':commentId')).toBe(
      '/records/{id}/comments/{commentId}',
    );
    expect(openApiPath('', 'trash')).toBe('/trash');
    expect(openApiPath('health', '')).toBe('/health');
    expect(openApiPath('/', '/')).toBe('/');
  });
});

describe('buildOpenApi', () => {
  it('reports routes without docs, docs without routes and public flags that disagree', () => {
    const { problems } = buildOpenApi(
      [route(), route({ path: '/open', handler: 'open', isPublic: true })],
      { 'GET /open': doc(), 'GET /gone': doc() },
    );
    expect(problems).toEqual([
      'GET /open: ROUTE_DOCS says records.read, but the route is @Public()',
      'No ROUTE_DOCS entry for GET /things/{id} (ThingsController.get)',
      'ROUTE_DOCS entry without a route: GET /gone',
    ]);
  });

  it('reports two handlers on one route', () => {
    const { problems } = buildOpenApi([route(), route({ handler: 'again' })], {
      'GET /things/{id}': doc(),
    });
    expect(problems).toEqual(['Two handlers for GET /things/{id} (ThingsController.again)']);
  });

  it('adds the generic errors of the route’s kind to the documented ones', () => {
    const { document, problems } = buildOpenApi(
      [
        route({
          method: 'post',
          status: 201,
          throttled: true,
          inputs: [{ in: 'body', schema: z.object({ name: z.string() }).strict() }],
        }),
      ],
      { 'POST /things/{id}': doc({ access: 'members.manage', errors: { 409: ['NAME_TAKEN'] } }) },
    );
    expect(problems).toEqual([]);
    const operation = document.paths['/things/{id}']?.post;
    expect(Object.keys(operation?.responses ?? {})).toEqual([
      '201',
      '400',
      '401',
      '403',
      '404',
      '409',
      '429',
    ]);
    expect(operation?.responses['409']?.description).toBe('Conflict. Codes: `NAME_TAKEN`');
    expect(operation?.responses['400']?.description).toContain('VALIDATION_FAILED');
    expect(operation?.['x-access']).toBe('members.manage');
  });

  it('expands a query object into parameters and marks public routes', () => {
    const { document } = buildOpenApi(
      [
        route({
          path: '/things',
          isPublic: true,
          inputs: [
            {
              in: 'query',
              schema: z.object({ q: z.string().optional(), page: z.coerce.number().default(1) }),
            },
          ],
        }),
      ],
      { 'GET /things': doc({ access: 'public' }) },
    );
    const operation = document.paths['/things']?.get;
    expect(operation?.security).toEqual([]);
    expect(operation?.parameters?.map((p) => [p.name, p.required])).toEqual([
      ['q', false],
      ['page', false],
    ]);
    expect(Object.keys(operation?.responses ?? {})).toEqual(['200', '400']);
  });
});

describe('buildOpenApi access grants', () => {
  it('documents the 403 of a View-only change and the scope, but not on reads', () => {
    const { document } = buildOpenApi(
      [
        route({ method: 'get', handler: 'get' }),
        route({ method: 'patch', handler: 'rename' }),
        route({ method: 'post', path: '/lists', handler: 'list', status: 201 }),
      ],
      {
        'GET /things/{id}': doc(),
        'PATCH /things/{id}': doc({ access: 'records.write' }),
        'POST /lists': doc({ access: 'records.read', scope: 'records' }),
      },
    );
    const get = document.paths['/things/{id}']?.get;
    const patch = document.paths['/things/{id}']?.patch;
    expect(Object.keys(get?.responses ?? {})).not.toContain('403');
    expect(patch?.responses['403']?.description).toContain('FORBIDDEN');
    expect(patch?.['x-scope']).toBe('record');
    expect(patch?.description).toContain('answers 404');
    expect(patch?.description).toContain('Edit to change it');
    expect(get?.description).not.toContain('Edit to change it');
    expect(Object.keys(document.paths['/lists']?.post?.responses ?? {})).not.toContain('403');
  });

  it('documents no 403 for a change that View allows (level view)', () => {
    const { document } = buildOpenApi(
      [route({ method: 'post', path: '/things/{id}/comments', handler: 'comment', status: 201 })],
      { 'POST /things/{id}/comments': doc({ level: 'view' }) },
    );
    const comment = document.paths['/things/{id}/comments']?.post;
    expect(Object.keys(comment?.responses ?? {})).not.toContain('403');
    expect(comment?.description).toContain('View is enough');
    expect(comment?.description).not.toContain('Edit to change it');
  });
});

describe('jsonSchemaOf', () => {
  it('describes the input side of transforms, defaults and preprocessing', () => {
    const schema = z
      .object({
        tags: z.preprocess((v) => v, z.array(z.string())).default([]),
        flag: z.enum(['true', 'false']).transform((v) => v === 'true'),
      })
      .strict();
    expect(jsonSchemaOf(schema)).toMatchObject({
      type: 'object',
      properties: { flag: { enum: ['true', 'false'] } },
      additionalProperties: false,
    });
    expect(jsonSchemaOf(schema)).not.toHaveProperty('$schema');
  });
});
