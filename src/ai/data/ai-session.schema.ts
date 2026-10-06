import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

@Schema({ collection: 'ai_sessions', timestamps: true })
export class AiSession {
  @Prop({ type: Types.ObjectId, required: true }) tenantId: Types.ObjectId;
  @Prop({ type: Types.ObjectId, required: true }) userId: Types.ObjectId;
  @Prop({ required: true, minlength: 1, maxlength: 80 }) title: string;
  @Prop({ required: true, default: 0 }) messageCount: number;
  @Prop({ type: Date, required: true }) lastMessageAt: Date;
  @Prop({ type: String, default: null }) turnId: string | null;
  @Prop({ type: Date, default: null }) turnLeaseUntil: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type AiSessionDocument = HydratedDocument<AiSession>;
export const AiSessionSchema = SchemaFactory.createForClass(AiSession);
AiSessionSchema.index({ tenantId: 1, userId: 1, lastMessageAt: -1 });
AiSessionSchema.index({ tenantId: 1, userId: 1, turnLeaseUntil: 1 });

export const MAX_SESSION_MESSAGES = 400;
