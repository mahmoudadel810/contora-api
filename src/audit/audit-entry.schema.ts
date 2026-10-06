import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { AUDIT_ACTIONS, type AuditAction } from './audit-action.js';

@Schema({ _id: false })
export class AuditActorRecord {
  @Prop({ type: Types.ObjectId, required: true }) id: Types.ObjectId;
  @Prop({ required: true }) email: string;
  @Prop({ required: true }) displayName: string;
}

@Schema({ _id: false })
export class AuditResourceRecord {
  @Prop({ required: true }) type: string;
  @Prop() id?: string;
  @Prop() label?: string;
}

@Schema({
  collection: 'audit_entries',
  timestamps: { createdAt: true, updatedAt: false },
})
export class AuditEntry {
  @Prop({ type: Types.ObjectId, required: true }) tenantId: Types.ObjectId;
  @Prop({ type: String, enum: AUDIT_ACTIONS, required: true })
  action: AuditAction;
  @Prop({ type: SchemaFactory.createForClass(AuditActorRecord), default: null })
  actor: AuditActorRecord | null;
  @Prop({
    type: SchemaFactory.createForClass(AuditResourceRecord),
    default: null,
  })
  resource: AuditResourceRecord | null;
  @Prop({ type: Object, default: {} }) context: Record<string, unknown>;
  createdAt: Date;
}

export type AuditEntryDocument = HydratedDocument<AuditEntry>;
export const AuditEntrySchema = SchemaFactory.createForClass(AuditEntry);
AuditEntrySchema.index({ tenantId: 1, createdAt: -1, _id: -1 });
AuditEntrySchema.index({ tenantId: 1, 'actor.id': 1, createdAt: -1 });
AuditEntrySchema.index({ tenantId: 1, action: 1, createdAt: -1 });
AuditEntrySchema.index({
  tenantId: 1,
  'resource.type': 1,
  'resource.id': 1,
  createdAt: -1,
  _id: -1,
});

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
  AuditEntrySchema.pre(operation, function rejectMutation() {
    throw new Error('Audit entries are append-only');
  });
}
