import { z } from 'zod';
import { CreateRecordSchema } from '../records/records.dto.js';

const ObjectIdText = z.string().regex(/^[a-f0-9]{24}$/, 'Expected an id');

export const StartExtractionSchema = z
  .object({ contentTypeId: ObjectIdText, folderId: ObjectIdText })
  .strict();

export const ConfirmExtractionSchema = CreateRecordSchema;

export type StartExtractionInput = z.infer<typeof StartExtractionSchema>;
export type ConfirmExtractionInput = z.infer<typeof ConfirmExtractionSchema>;
