import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export const AI_EVENT_KINDS = [
  'session_created',
  'session_deleted',
  'message',
  'tool_call',
  'action_proposed',
  'action_confirmed',
  'action_cancelled',
  'action_failed',
  'turn_failed',
  'turn_stopped',
] as const;
export type AiEventKind = (typeof AI_EVENT_KINDS)[number];

export const AI_EVENT_OUTCOMES = ['ok', 'refused', 'error'] as const;
export type AiEventOutcome = (typeof AI_EVENT_OUTCOMES)[number];

@Schema({ collection: 'ai_audit_events' })
export class AiAuditEvent {
  @Prop({ type: Types.ObjectId, required: true }) tenantId: Types.ObjectId;
  @Prop({ type: Types.ObjectId, required: true }) sessionId: Types.ObjectId;
  @Prop({ type: Types.ObjectId, required: true }) userId: Types.ObjectId;
  @Prop({ type: Date, required: true }) timestamp: Date;
  @Prop({ type: String, enum: AI_EVENT_KINDS, required: true }) kind: AiEventKind;
  @Prop({ type: String, default: null }) domain: string | null;
  @Prop({ type: String, default: null }) tool: string | null;
  @Prop({ type: Object, default: null }) argsSummary: Record<string, unknown> | null;
  @Prop({ type: String, enum: AI_EVENT_OUTCOMES, required: true }) outcome: AiEventOutcome;
  @Prop({ type: String, default: null }) errorCode: string | null;
  @Prop({ type: Number, default: null }) durationMs: number | null;
  @Prop({ type: Number, default: null }) inputTokens: number | null;
  @Prop({ type: Number, default: null }) outputTokens: number | null;
  @Prop({ type: String, default: null }) model: string | null;
  @Prop({ required: true, default: false }) isWrite: boolean;
  @Prop({ required: true, default: false }) confirmed: boolean;
  @Prop({ required: true, default: false }) truncated: boolean;
  @Prop({ required: true, default: false }) stopped: boolean;
}

export type AiAuditEventDocument = HydratedDocument<AiAuditEvent>;
export const AiAuditEventSchema = SchemaFactory.createForClass(AiAuditEvent);
AiAuditEventSchema.index({ sessionId: 1, timestamp: 1 });
AiAuditEventSchema.index({ tenantId: 1, timestamp: -1 });

const MUTATIONS = [
  'updateOne',
  'updateMany',
  'findOneAndUpdate',
  'findOneAndReplace',
  'replaceOne',
  'deleteOne',
  'deleteMany',
  'findOneAndDelete',
] as const;

for (const operation of MUTATIONS) {
  AiAuditEventSchema.pre(operation, function rejectMutation() {
    throw new Error('AI audit events are append-only');
  });
}
