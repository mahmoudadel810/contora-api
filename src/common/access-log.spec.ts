import type { LoggerService } from '@nestjs/common';
import type { Request, Response } from 'express';
import { EventEmitter } from 'node:events';
import { accessLogMiddleware, routeOf } from './access-log.js';

function requestOf(fields: Partial<Request> & Record<string, unknown>): Request {
  return { method: 'GET', baseUrl: '', ...fields } as unknown as Request;
}

describe('access log', () => {
  it('uses the matched route pattern, else the path without its query string', () => {
    expect(routeOf(requestOf({ route: { path: '/api/v1/records/:id' }, originalUrl: '/x' }))).toBe(
      '/api/v1/records/:id',
    );
    expect(routeOf(requestOf({ originalUrl: '/api/v1/nope?token=secret' }))).toBe('/api/v1/nope');
    expect(
      routeOf(requestOf({ route: { path: '/api/v1*path' }, originalUrl: '/api/v1/gone?x=1' })),
    ).toBe('/api/v1/gone');
  });

  function run(format: 'json' | 'text', req: Request): unknown[] {
    const lines: unknown[] = [];
    const logger = { log: (message: unknown) => lines.push(message) } as LoggerService;
    const res = Object.assign(new EventEmitter(), { statusCode: 201 }) as unknown as Response;
    accessLogMiddleware(logger, format)(req, res, () => undefined);
    res.emit('finish');
    return lines;
  }

  it('writes one structured line per finished request, with who and which id', () => {
    const req = requestOf({
      method: 'POST',
      originalUrl: '/api/v1/records?q=private',
      route: { path: '/api/v1/records' },
      principal: { tenantId: 't1', userId: 'u1' },
      requestId: 'r1',
      headers: { authorization: 'Bearer secret-token', cookie: 'rt=secret' },
    });
    const lines = run('json', req);
    expect(lines).toEqual([
      {
        method: 'POST',
        route: '/api/v1/records',
        status: 201,
        durationMs: expect.any(Number),
        tenantId: 't1',
        userId: 'u1',
        requestId: 'r1',
      },
    ]);
    expect(JSON.stringify(lines)).not.toMatch(/secret|private/);
  });

  it('writes a readable line in text mode', () => {
    const [line] = run('text', requestOf({ originalUrl: '/api/v1/folders', requestId: 'r2' }));
    expect(line).toMatch(/^GET \/api\/v1\/folders 201 [\d.]+ms requestId=r2 tenantId=- userId=-$/);
  });

  it('skips the health probes', () => {
    expect(run('json', requestOf({ originalUrl: '/api/v1/health' }))).toEqual([]);
    expect(run('json', requestOf({ originalUrl: '/api/v1/health/ready?x=1' }))).toEqual([]);
  });

  function emitting(events: string[], writableFinished: boolean): unknown[] {
    const lines: unknown[] = [];
    const logger = { log: (message: unknown) => lines.push(message) } as LoggerService;
    const res = Object.assign(new EventEmitter(), {
      statusCode: 200,
      writableFinished,
    }) as unknown as Response;
    accessLogMiddleware(logger, 'json')(
      requestOf({ originalUrl: '/api/v1/ai/chat' }),
      res,
      () => undefined,
    );
    for (const event of events) res.emit(event);
    return lines;
  }

  it('also logs a response the client closed before it finished (a stopped stream), once', () => {
    const lines = emitting(['close'], false);
    expect(lines).toEqual([expect.objectContaining({ route: '/api/v1/ai/chat', status: 200 })]);
  });

  it('logs a finished response once, not again on close', () => {
    expect(emitting(['finish', 'close'], true)).toHaveLength(1);
  });
});
