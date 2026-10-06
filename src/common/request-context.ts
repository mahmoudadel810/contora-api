import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export const REQUEST_ID_HEADER = 'X-Request-Id';

const REQUEST_ID_PATTERN = /^[\w-]{1,64}$/;

export interface RequestContext {
  requestId: string;
}

export interface RequestWithId extends Request {
  requestId?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function isValidRequestId(value: unknown): value is string {
  return typeof value === 'string' && REQUEST_ID_PATTERN.test(value);
}

export function requestIdFor(incoming: unknown): string {
  return isValidRequestId(incoming) ? incoming : randomUUID();
}

export function currentRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}

export function requestIdOf(request: RequestWithId | undefined): string | undefined {
  return request?.requestId ?? currentRequestId();
}

export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const requestId = requestIdFor(req.headers['x-request-id']);
  (req as RequestWithId).requestId = requestId;
  res.setHeader(REQUEST_ID_HEADER, requestId);
  storage.run({ requestId }, () => next());
}
