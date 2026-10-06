import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import type { FieldDefinition } from './field-types.js';

export const CONTENT_TYPE_STATUSES = ['active', 'archived'] as const;
export type ContentTypeStatus = (typeof CONTENT_TYPE_STATUSES)[number];

@Schema({ collection: 'content_types', timestamps: true })
export class ContentType {
  @Prop({ type: Types.ObjectId, required: true }) tenantId: Types.ObjectId;
  @Prop({ required: true, trim: true }) name: string;
  @Prop({ required: true }) nameKey: string;
  @Prop({ default: '' }) description: string;
  @Prop({ type: [Object], required: true, default: [] }) fields: FieldDefinition[];
  @Prop({ required: true, default: 1 }) schemaVersion: number;
  @Prop({ type: String, enum: CONTENT_TYPE_STATUSES, default: 'active' }) status: ContentTypeStatus;
  @Prop({ default: false }) aiExtraction: boolean;
  @Prop({ type: Types.ObjectId, required: true }) createdBy: Types.ObjectId;
  @Prop({ type: String }) deleteToken?: string | null;
  @Prop({ type: Date }) deleteClaimedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type ContentTypeDocument = HydratedDocument<ContentType>;
export const ContentTypeSchema = SchemaFactory.createForClass(ContentType);
ContentTypeSchema.index({ tenantId: 1, nameKey: 1 }, { unique: true });

export interface ContentTypeView {
  id: string;
  name: string;
  description: string;
  fields: FieldDefinition[];
  schemaVersion: number;
  status: ContentTypeStatus;
  aiExtraction: boolean;
  createdAt: string;
  updatedAt: string;
}

export function toContentTypeView(type: ContentTypeDocument): ContentTypeView {
  return {
    id: type._id.toHexString(),
    name: type.name,
    description: type.description,
    fields: type.fields,
    schemaVersion: type.schemaVersion,
    status: type.status,
    aiExtraction: type.aiExtraction === true,
    createdAt: type.createdAt.toISOString(),
    updatedAt: type.updatedAt.toISOString(),
  };
}

export function nameKeyOf(name: string): string {
  return name.trim().toLowerCase();
}
