import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { requestFields } from './access-log.js';
import { requestIdOf } from './request-context.js';
import { isDuplicateKey } from './duplicate-key.js';
import { errors } from './errors.js';
import { isMaxTimeExpired } from './max-time.js';

const CODE_BY_STATUS: Record<number, string> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  422: 'UNPROCESSABLE',
  429: 'RATE_LIMITED',
};

export interface ErrorBody {
  statusCode: number;
  code: string;
  message: string;
  details?: unknown;
  requestId?: string;
}

function clientHttpError(error: unknown): { status: number; message: string } | null {
  if (typeof error !== 'object' || error === null) return null;
  const candidate = error as {
    status?: unknown;
    expose?: unknown;
    message?: unknown;
  };
  if (
    candidate.expose === true &&
    typeof candidate.status === 'number' &&
    candidate.status >= 400 &&
    candidate.status < 500
  ) {
    return {
      status: candidate.status,
      message: typeof candidate.message === 'string' ? candidate.message : 'Bad request',
    };
  }
  return null;
}

function messageOf(body: unknown, fallback: string): string {
  if (typeof body === 'string') return body;
  if (typeof body === 'object' && body !== null) {
    const message = (body as { message?: unknown }).message;
    if (typeof message === 'string') return message;
    if (Array.isArray(message)) return message.map(String).join('; ');
  }
  return fallback;
}

export function toErrorBody(exception: HttpException): ErrorBody {
  const status = exception.getStatus();
  const body = exception.getResponse();
  const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  const code =
    typeof record['code'] === 'string' ? record['code'] : (CODE_BY_STATUS[status] ?? 'HTTP_ERROR');
  const payload: ErrorBody = {
    statusCode: status,
    code,
    message: messageOf(body, exception.message),
  };
  if (record['details'] !== undefined) payload.details = record['details'];
  return payload;
}

@Catch()
export class AppExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('Http');

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<Response>();
    const request = http.getRequest<Request | undefined>();
    const requestId = requestIdOf(request);
    if (response.headersSent) {
      if (!(exception instanceof HttpException)) {
        this.logUnexpected('Unexpected error after the response started', exception, request);
      }
      response.end();
      return;
    }
    const send = (body: ErrorBody): void => {
      response.status(body.statusCode).json(requestId ? { ...body, requestId } : body);
    };

    if (exception instanceof HttpException) {
      send(toErrorBody(exception));
      return;
    }

    if (isMaxTimeExpired(exception)) {
      send(toErrorBody(errors.searchTimeout()));
      return;
    }

    if (isDuplicateKey(exception)) {
      send({
        statusCode: HttpStatus.CONFLICT,
        code: 'CONFLICT',
        message: 'A record with the same unique value already exists',
      });
      return;
    }

    const clientError = clientHttpError(exception);
    if (clientError) {
      send({
        statusCode: clientError.status,
        code: CODE_BY_STATUS[clientError.status] ?? 'BAD_REQUEST',
        message: clientError.message,
      });
      return;
    }

    this.logUnexpected('Unexpected server error', exception, request, {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
    });
    send({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      code: 'INTERNAL_ERROR',
      message: 'Unexpected server error',
    });
  }

  private logUnexpected(
    message: string,
    exception: unknown,
    request: Request | undefined,
    extra: { status?: number } = {},
  ): void {
    this.logger.error(
      {
        message,
        ...(request ? requestFields(request) : {}),
        requestId: requestIdOf(request),
        ...extra,
      },
      exception instanceof Error ? (exception.stack ?? exception.message) : String(exception),
    );
  }
}
