import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { RELATION_KINDS, type RelationDirection, type RelationKind } from './relation-kinds.js';

@Schema({ collection: 'record_relations', timestamps: { createdAt: true, updatedAt: false } })
export class RecordRelation {
  @Prop({ type: Types.ObjectId, required: true }) tenantId: Types.ObjectId;
  @Prop({ type: Types.ObjectId, required: true }) sourceId: Types.ObjectId;
  @Prop({ type: Types.ObjectId, required: true }) targetId: Types.ObjectId;
  @Prop({ type: String, required: true, enum: RELATION_KINDS }) kind: RelationKind;
  @Prop({ required: true }) pairKey: string;
  @Prop({ type: Types.ObjectId, required: true }) createdBy: Types.ObjectId;
  @Prop({ required: true }) createdByName: string;
  createdAt: Date;
}

export type RecordRelationDocument = HydratedDocument<RecordRelation>;
export const RecordRelationSchema = SchemaFactory.createForClass(RecordRelation);
RecordRelationSchema.index({ tenantId: 1, kind: 1, pairKey: 1 }, { unique: true });
RecordRelationSchema.index({ tenantId: 1, sourceId: 1, createdAt: -1 });
RecordRelationSchema.index({ tenantId: 1, targetId: 1, createdAt: -1 });

export interface RelationOtherView {
  id: string;
  name: string;
  contentTypeName: string | null;
  folderId: string | null;
  folderPath: { id: string; name: string }[];
}

export interface RelationView {
  id: string;
  kind: RelationKind;
  direction: RelationDirection;
  label: string;
  other: RelationOtherView;
  createdBy: { id: string; displayName: string };
  createdAt: string;
}

export interface RelationList {
  items: RelationView[];
  total: number;
}
