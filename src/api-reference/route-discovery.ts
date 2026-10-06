import { RequestMethod, type Type } from '@nestjs/common';
import {
  GUARDS_METADATA,
  HTTP_CODE_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
  ROUTE_ARGS_METADATA,
} from '@nestjs/common/constants.js';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum.js';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { z } from 'zod';
import { IS_PUBLIC } from '../auth/public.decorator.js';

export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

export interface RouteInput {
  in: 'body' | 'query' | 'path';
  name?: string;
  schema: z.ZodType;
}

export interface DiscoveredRoute {
  method: HttpMethod;
  path: string;
  controller: string;
  handler: string;
  isPublic: boolean;
  throttled: boolean;
  status: number;
  inputs: RouteInput[];
}

const METHODS: Partial<Record<RequestMethod, HttpMethod>> = {
  [RequestMethod.GET]: 'get',
  [RequestMethod.POST]: 'post',
  [RequestMethod.PUT]: 'put',
  [RequestMethod.PATCH]: 'patch',
  [RequestMethod.DELETE]: 'delete',
};

const INPUT_KINDS: Partial<Record<RouteParamtypes, RouteInput['in']>> = {
  [RouteParamtypes.BODY]: 'body',
  [RouteParamtypes.QUERY]: 'query',
  [RouteParamtypes.PARAM]: 'path',
};

interface RouteArg {
  index: number;
  data?: unknown;
  pipes?: unknown[];
}

function firstPath(value: unknown): string {
  const path = Array.isArray(value) ? (value[0] as unknown) : value;
  return typeof path === 'string' ? path : '';
}

export function openApiPath(...parts: string[]): string {
  const joined = `/${parts.join('/')}`.replace(/\/+/g, '/').replace(/\/$/, '');
  return (joined || '/').replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

function schemaOf(pipe: unknown): z.ZodType | null {
  const schema = (pipe as { schema?: unknown } | null)?.schema;
  return schema && typeof schema === 'object' && '_zod' in schema ? (schema as z.ZodType) : null;
}

function inputsOf(controller: Type, handler: string): RouteInput[] {
  const args = (Reflect.getMetadata(ROUTE_ARGS_METADATA, controller, handler) ?? {}) as Record<
    string,
    RouteArg
  >;
  const inputs: RouteInput[] = [];
  for (const [key, arg] of Object.entries(args)) {
    const kind = INPUT_KINDS[Number(key.split(':')[0]) as RouteParamtypes];
    if (!kind) continue;
    for (const pipe of arg.pipes ?? []) {
      const schema = schemaOf(pipe);
      if (!schema) continue;
      inputs.push({
        in: kind,
        ...(typeof arg.data === 'string' ? { name: arg.data } : {}),
        schema,
      });
    }
  }
  return inputs;
}

function isThrottled(handler: object): boolean {
  const guards = (Reflect.getMetadata(GUARDS_METADATA, handler) ?? []) as unknown[];
  return guards.some(
    (guard) =>
      typeof guard === 'function' &&
      (guard === ThrottlerGuard || guard.prototype instanceof ThrottlerGuard),
  );
}

export function discoverRoutes(controllers: Type[]): DiscoveredRoute[] {
  const routes: DiscoveredRoute[] = [];
  for (const controller of controllers) {
    const base = firstPath(Reflect.getMetadata(PATH_METADATA, controller));
    const classPublic = Reflect.getMetadata(IS_PUBLIC, controller) === true;
    const prototype = controller.prototype as Record<string, unknown>;
    for (const handler of Object.getOwnPropertyNames(prototype)) {
      if (handler === 'constructor') continue;
      const fn = prototype[handler];
      if (typeof fn !== 'function') continue;
      const requestMethod = Reflect.getMetadata(METHOD_METADATA, fn) as RequestMethod | undefined;
      if (requestMethod === undefined) continue;
      const method = METHODS[requestMethod];
      if (!method) continue;
      const status =
        (Reflect.getMetadata(HTTP_CODE_METADATA, fn) as number | undefined) ??
        (method === 'post' ? 201 : 200);
      routes.push({
        method,
        path: openApiPath(base, firstPath(Reflect.getMetadata(PATH_METADATA, fn))),
        controller: controller.name,
        handler,
        isPublic: classPublic || Reflect.getMetadata(IS_PUBLIC, fn) === true,
        throttled: isThrottled(fn),
        status,
        inputs: inputsOf(controller, handler),
      });
    }
  }
  return routes;
}
