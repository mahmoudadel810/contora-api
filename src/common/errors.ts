import { HttpException, HttpStatus } from '@nestjs/common';

export class AppError extends HttpException {
  constructor(
    status: HttpStatus,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(
      {
        statusCode: status,
        code,
        message,
        ...(details === undefined ? {} : { details }),
      },
      status,
    );
  }
}

export const errors = {
  validation: (details: unknown) =>
    new AppError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', 'Request validation failed', details),
  badRequest: (code: string, message: string) =>
    new AppError(HttpStatus.BAD_REQUEST, code, message),
  unauthorized: (message = 'Authentication required') =>
    new AppError(HttpStatus.UNAUTHORIZED, 'UNAUTHENTICATED', message),
  forbidden: (message = 'You are not allowed to do this', code = 'FORBIDDEN') =>
    new AppError(HttpStatus.FORBIDDEN, code, message),
  notFound: (what: string) => new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND', `${what} not found`),
  conflict: (code: string, message: string) => new AppError(HttpStatus.CONFLICT, code, message),
  searchTimeout: () =>
    new AppError(
      HttpStatus.SERVICE_UNAVAILABLE,
      'SEARCH_TIMEOUT',
      'The search took too long; narrow it down and try again',
    ),
};
