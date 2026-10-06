import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

@Schema({ collection: 'record_favorites', timestamps: { createdAt: true, updatedAt: false } })
export class RecordFavorite {
  @Prop({ type: Types.ObjectId, required: true }) tenantId: Types.ObjectId;
  @Prop({ type: Types.ObjectId, required: true }) userId: Types.ObjectId;
  @Prop({ type: Types.ObjectId, required: true }) recordId: Types.ObjectId;
  createdAt: Date;
}

export type RecordFavoriteDocument = HydratedDocument<RecordFavorite>;
export const RecordFavoriteSchema = SchemaFactory.createForClass(RecordFavorite);
RecordFavoriteSchema.index({ tenantId: 1, userId: 1, recordId: 1 }, { unique: true });
RecordFavoriteSchema.index({ tenantId: 1, recordId: 1 });

@Schema({ collection: 'record_views' })
export class RecordViewEntry {
  @Prop({ type: Types.ObjectId, required: true }) tenantId: Types.ObjectId;
  @Prop({ type: Types.ObjectId, required: true }) userId: Types.ObjectId;
  @Prop({ type: Types.ObjectId, required: true }) recordId: Types.ObjectId;
  @Prop({ type: Date, required: true }) viewedAt: Date;
}

export const RecordViewEntrySchema = SchemaFactory.createForClass(RecordViewEntry);
RecordViewEntrySchema.index({ tenantId: 1, userId: 1, recordId: 1 }, { unique: true });
RecordViewEntrySchema.index({ tenantId: 1, userId: 1, viewedAt: -1 });
