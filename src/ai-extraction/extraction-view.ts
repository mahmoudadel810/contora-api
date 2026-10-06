import type { AiExtractionJob } from './ai-extraction-job.schema.js';
import type {
  ExtractionErrorCode,
  ExtractionStage,
  ExtractionStatus,
  FieldSuggestion,
  FileKind,
  TextSource,
} from './extraction.types.js';

export interface ExtractionJobView {
  id: string;
  status: ExtractionStatus;
  stage: ExtractionStage;
  contentTypeId: string;
  schemaVersion: number;
  file: { fileName: string | null; kind: FileKind; size: number };
  text: { source: TextSource | null; truncated: boolean };
  fields: FieldSuggestion[] | null;
  errorCode: ExtractionErrorCode | null;
  errorReason: string | null;
  retryable: boolean;
  recordId: string | null;
  expiresAt: string;
}

export function isRetryable(
  job: Pick<AiExtractionJob, 'status' | 'errorCode' | 'errorReason'>,
): boolean {
  if (job.status !== 'failed') return false;
  switch (job.errorCode) {
    case 'EXTRACTION_TIMEOUT':
      return true;
    case 'AI_UNAVAILABLE':
      return job.errorReason !== 'content_filter';
    case 'EXTRACTION_INTERRUPTED':
      return job.errorReason === 'restart';
    default:
      return false;
  }
}

export function toExtractionJobView(
  job: AiExtractionJob & { _id: { toHexString(): string } },
): ExtractionJobView {
  return {
    id: job._id.toHexString(),
    status: job.status,
    stage: job.stage ?? null,
    contentTypeId: job.contentTypeId.toHexString(),
    schemaVersion: job.schemaVersion,
    file: { fileName: job.file.fileName ?? null, kind: job.file.kind, size: job.file.size },
    text: { source: job.text?.source ?? null, truncated: job.text?.truncated === true },
    fields: job.fields ?? null,
    errorCode: job.errorCode ?? null,
    errorReason: job.errorReason ?? null,
    retryable: isRetryable(job),
    recordId: job.recordId ? job.recordId.toHexString() : null,
    expiresAt: job.expiresAt.toISOString(),
  };
}
