import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';
import type { SearchCriteria } from './saved-searches.dto.js';

@Schema({ collection: 'saved_searches', timestamps: { createdAt: true, updatedAt: false } })
export class SavedSearch {
  @Prop({ type: Types.ObjectId, required: true }) tenantId: Types.ObjectId;
  @Prop({ type: Types.ObjectId, required: true }) userId: Types.ObjectId;
  @Prop({ required: true }) name: string;
  @Prop({ type: MongooseSchema.Types.Mixed, required: true }) criteria: SearchCriteria;
  createdAt: Date;
}

export type SavedSearchDocument = HydratedDocument<SavedSearch>;
export const SavedSearchSchema = SchemaFactory.createForClass(SavedSearch);
SavedSearchSchema.index({ tenantId: 1, userId: 1, name: 1 }, { unique: true });

export interface SavedSearchView {
  id: string;
  name: string;
  criteria: SearchCriteria;
  createdAt: string;
}

export function toSavedSearchView(search: SavedSearchDocument): SavedSearchView {
  return {
    id: search._id.toHexString(),
    name: search.name,
    criteria: search.criteria,
    createdAt: search.createdAt.toISOString(),
  };
}
