import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import {
  EXTRACTION_ERROR_CODES,
  EXTRACTION_STATUSES,
  FILE_KINDS,
  TEXT_SOURCES,
  type ExtractionErrorCode,
  type ExtractionStage,
  type ExtractionStatus,
  type FieldReview,
  type FieldSuggestion,
  type FileKind,
  type TextSource,
} from './extraction.types.js';

export const AI_EXTRACTION_JOBS_COLLECTION = 'ai_extraction_jobs';

@Schema({ _id: false })
export class ExtractionFile {
  @Prop({ type: String, default: null }) fileName: string | null;
  @Prop({ required: true }) declaredMimeType: string;
  @Prop({ type: String, enum: FILE_KINDS, required: true }) kind: FileKind;
  @Prop({ required: true }) size: number;
  @Prop({ type: String, default: null }) sha256: string | null;
  @Prop({ type: String, default: null }) stagingKey: string | null;
}
export const ExtractionFileSchema = SchemaFactory.createForClass(ExtractionFile);

@Schema({ _id: false })
export class ExtractionText {
  @Prop({ type: String, enum: [...TEXT_SOURCES, null], default: null }) source: TextSource | null;
  @Prop({ required: true, default: 0 }) charsSent: number;
  @Prop({ required: true, default: false }) truncated: boolean;
}
export const ExtractionTextSchema = SchemaFactory.createForClass(ExtractionText);

@Schema({ _id: false })
export class ExtractionUsage {
  @Prop({ type: String, default: null }) model: string | null;
  @Prop({ type: Number, default: null }) inputTokens: number | null;
  @Prop({ type: Number, default: null }) outputTokens: number | null;
  @Prop({ required: true, default: 0 }) calls: number;
  @Prop({ type: Number, default: null }) durationMs: number | null;
}
export const ExtractionUsageSchema = SchemaFactory.createForClass(ExtractionUsage);

@Schema({ _id: false })
export class ConfirmTarget {
  @Prop({ required: true }) name: string;
  @Prop({ type: Types.ObjectId, required: true }) folderId: Types.ObjectId;
}
export const ConfirmTargetSchema = SchemaFactory.createForClass(ConfirmTarget);

@Schema({ collection: AI_EXTRACTION_JOBS_COLLECTION, timestamps: true })
export class AiExtractionJob {
  @Prop({ type: Types.ObjectId, required: true }) tenantId: Types.ObjectId;
  @Prop({ type: Types.ObjectId, required: true }) userId: Types.ObjectId;
  @Prop({ type: String, enum: EXTRACTION_STATUSES, required: true }) status: ExtractionStatus;
  @Prop({ type: String, enum: ['text', 'fields', null], default: null }) stage: ExtractionStage;
  @Prop({ type: Types.ObjectId, required: true }) contentTypeId: Types.ObjectId;
  @Prop({ required: true }) schemaVersion: number;
  @Prop({ type: Types.ObjectId, required: true }) folderId: Types.ObjectId;
  @Prop({ type: ExtractionFileSchema, required: true }) file: ExtractionFile;
  @Prop({ type: ExtractionTextSchema, default: () => ({}) }) text: ExtractionText;
  @Prop({ type: Object, default: null }) fields: FieldSuggestion[] | null;
  @Prop({ type: Object, default: null }) review: FieldReview[] | null;
  @Prop({ type: ExtractionUsageSchema, default: () => ({}) }) usage: ExtractionUsage;
  @Prop({ required: true }) usageDay: string;
  @Prop({ type: String, enum: [...EXTRACTION_ERROR_CODES, null], default: null })
  errorCode: ExtractionErrorCode | null;
  @Prop({ type: String, default: null }) errorReason: string | null;
  @Prop({ type: String, default: null }) leaseToken: string | null;
  @Prop({ type: String, default: null }) confirmToken: string | null;
  @Prop({ type: Date, default: null }) confirmClaimedAt: Date | null;
  @Prop({ type: ConfirmTargetSchema, default: null }) confirmTarget: ConfirmTarget | null;
  @Prop({ type: Types.ObjectId, default: null }) recordId: Types.ObjectId | null;
  @Prop({ type: Date, required: true }) expiresAt: Date;
  @Prop({ type: Date, default: null }) finishedAt: Date | null;
  @Prop({ type: Date, default: null }) confirmedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type AiExtractionJobDocument = HydratedDocument<AiExtractionJob>;
export const AiExtractionJobSchema = SchemaFactory.createForClass(AiExtractionJob);

AiExtractionJobSchema.index({ tenantId: 1, userId: 1, status: 1 });
AiExtractionJobSchema.index({ tenantId: 1, userId: 1, createdAt: -1 });
AiExtractionJobSchema.index(
  { tenantId: 1, recordId: 1 },
  { unique: true, partialFilterExpression: { recordId: { $type: 'objectId' } } },
);
AiExtractionJobSchema.index({ status: 1, expiresAt: 1 });
AiExtractionJobSchema.index(
  { 'file.stagingKey': 1 },
  { partialFilterExpression: { 'file.stagingKey': { $type: 'string' } } },
);
AiExtractionJobSchema.index(
  { confirmClaimedAt: 1 },
  { partialFilterExpression: { confirmClaimedAt: { $type: 'date' } } },
);
