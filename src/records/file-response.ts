import { StreamableFile } from '@nestjs/common';
import type { Response } from 'express';
import type { DownloadQuery } from './records.dto.js';
import type { OpenedFile } from './records.service.js';

export const INLINE_SAFE = /^(image\/(png|jpeg|gif|webp)|application\/pdf|text\/plain)$/;

export function stream(
  opened: OpenedFile,
  response: Response,
  disposition: DownloadQuery['disposition'],
) {
  const mode =
    disposition === 'inline' && INLINE_SAFE.test(opened.file.mimeType) ? 'inline' : 'attachment';
  response.setHeader(
    'Content-Disposition',
    `${mode}; filename*=UTF-8''${encodeURIComponent(opened.file.fileName)}`,
  );
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
  response.setHeader('ETag', `"${opened.file.sha256}"`);
  return new StreamableFile(opened.stream, {
    type: opened.file.mimeType,
    length: opened.file.size,
  });
}
