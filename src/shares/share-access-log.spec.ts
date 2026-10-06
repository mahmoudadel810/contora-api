import { EventEmitter } from 'node:events';
import type { LoggerService } from '@nestjs/common';
import type { Request, Response } from 'express';
import { accessLogMiddleware } from '../common/access-log.js';
import { newSecret } from './share-token.js';

describe('access log on the public share routes', () => {
  function logged(format: 'json' | 'text', req: Request): string {
    const lines: unknown[] = [];
    const logger = { log: (message: unknown) => lines.push(message) } as LoggerService;
    const res = Object.assign(new EventEmitter(), { statusCode: 404 }) as unknown as Response;
    accessLogMiddleware(logger, format)(req, res, () => undefined);
    res.emit('finish');
    expect(lines).toHaveLength(1);
    return JSON.stringify(lines);
  }

  it('logs the route and never the token or proof headers', () => {
    const token = newSecret();
    const access = newSecret();
    for (const [url, route] of [
      ['/api/v1/public/share-link', '/api/v1/public/share-link'],
      ['/api/v1/public/share-link/content?disposition=inline', '/api/v1/public/share-link/content'],
      ['/api/v1/public/share-link/unlock', '/api/v1/public/share-link/unlock'],
    ]) {
      const req = {
        method: 'GET',
        baseUrl: '',
        originalUrl: url,
        route: { path: route },
        headers: { 'x-share-token': token, 'x-share-access': access },
      } as unknown as Request;
      for (const format of ['json', 'text'] as const) {
        const line = logged(format, req);
        expect(line).toContain(route);
        expect(line).not.toContain(token);
        expect(line).not.toContain(access);
      }
    }
  });

  it('never logs a token even when someone puts one in an unmatched path', () => {
    const token = newSecret();
    const req = {
      method: 'GET',
      baseUrl: '',
      originalUrl: `/api/v1/public/share-link/nope?token=${token}`,
      headers: {},
    } as unknown as Request;
    expect(logged('json', req)).not.toContain(token);
  });
});
