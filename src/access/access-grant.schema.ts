import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import {
  ACCESS_LEVELS,
  GRANT_TARGET_TYPES,
  type AccessLevel,
  type GrantTargetType,
} from './access-scope.js';

export const ACCESS_GRANTS_COLLECTION = 'access_grants';

@Schema({ collection: ACCESS_GRANTS_COLLECTION, timestamps: true })
export class AccessGrant {
  @Prop({ type: Types.ObjectId, required: true }) tenantId: Types.ObjectId;
  @Prop({ type: Types.ObjectId, required: true }) userId: Types.ObjectId;
  @Prop({ type: String, enum: GRANT_TARGET_TYPES, required: true }) targetType: GrantTargetType;
  @Prop({ type: Types.ObjectId, required: true }) targetId: Types.ObjectId;
  @Prop({ type: String, enum: ACCESS_LEVELS, required: true }) level: AccessLevel;
  @Prop({ type: Types.ObjectId, required: true }) createdBy: Types.ObjectId;
  @Prop({ required: true }) createdByName: string;
  createdAt: Date;
  updatedAt: Date;
}

export type AccessGrantDocument = HydratedDocument<AccessGrant>;
export const AccessGrantSchema = SchemaFactory.createForClass(AccessGrant);
AccessGrantSchema.index({ tenantId: 1, userId: 1, targetType: 1, targetId: 1 }, { unique: true });
AccessGrantSchema.index({ tenantId: 1, targetType: 1, targetId: 1 });

export interface GrantView {
  id: string;
  userId: string;
  userName: string | null;
  targetType: GrantTargetType;
  targetId: string;
  targetName: string | null;
  level: AccessLevel;
  createdBy: string;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
}

export interface InheritedGrantView extends GrantView {
  from: { type: 'folder'; id: string; name: string };
}

export interface TargetGrantsView {
  target: { type: GrantTargetType; id: string; name: string };
  direct: GrantView[];
  inherited: InheritedGrantView[];
}

export type PutGrantResult = GrantView & { created: boolean };

export interface RevokeGrantResult {
  heldCheckouts: Array<{ id: string; name: string }>;
}

export interface EntryPointView {
  type: GrantTargetType;
  id: string;
  name: string;
  level: AccessLevel;
}

export interface MyAccessView {
  unrestricted: boolean;
  entryPoints: EntryPointView[];
}
