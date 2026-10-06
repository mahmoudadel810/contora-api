import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import type { FileRef } from '../storage/blob.schema.js';

@Schema({ _id: false })
export class FileRefRecord {
  @Prop({ type: Types.ObjectId, required: true }) blobId: Types.ObjectId;
  @Prop({ required: true }) sha256: string;
  @Prop({ required: true }) size: number;
  @Prop({ required: true }) mimeType: string;
  @Prop({ required: true }) fileName: string;
}

export const FileRefSchema = SchemaFactory.createForClass(FileRefRecord);

@Schema({ _id: false })
export class SearchKeys {
  @Prop({ type: String }) text?: string;
  @Prop({ type: Number }) v?: number;
  @Prop({ type: Object }) meta?: Record<string, string>;
  @Prop({ type: Number }) mv?: number;
  @Prop({ type: String, default: undefined }) content?: string | null;
  @Prop({ type: Number }) cv?: number;
}

export const SearchKeysSchema = SchemaFactory.createForClass(SearchKeys);

export const RECORDS_COLLECTION = 'records';

@Schema({ collection: RECORDS_COLLECTION, timestamps: true })
export class RecordEntity {
  @Prop({ type: Types.ObjectId, required: true }) tenantId: Types.ObjectId;
  @Prop({ required: true, trim: true }) name: string;
  @Prop({ type: Types.ObjectId, required: true }) contentTypeId: Types.ObjectId;
  @Prop({ type: Types.ObjectId, required: true }) folderId: Types.ObjectId;
  @Prop({ required: true }) currentVersion: number;
  @Prop({ type: Types.ObjectId, required: true }) currentVersionId: Types.ObjectId;
  @Prop({ type: Object, default: {} }) metadata: Record<string, unknown>;
  @Prop({ required: true }) schemaVersion: number;
  @Prop({ type: FileRefSchema, default: null }) file: FileRef | null;
  @Prop({ required: true, default: '' }) searchText: string;
  @Prop({ type: SearchKeysSchema, select: false, default: undefined }) search?: SearchKeys;
  @Prop({ type: [String], default: [] }) tags: string[];
  @Prop({ type: Types.ObjectId, required: true }) createdBy: Types.ObjectId;
  @Prop({ required: true }) createdByName: string;
  @Prop({ type: Types.ObjectId, required: true }) updatedBy: Types.ObjectId;
  @Prop({ required: true }) updatedByName: string;
  @Prop({ type: Types.ObjectId, default: null }) checkedOutBy: Types.ObjectId | null;
  @Prop({ type: String, default: null }) checkedOutByName: string | null;
  @Prop({ type: Date, default: null }) checkedOutAt: Date | null;
  @Prop({ type: Date, default: null }) deletedAt: Date | null;
  @Prop({ type: Types.ObjectId, default: null }) deletedBy: Types.ObjectId | null;
  @Prop({ type: String, default: null }) deletedByName: string | null;
  @Prop({ type: String, default: null }) trashBatchId: string | null;
  @Prop({ type: String, default: null }) purgeToken: string | null;
  @Prop({ type: Date, default: null }) purgeClaimedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type RecordDocument = HydratedDocument<RecordEntity>;
export const RecordSchema = SchemaFactory.createForClass(RecordEntity);
RecordSchema.index({ tenantId: 1, deletedAt: 1, folderId: 1, name: 1 });
RecordSchema.index({ tenantId: 1, deletedAt: 1, contentTypeId: 1 });
RecordSchema.index({ tenantId: 1, deletedAt: 1, updatedAt: -1 });
RecordSchema.index({ tenantId: 1, trashBatchId: 1 });
RecordSchema.index({ tenantId: 1, deletedAt: 1, tags: 1 });
RecordSchema.index({ tenantId: 1, deletedAt: 1, folderId: 1, name: 1, _id: 1 });
RecordSchema.index({ tenantId: 1, deletedAt: 1, updatedAt: -1, _id: -1 });
RecordSchema.index({ tenantId: 1, deletedAt: 1, createdAt: -1, _id: -1 });
