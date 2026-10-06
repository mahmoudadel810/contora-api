import { HttpStatus } from '@nestjs/common';
import { AppError, errors } from '../common/errors.js';
import type { ExtractionStatus } from './extraction.types.js';

export const extractionErrors = {
  off: () =>
    errors.conflict('AI_EXTRACTION_OFF', 'Automatic fill is turned off for this content type'),
  noFillableFields: () =>
    errors.conflict(
      'NO_FILLABLE_FIELDS',
      'This content type has no fields that can be filled from a document',
    ),
  fileTooLarge: (maxMb: number) =>
    new AppError(
      HttpStatus.PAYLOAD_TOO_LARGE,
      'FILE_TOO_LARGE',
      `Automatic fill reads files up to ${maxMb} MB`,
      { maxMb },
    ),
  unsupportedFile: () =>
    new AppError(
      HttpStatus.UNSUPPORTED_MEDIA_TYPE,
      'UNSUPPORTED_FILE',
      'Automatic fill is not available for this file type',
      { reason: 'type' },
    ),
  busy: (scope: 'user' | 'tenant', retryAfterSeconds: number) =>
    new AppError(
      HttpStatus.TOO_MANY_REQUESTS,
      'AI_EXTRACTION_BUSY',
      scope === 'user'
        ? 'You have too many automatic fills open; finish or cancel one first'
        : 'Your workspace is running too many automatic fills; try again shortly',
      { scope, retryAfterSeconds },
    ),
  userLimit: (retryAfterSeconds: number) =>
    new AppError(
      HttpStatus.TOO_MANY_REQUESTS,
      'AI_EXTRACTION_USER_LIMIT',
      'You reached your daily limit for automatic fill',
      { retryAfterSeconds },
    ),
  tenantLimit: (retryAfterSeconds: number) =>
    new AppError(
      HttpStatus.TOO_MANY_REQUESTS,
      'AI_EXTRACTION_TENANT_LIMIT',
      'Your workspace reached its daily limit for automatic fill',
      { retryAfterSeconds },
    ),
  notConfirmable: (status: ExtractionStatus, recordId: string | null, saving: boolean) =>
    new AppError(
      HttpStatus.CONFLICT,
      'EXTRACTION_NOT_CONFIRMABLE',
      'This automatic fill can no longer be saved or changed',
      { status, recordId, saving },
    ),
  typeMismatch: () =>
    errors.conflict(
      'EXTRACTION_TYPE_MISMATCH',
      'The content type differs from the one the document was read for',
    ),
  confirmTimeout: () =>
    new AppError(
      HttpStatus.SERVICE_UNAVAILABLE,
      'EXTRACTION_CONFIRM_TIMEOUT',
      'Saving took too long; reload to see whether the record was created',
    ),
};
