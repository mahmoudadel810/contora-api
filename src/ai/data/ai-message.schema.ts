import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export const AI_MESSAGE_ROLES = ['user', 'assistant'] as const;
export type AiMessageRole = (typeof AI_MESSAGE_ROLES)[number];
export const AI_MESSAGE_STATUSES = ['complete', 'stopped', 'error'] as const;
export type AiMessageStatus = (typeof AI_MESSAGE_STATUSES)[number];
export const AI_MESSAGE_KINDS = ['answer', 'note'] as const;
export type AiMessageKind = (typeof AI_MESSAGE_KINDS)[number];

@Schema({ _id: false })
export class AiToolTraceEntry {
  @Prop({ required: true }) domain: string;
  @Prop({ required: true }) tool: string;
  @Prop({ required: true, default: false }) ok: boolean;
  @Prop({ type: String, default: null }) code: string | null;
  @Prop({ required: true, default: 0 }) durationMs: number;
}

export interface StoredContext {
  page: string;
  recordId: string | null;
  folderId: string | null;
  contentTypeId: string | null;
  search: { q: string | null; tag: string | null } | null;
  selectedRecordIds: string[];
}

@Schema({ collection: 'ai_messages', timestamps: { createdAt: true, updatedAt: false } })
export class AiMessage {
  @Prop({ type: Types.ObjectId, required: true }) tenantId: Types.ObjectId;
  @Prop({ type: Types.ObjectId, required: true }) sessionId: Types.ObjectId;
  @Prop({ type: Types.ObjectId, required: true }) userId: Types.ObjectId;
  @Prop({ type: String, enum: AI_MESSAGE_ROLES, required: true }) role: AiMessageRole;
  @Prop({ type: String, default: '', maxlength: 20000 }) text: string;
  @Prop({ type: [Object], default: [] }) blocks: Record<string, unknown>[];
  @Prop({ type: [SchemaFactory.createForClass(AiToolTraceEntry)], default: [] })
  toolTrace: AiToolTraceEntry[];
  @Prop({ type: String, enum: AI_MESSAGE_STATUSES, required: true }) status: AiMessageStatus;
  @Prop({ type: String, default: null }) errorCode: string | null;
  @Prop({ required: true, default: false }) stopped: boolean;
  @Prop({ required: true, default: false }) regenerated: boolean;
  @Prop({ type: String, enum: AI_MESSAGE_KINDS, required: true, default: 'answer' })
  kind: AiMessageKind;
  @Prop({ type: Object, default: null }) context: StoredContext | null;
  createdAt: Date;
}

export type AiMessageDocument = HydratedDocument<AiMessage>;
export const AiMessageSchema = SchemaFactory.createForClass(AiMessage);
AiMessageSchema.index({ tenantId: 1, sessionId: 1, createdAt: 1 });
