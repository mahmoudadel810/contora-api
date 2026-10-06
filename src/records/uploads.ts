import { rm } from 'node:fs/promises';
import type { UploadedFile as IngestibleFile } from '../storage/blobs.service.js';

export function ingestible(file: Express.Multer.File | undefined): IngestibleFile | null {
  return file
    ? { path: file.path, originalName: file.originalname, mimeType: file.mimetype }
    : null;
}

export async function discardTemp(file: Express.Multer.File | undefined): Promise<void> {
  if (file?.path) await rm(file.path, { force: true });
}
