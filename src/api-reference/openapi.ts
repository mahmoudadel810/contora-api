import { z } from 'zod';
import { can } from '../authorization/policy.js';
import type { DiscoveredRoute, HttpMethod, RouteInput } from './route-discovery.js';
import type { DocumentedStatus, RouteDoc, RouteScope } from './route-docs.js';

type JsonSchema = Record<string, unknown>;

export interface OpenApiParameter {
  name: string;
  in: 'path' | 'query';
  required: boolean;
  schema: JsonSchema;
}

export interface OpenApiResponse {
  description: string;
  content?: Record<string, { schema?: JsonSchema }>;
}

export interface OpenApiOperation {
  operationId: string;
  summary: string;
  description?: string;
  tags: string[];
  security?: Array<Record<string, string[]>>;
  parameters?: OpenApiParameter[];
  requestBody?: { required: boolean; content: Record<string, { schema: JsonSchema }> };
  responses: Record<string, OpenApiResponse>;
  'x-access': string;
  'x-scope': string;
}

export interface OpenApiDocument {
  openapi: '3.1.0';
  info: { title: string; version: string; description: string };
  servers: Array<{ url: string }>;
  tags: Array<{ name: string }>;
  security: Array<Record<string, string[]>>;
  paths: Record<string, Partial<Record<HttpMethod, OpenApiOperation>>>;
  components: {
    securitySchemes: Record<string, JsonSchema>;
    schemas: Record<string, JsonSchema>;
  };
}

export interface BuiltReference {
  document: OpenApiDocument;
  problems: string[];
}

export const API_PREFIX = '/api/v1';

const ERROR_REF = { $ref: '#/components/schemas/Error' };

const STATUS_TEXT: Record<number, string> = {
  400: 'Bad request',
  401: 'Not signed in',
  403: 'Not allowed',
  404: 'Not found (also for another tenant’s id)',
  409: 'Conflict',
  413: 'Upload too large',
  415: 'Unsupported file type',
  429: 'Too many attempts',
  503: 'Service unavailable',
};

