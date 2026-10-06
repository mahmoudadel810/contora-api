import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import type { FileRef } from '../storage/blob.schema.js';
import { FileRefSchema } from './record.schema.js';

@Schema({ collection: 'record_versions', timestamps: { createdAt: true, updatedAt: false } })
export class RecordVersion {
  @Prop({ type: Types.ObjectId, required: true }) tenantId: Types.ObjectId;
  @Prop({ type: Types.ObjectId, required: true }) recordId: Types.ObjectId;
  @Prop({ required: true }) versionNumber: number;
  @Prop({ type: FileRefSchema, default: null }) file: FileRef | null;
  @Prop({ type: Object, default: {} }) metadata: Record<string, unknown>;
  @Prop({ required: true }) schemaVersion: number;
  @Prop({ default: '' }) comment: string;
  @Prop({ type: Number, default: null }) restoredFrom: number | null;
  @Prop({ type: Types.ObjectId, required: true }) createdBy: Types.ObjectId;
  @Prop({ required: true }) createdByName: string;
  createdAt: Date;
}

export type RecordVersionDocument = HydratedDocument<RecordVersion>;
export const RecordVersionSchema = SchemaFactory.createForClass(RecordVersion);
RecordVersionSchema.index({ recordId: 1, versionNumber: 1 }, { unique: true });
RecordVersionSchema.index({ tenantId: 1, recordId: 1, versionNumber: -1 });
RecordVersionSchema.index({ tenantId: 1, 'file.blobId': 1 });

for (const operation of [
  'updateOne',
  'updateMany',
  'findOneAndUpdate',
  'replaceOne',
  'findOneAndReplace',
] as const) {
  RecordVersionSchema.pre(operation, function rejectMutation() {
    throw new Error('Record versions are immutable');
  });
}
