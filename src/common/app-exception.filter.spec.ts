import { ArgumentsHost, Logger, NotFoundException } from '@nestjs/common';
import { AppExceptionFilter } from './app-exception.filter.js';
import { errors } from './errors.js';

interface Sent {
  status?: number;
  body?: unknown;
}

function hostWith(sent: Sent): ArgumentsHost {
  const response = {
    status(code: number) {
      sent.status = code;
      return this;
    },
    json(body: unknown) {
      sent.body = body;
      return this;
    },
  };
  return {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => ({ method: 'GET', url: '/x' }),
    }),
  } as unknown as ArgumentsHost;
}

describe('AppExceptionFilter', () => {
  const filter = new AppExceptionFilter();

  it('serialises AppError with its code and details', () => {
    const sent: Sent = {};
    filter.catch(errors.validation([{ path: ['email'], message: 'bad' }]), hostWith(sent));
    expect(sent.status).toBe(400);
    expect(sent.body).toEqual({
      statusCode: 400,
      code: 'VALIDATION_FAILED',
      message: 'Request validation failed',
      details: [{ path: ['email'], message: 'bad' }],
    });
  });

  it('gives built-in Nest exceptions a code derived from the status', () => {
    const sent: Sent = {};
    filter.catch(new NotFoundException('Cannot GET /nope'), hostWith(sent));
    expect(sent.status).toBe(404);
    expect(sent.body).toEqual({
      statusCode: 404,
      code: 'NOT_FOUND',
      message: 'Cannot GET /nope',
    });
  });

  it('maps exposed client errors such as malformed JSON to their status', () => {
    const sent: Sent = {};
    const parseError = Object.assign(new SyntaxError('Unexpected token'), {
      status: 400,
      expose: true,
      type: 'entity.parse.failed',
    });
    filter.catch(parseError, hostWith(sent));
    expect(sent.status).toBe(400);
    expect(sent.body).toEqual({
      statusCode: 400,
      code: 'BAD_REQUEST',
      message: 'Unexpected token',
    });
  });

  it('maps a MongoDB duplicate key error to 409 CONFLICT', () => {
    const sent: Sent = {};
    const duplicate = Object.assign(new Error('E11000 duplicate key'), {
      code: 11000,
    });
    filter.catch(duplicate, hostWith(sent));
    expect(sent.status).toBe(409);
    expect(sent.body).toEqual({
      statusCode: 409,
      code: 'CONFLICT',
      message: 'A record with the same unique value already exists',
    });
  });

  it('maps a MongoDB MaxTimeMSExpired error to 503 SEARCH_TIMEOUT without its message', () => {
    const sent: Sent = {};
    const expired = Object.assign(new Error('operation exceeded time limit: secret query'), {
      code: 50,
      codeName: 'MaxTimeMSExpired',
    });
    filter.catch(expired, hostWith(sent));
    expect(sent.status).toBe(503);
    expect(sent.body).toEqual({
      statusCode: 503,
      code: 'SEARCH_TIMEOUT',
      message: 'The search took too long; narrow it down and try again',
    });
    expect(JSON.stringify(sent.body)).not.toContain('secret');
  });

  it('hides unknown errors behind a generic 500', () => {
    const logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const sent: Sent = {};
    filter.catch(new Error('secret internal detail'), hostWith(sent));
    expect(sent.status).toBe(500);
    expect(sent.body).toEqual({
      statusCode: 500,
      code: 'INTERNAL_ERROR',
      message: 'Unexpected server error',
    });
    expect(logged).toHaveBeenCalledOnce();
    logged.mockRestore();
  });
});

describe('AppExceptionFilter request ids', () => {
  const filter = new AppExceptionFilter();

  function hostFor(sent: Sent, request: Record<string, unknown>): ArgumentsHost {
    const response = {
      status(code: number) {
        sent.status = code;
        return this;
      },
      json(body: unknown) {
        sent.body = body;
        return this;
      },
    };
    return {
      switchToHttp: () => ({ getResponse: () => response, getRequest: () => request }),
    } as unknown as ArgumentsHost;
  }

  it('adds the request id to every error body', () => {
    const sent: Sent = {};
    filter.catch(errors.notFound('Record'), hostFor(sent, { requestId: 'r-1' }));
    expect(sent.body).toEqual({
      statusCode: 404,
      code: 'NOT_FOUND',
      message: 'Record not found',
      requestId: 'r-1',
    });
  });

  it('logs a 500 with method, route, status, tenant, user and id, but no headers or body', () => {
    const logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const sent: Sent = {};
    filter.catch(
      new Error('boom'),
      hostFor(sent, {
        method: 'PATCH',
        originalUrl: '/api/v1/records/abc?x=1',
        route: { path: '/api/v1/records/:id' },
        baseUrl: '',
        requestId: 'r-500',
        principal: { tenantId: 't1', userId: 'u1' },
        headers: { authorization: 'Bearer secret-token', cookie: 'rt=secret' },
        body: { password: 'secret' },
      }),
    );
    expect(sent.body).toMatchObject({ statusCode: 500, requestId: 'r-500' });
    expect(logged).toHaveBeenCalledOnce();
    const [fields, stack] = logged.mock.calls[0];
    expect(fields).toEqual({
      message: 'Unexpected server error',
      method: 'PATCH',
      route: '/api/v1/records/:id',
      status: 500,
      tenantId: 't1',
      userId: 'u1',
      requestId: 'r-500',
    });
    expect(JSON.stringify(fields)).not.toContain('secret');
    expect(String(stack)).toContain('boom');
    logged.mockRestore();
  });

  it('only ends a response whose headers were already sent (an open event stream), logging an unexpected error', () => {
    const logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const calls: string[] = [];
    const response = {
      headersSent: true,
      status: () => calls.push('status'),
      json: () => calls.push('json'),
      end: () => calls.push('end'),
    };
    const host = {
      switchToHttp: () => ({
        getResponse: () => response,
        getRequest: () => ({
          method: 'GET',
          originalUrl: '/api/v1/notifications/stream',
          route: { path: '/api/v1/notifications/stream' },
          baseUrl: '',
          requestId: 'r-sse',
          principal: { tenantId: 't1', userId: 'u1' },
          headers: { authorization: 'Bearer secret-token' },
        }),
      }),
    } as unknown as ArgumentsHost;
    filter.catch(new Error('late failure'), host);
    expect(calls).toEqual(['end']);
    expect(logged).toHaveBeenCalledOnce();
    const [fields, stack] = logged.mock.calls[0] ?? [];
    expect(fields).toEqual({
      message: 'Unexpected error after the response started',
      method: 'GET',
      route: '/api/v1/notifications/stream',
      tenantId: 't1',
      userId: 'u1',
      requestId: 'r-sse',
    });
    expect(JSON.stringify(fields)).not.toContain('secret');
    expect(String(stack)).toContain('late failure');

    logged.mockClear();
    calls.length = 0;
    filter.catch(errors.notFound('Record'), host);
    expect(calls).toEqual(['end']);
    expect(logged).not.toHaveBeenCalled();
    logged.mockRestore();
  });
});