export function routeKey(method: HttpMethod, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

function tagOf(controller: string): string {
  const words = controller
    .replace(/Controller$/, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function operationIdOf(route: DiscoveredRoute): string {
  const base = route.controller.replace(/Controller$/, '');
  return `${base.charAt(0).toLowerCase()}${base.slice(1)}.${route.handler}`;
}

export function jsonSchemaOf(schema: z.ZodType): JsonSchema {
  const json = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as JsonSchema;
  delete json.$schema;
  return json;
}

const SCOPE_TEXT: Record<RouteScope, string> = {
  none: '',
  personal: 'Only the caller’s own data.',
  admin: '',
  record:
    'A member needs an access grant: View on the record (a grant on it, its folder or a folder ' +
    'above). A record the member cannot see answers 404, like a nonexistent one.',
  folder:
    'A member needs an access grant on the folder or a folder above. A folder the member cannot ' +
    'see answers 404, like a nonexistent one.',
  records:
    'Lists and counts only what the caller can see through access grants (admins see everything); ' +
    'batch items outside it fail one by one with NOT_FOUND or FORBIDDEN.',
};

const LEVEL_TEXT: Record<'record' | 'folder', Record<'view' | 'edit', string>> = {
  record: {
    edit: 'Edit to change it; with View only the answer is 403.',
    view: 'View is enough.',
  },
  folder: {
    edit:
      'Edit to change what is in it (renaming, moving or trashing the folder itself needs Edit ' +
      'inherited from its parent); with View only the answer is 403.',
    view: 'View is enough.',
  },
};

function levelOf(route: DiscoveredRoute, doc: RouteDoc): 'view' | 'edit' {
  return doc.level ?? (route.method === 'get' ? 'view' : 'edit');
}

function writesContent(route: DiscoveredRoute, doc: RouteDoc): boolean {
  return (doc.scope === 'record' || doc.scope === 'folder') && levelOf(route, doc) === 'edit';
}

function accessText(route: DiscoveredRoute, doc: RouteDoc): string {
  const who =
    doc.access === 'public'
      ? 'Public: no sign-in.'
      : doc.access === 'signed-in'
        ? 'Any signed-in user.'
        : can({ role: 'member' }, doc.access)
          ? `Members and admins (policy action \`${doc.access}\`).`
          : `Admins only (policy action \`${doc.access}\`).`;
  const level =
    (doc.scope === 'record' || doc.scope === 'folder') && route.method !== 'get'
      ? LEVEL_TEXT[doc.scope][levelOf(route, doc)]
      : '';
  return [who, SCOPE_TEXT[doc.scope], level].filter(Boolean).join(' ');
}

function errorsOf(route: DiscoveredRoute, doc: RouteDoc | undefined): Map<number, Set<string>> {
  const errors = new Map<number, Set<string>>();
  const add = (status: number, code: string) => {
    const codes = errors.get(status) ?? new Set<string>();
    codes.add(code);
    errors.set(status, codes);
  };
  if (route.inputs.length > 0 || doc?.multipart) add(400, 'VALIDATION_FAILED');
  if (!route.isPublic) add(401, 'UNAUTHENTICATED');
  if (doc && doc.access !== 'public' && doc.access !== 'signed-in') {
    if (!can({ role: 'member' }, doc.access)) add(403, 'FORBIDDEN');
  }
  if (doc && writesContent(route, doc)) add(403, 'FORBIDDEN');
  if (route.path.includes('{')) add(404, 'NOT_FOUND');
  if (route.throttled) add(429, 'RATE_LIMITED');
  for (const [status, codes] of Object.entries(doc?.errors ?? {}) as Array<
    [`${DocumentedStatus}`, readonly string[]]
  >) {
    for (const code of codes) add(Number(status), code);
  }
  return errors;
}

function parametersOf(
  route: DiscoveredRoute,
  convert: (input: RouteInput) => JsonSchema | null,
): OpenApiParameter[] {
  const parameters: OpenApiParameter[] = [];
  for (const [, name] of route.path.matchAll(/\{([^}]+)\}/g)) {
    const input = route.inputs.find((i) => i.in === 'path' && i.name === name);
    const schema = input ? convert(input) : null;
    parameters.push({ name, in: 'path', required: true, schema: schema ?? { type: 'string' } });
  }
  for (const input of route.inputs.filter((i) => i.in === 'query')) {
    const schema = convert(input);
    if (!schema) continue;
    if (input.name) {
      parameters.push({ name: input.name, in: 'query', required: false, schema });
      continue;
    }
    const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
    const required = new Set((schema.required ?? []) as string[]);
    for (const [name, property] of Object.entries(properties)) {
      parameters.push({ name, in: 'query', required: required.has(name), schema: property });
    }
  }
  return parameters;
}

function requestBodyOf(
  route: DiscoveredRoute,
  doc: RouteDoc | undefined,
  convert: (input: RouteInput) => JsonSchema | null,
): OpenApiOperation['requestBody'] {
  const body = route.inputs.find((i) => i.in === 'body' && !i.name);
  if (doc?.multipart) {
    const schema = convert({ in: 'body', schema: doc.multipart });
    if (!schema) return undefined;
    const form = {
      ...schema,
      properties: {
        ...((schema.properties ?? {}) as Record<string, JsonSchema>),
        file: { type: 'string', contentMediaType: 'application/octet-stream' },
      },
    };
    return {
      required: true,
      content: { 'application/json': { schema }, 'multipart/form-data': { schema: form } },
    };
  }
  if (!body) return undefined;
  const schema = convert(body);
  return schema ? { required: true, content: { 'application/json': { schema } } } : undefined;
}

function responsesOf(
  route: DiscoveredRoute,
  doc: RouteDoc | undefined,
): Record<string, OpenApiResponse> {
  const success: OpenApiResponse = { description: doc?.response ?? 'Undocumented' };
  if (route.status !== 204) success.content = { [doc?.produces ?? 'application/json']: {} };
  const responses: Record<string, OpenApiResponse> = { [String(route.status)]: success };
  const errors = [...errorsOf(route, doc).entries()].sort(([a], [b]) => a - b);
  for (const [status, codes] of errors) {
    responses[String(status)] = {
      description: `${STATUS_TEXT[status] ?? 'Error'}. Codes: ${[...codes].map((c) => `\`${c}\``).join(', ')}`,
      content: { 'application/json': { schema: ERROR_REF } },
    };
  }
  return responses;
}

export function buildOpenApi(
  routes: readonly DiscoveredRoute[],
  docs: Readonly<Record<string, RouteDoc>>,
): BuiltReference {
  const problems: string[] = [];
  const paths: OpenApiDocument['paths'] = {};
  const seen = new Set<string>();
  const operationIds = new Set<string>();
  const tags = new Set<string>();

  const sorted = [...routes].sort(
    (a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method),
  );
  for (const route of sorted) {
    const key = routeKey(route.method, route.path);
    const where = `${route.controller}.${route.handler}`;
    if (seen.has(key)) {
      problems.push(`Two handlers for ${key} (${where})`);
      continue;
    }
    seen.add(key);
    const doc = docs[key];
    if (!doc) problems.push(`No ROUTE_DOCS entry for ${key} (${where})`);
    if (doc && (doc.access === 'public') !== route.isPublic) {
      problems.push(
        `${key}: ROUTE_DOCS says ${doc.access}, but the route is ${route.isPublic ? '' : 'not '}@Public()`,
      );
    }
    const convert = (input: RouteInput): JsonSchema | null => {
      try {
        return jsonSchemaOf(input.schema);
      } catch (error) {
        problems.push(
          `${key}: the ${input.in} schema cannot be converted (${error instanceof Error ? error.message : String(error)})`,
        );
        return null;
      }
    };
    const operationId = operationIdOf(route);
    if (operationIds.has(operationId)) problems.push(`Duplicate operationId ${operationId}`);
    operationIds.add(operationId);
    const tag = tagOf(route.controller);
    tags.add(tag);
    const parameters = parametersOf(route, convert);
    const requestBody = requestBodyOf(route, doc, convert);
    const operation: OpenApiOperation = {
      operationId,
      summary: doc?.summary ?? 'Undocumented',
      description: [doc ? accessText(route, doc) : '', doc?.description ?? '']
        .filter(Boolean)
        .join(' '),
      tags: [tag],
      ...(route.isPublic ? { security: [] } : {}),
      ...(parameters.length > 0 ? { parameters } : {}),
      ...(requestBody ? { requestBody } : {}),
      responses: responsesOf(route, doc),
      'x-access': doc?.access ?? 'undocumented',
      'x-scope': doc?.scope ?? 'undocumented',
    };
    paths[route.path] = { ...paths[route.path], [route.method]: operation };
  }
  for (const key of Object.keys(docs)) {
    if (!seen.has(key)) problems.push(`ROUTE_DOCS entry without a route: ${key}`);
  }

  return {
    problems,
    document: {
      openapi: '3.1.0',
      info: {
        title: 'Contora API',
        version: 'v1',
        description:
          'Every route but the public ones needs `Authorization: Bearer <access token>`. A foreign tenant’s id answers 404. Errors have the body `{ statusCode, code, message, details?, requestId? }`; `code` is part of the contract.',
      },
      servers: [{ url: API_PREFIX }],
      tags: [...tags].sort().map((name) => ({ name })),
      security: [{ bearer: [] }],
      paths,
      components: {
        securitySchemes: { bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
        schemas: {
          Error: {
            type: 'object',
            required: ['statusCode', 'code', 'message'],
            properties: {
              statusCode: { type: 'integer' },
              code: { type: 'string' },
              message: { type: 'string' },
              details: {},
              requestId: { type: 'string' },
            },
          },
        },
      },
    },
  };
}
