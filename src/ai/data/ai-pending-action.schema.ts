import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { CONFIRM_LABELS, type ConfirmLabel } from '../blocks.js';

export const AI_ACTION_STATUSES = [
  'pending',
  'executing',
  'done',
  'partial',
  'failed',
  'cancelled',
  'expired',
] as const;
export type AiActionStatus = (typeof AI_ACTION_STATUSES)[number];

@Schema({
  collection: 'ai_pending_actions',
  timestamps: { createdAt: true, updatedAt: false },
  minimize: false,
})
export class AiPendingAction {
  @Prop({ type: Types.ObjectId, required: true }) tenantId: Types.ObjectId;
  @Prop({ type: Types.ObjectId, required: true }) sessionId: Types.ObjectId;
  @Prop({ type: Types.ObjectId, required: true }) messageId: Types.ObjectId;
  @Prop({ type: Types.ObjectId, required: true }) userId: Types.ObjectId;
  @Prop({ required: true }) tool: string;
  @Prop({ required: true }) domain: string;
  @Prop({ type: Object, required: true }) args: Record<string, unknown>;
  @Prop({ type: Object, default: null }) base: Record<string, unknown> | null;
  @Prop({ type: Object, required: true }) preview: Record<string, unknown>;
  @Prop({ type: String, default: null }) planId: string | null;
  @Prop({ type: Number, default: null }) step: number | null;
  @Prop({ type: Types.ObjectId, default: null }) dependsOn: Types.ObjectId | null;
  @Prop({ type: String, enum: ['user', 'derived'], required: true, default: 'user' })
  origin: 'user' | 'derived';
  @Prop({ required: true, default: false }) needsFile: boolean;
  @Prop({ required: true, default: false }) destructive: boolean;
  @Prop({ required: true, default: false }) reviewEach: boolean;
  @Prop({ type: Object, required: true, default: () => ({ records: [], folders: [] }) })
  targets: { records: string[]; folders: string[] };
  @Prop({ type: String, enum: CONFIRM_LABELS, required: true, default: 'confirm' })
  confirmLabel: ConfirmLabel;
  @Prop({ type: String, enum: AI_ACTION_STATUSES, required: true, default: 'pending' })
  status: AiActionStatus;
  @Prop({ type: Object, default: null }) result: Record<string, unknown> | null;
  @Prop({ type: String, default: null }) errorCode: string | null;
  @Prop({ type: Date, required: true }) expiresAt: Date;
  @Prop({ type: Date, default: null }) executingSince: Date | null;
  @Prop({ type: Date, default: null }) executedAt: Date | null;
  createdAt: Date;
}

export type AiPendingActionDocument = HydratedDocument<AiPendingAction>;
export const AiPendingActionSchema = SchemaFactory.createForClass(AiPendingAction);
AiPendingActionSchema.index({ tenantId: 1, userId: 1, status: 1, expiresAt: 1 });
AiPendingActionSchema.index({ tenantId: 1, planId: 1, step: 1 });
AiPendingActionSchema.index({ tenantId: 1, sessionId: 1 });
