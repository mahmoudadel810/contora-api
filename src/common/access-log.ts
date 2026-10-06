import type { LoggerService } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import type { RequestWithPrincipal } from '../auth/principal.js';
import { requestIdOf, type RequestWithId } from './request-context.js';

const UNLOGGED_PATHS = new Set(['/api/v1/health', '/api/v1/health/ready']);

type LoggedRequest = RequestWithPrincipal & RequestWithId;

export interface AccessLogEntry {
  method: string;
  route: string;
  status: number;
  durationMs: number;
  tenantId?: string;
  userId?: string;
  requestId?: string;
}

export function routeOf(req: Request): string {
  const route = (req.route as { path?: unknown } | undefined)?.path;
  if (typeof route === 'string' && !route.includes('*')) return `${req.baseUrl ?? ''}${route}`;
  return pathOf(req);
}

function pathOf(req: Request): string {
  const url = req.originalUrl ?? req.url ?? '';
  const query = url.indexOf('?');
  return query === -1 ? url : url.slice(0, query);
}

export function requestFields(
  req: Request,
): Pick<AccessLogEntry, 'method' | 'route' | 'tenantId' | 'userId' | 'requestId'> {
  const request = req as LoggedRequest;
  return {
    method: req.method,
    route: routeOf(req),
    tenantId: request.principal?.tenantId,
    userId: request.principal?.userId,
    requestId: requestIdOf(request),
  };
}

function asText(entry: AccessLogEntry): string {
  return (
    `${entry.method} ${entry.route} ${entry.status} ${entry.durationMs}ms` +
    ` requestId=${entry.requestId ?? '-'} tenantId=${entry.tenantId ?? '-'} userId=${entry.userId ?? '-'}`
  );
}

export function accessLogMiddleware(logger: LoggerService, format: 'json' | 'text') {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (UNLOGGED_PATHS.has(pathOf(req))) {
      next();
      return;
    }
    const started = process.hrtime.bigint();
    let logged = false;
    const log = () => {
      if (logged) return;
      logged = true;
      const entry: AccessLogEntry = {
        ...requestFields(req),
        status: res.statusCode,
        durationMs: Math.round(Number(process.hrtime.bigint() - started) / 1e5) / 10,
      };
      logger.log(format === 'json' ? entry : asText(entry));
    };
    res.on('finish', log);
    res.on('close', () => {
      if (!res.writableFinished) log();
    });
    next();
  };
}
