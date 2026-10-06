import { confirmMimeType } from './extraction-mime.js';
import type { AiExtractionJob } from './ai-extraction-job.schema.js';
import { isRetryable } from './extraction-view.js';

describe('retryable', () => {
  it.each([
    ['EXTRACTION_TIMEOUT', 'text', true],
    ['EXTRACTION_TIMEOUT', 'model', true],
    ['AI_UNAVAILABLE', 'provider', true],
    ['AI_UNAVAILABLE', 'bad_output', true],
    ['AI_UNAVAILABLE', 'content_filter', false],
    ['EXTRACTION_INTERRUPTED', 'restart', true],
    ['EXTRACTION_INTERRUPTED', 'confirm', false],
    ['UNSUPPORTED_FILE', 'no_text', false],
    ['UNSUPPORTED_FILE', 'type', false],
    ['AI_DISABLED', 'not_configured', false],
  ] as const)('%s {%s} → %s', (errorCode, errorReason, expected) => {
    expect(isRetryable({ status: 'failed', errorCode, errorReason })).toBe(expected);
  });

  it('is false for anything but a failed job', () => {
    expect(isRetryable({ status: 'ready', errorCode: null, errorReason: null })).toBe(false);
    expect(
      isRetryable({ status: 'expired', errorCode: 'EXTRACTION_TIMEOUT', errorReason: 'model' }),
    ).toBe(false);
  });
});

describe('confirmMimeType', () => {
  const job = (kind: 'pdf' | 'zip' | 'text', declared: string, source: string | null = null) =>
    ({
      file: { kind, declaredMimeType: declared },
      text: { source },
    }) as unknown as Pick<AiExtractionJob, 'file' | 'text'>;

  it.each([
    [job('pdf', 'text/plain'), 'application/pdf'],
    [
      job('zip', 'application/octet-stream', 'docx'),
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ],
    [job('zip', 'application/msword'), 'application/zip'],
    [job('text', 'text/csv'), 'text/csv'],
    [job('text', 'Text/Plain; charset=utf-8'), 'text/plain'],
  ])('%#', (input, expected) => {
    expect(confirmMimeType(input)).toBe(expected);
  });
});
