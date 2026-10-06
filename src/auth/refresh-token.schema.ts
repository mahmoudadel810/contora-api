import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

@Schema({
  collection: 'refresh_tokens',
  timestamps: { createdAt: true, updatedAt: false },
})
export class RefreshToken {
  @Prop({ type: Types.ObjectId, required: true }) tenantId: Types.ObjectId;
  @Prop({ type: Types.ObjectId, required: true, index: true })
  userId: Types.ObjectId;
  @Prop({ required: true, index: true }) familyId: string;
  @Prop({ required: true, unique: true }) tokenHash: string;
  @Prop({ required: true }) expiresAt: Date;
  @Prop({ type: Date, default: null }) revokedAt: Date | null;
  @Prop({ type: Date, default: null }) rotatedAt: Date | null;
  @Prop({ default: false }) familyRevoked: boolean;
  @Prop({ type: String, default: null }) userAgent: string | null;
  @Prop({ type: Date, default: null }) sessionStartedAt: Date | null;
  createdAt: Date;
}

export type RefreshTokenDocument = HydratedDocument<RefreshToken>;
export const RefreshTokenSchema = SchemaFactory.createForClass(RefreshToken);
RefreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
RefreshTokenSchema.index({ tenantId: 1, userId: 1, familyRevoked: 1, expiresAt: 1 });
