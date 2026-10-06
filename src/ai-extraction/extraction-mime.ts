import type { AiExtractionJob } from './ai-extraction-job.schema.js';
import { baseMimeType } from './file-sniff.js';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export function confirmMimeType(job: Pick<AiExtractionJob, 'file' | 'text'>): string {
  switch (job.file.kind) {
    case 'pdf':
      return 'application/pdf';
    case 'zip':
      return job.text?.source === 'docx' ? DOCX_MIME : 'application/zip';
    case 'text':
      return baseMimeType(job.file.declaredMimeType);
  }
}
