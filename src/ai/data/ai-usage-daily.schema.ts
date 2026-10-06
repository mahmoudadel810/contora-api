import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export const AI_USAGE_KINDS = ['chat', 'extraction'] as const;
export type AiUsageKind = (typeof AI_USAGE_KINDS)[number];

@Schema({ collection: 'ai_usage_daily' })
export class AiUsageDaily {
  @Prop({ type: Types.ObjectId, required: true }) tenantId: Types.ObjectId;
  @Prop({ type: Types.ObjectId, default: null }) userId: Types.ObjectId | null;
  @Prop({ type: String, enum: AI_USAGE_KINDS, required: true }) kind: AiUsageKind;
  @Prop({ required: true }) day: string;
  @Prop({ required: true, default: 0 }) turns: number;
  @Prop({ required: true, default: 0 }) inputTokens: number;
  @Prop({ required: true, default: 0 }) outputTokens: number;
}

export type AiUsageDailyDocument = HydratedDocument<AiUsageDaily>;
export const AiUsageDailySchema = SchemaFactory.createForClass(AiUsageDaily);
AiUsageDailySchema.index({ tenantId: 1, userId: 1, kind: 1, day: 1 }, { unique: true });
