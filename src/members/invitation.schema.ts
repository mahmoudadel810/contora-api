import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { ROLES, type Role } from '../users/role.js';

@Schema({ collection: 'invitations', timestamps: { createdAt: true, updatedAt: false } })
export class Invitation {
  @Prop({ type: Types.ObjectId, required: true }) tenantId: Types.ObjectId;
  @Prop({ required: true, lowercase: true, trim: true }) email: string;
  @Prop({ type: String, enum: ROLES, required: true }) role: Role;
  @Prop({ required: true, unique: true }) tokenHash: string;
  @Prop({ type: Types.ObjectId, required: true }) invitedBy: Types.ObjectId;
  @Prop({ required: true }) invitedByName: string;
  @Prop({ required: true }) expiresAt: Date;
  @Prop({ type: Date, default: null }) acceptedAt: Date | null;
  @Prop({ type: Date, default: null }) revokedAt: Date | null;
  createdAt: Date;
}

export type InvitationDocument = HydratedDocument<Invitation>;
export const InvitationSchema = SchemaFactory.createForClass(Invitation);
InvitationSchema.index({ tenantId: 1, email: 1, createdAt: -1 });

export type InvitationStatus = 'pending' | 'accepted' | 'expired' | 'revoked';

export interface InvitationView {
  id: string;
  email: string;
  role: Role;
  status: InvitationStatus;
  invitedBy: { id: string; displayName: string };
  expiresAt: string;
  createdAt: string;
  acceptUrl: string | null;
}

export function statusOf(invitation: InvitationDocument, now = new Date()): InvitationStatus {
  if (invitation.revokedAt) return 'revoked';
  if (invitation.acceptedAt) return 'accepted';
  if (invitation.expiresAt.getTime() <= now.getTime()) return 'expired';
  return 'pending';
}

export function toInvitationView(
  invitation: InvitationDocument,
  acceptUrl: string | null = null,
): InvitationView {
  return {
    id: invitation._id.toHexString(),
    email: invitation.email,
    role: invitation.role,
    status: statusOf(invitation),
    invitedBy: { id: invitation.invitedBy.toHexString(), displayName: invitation.invitedByName },
    expiresAt: invitation.expiresAt.toISOString(),
    createdAt: invitation.createdAt.toISOString(),
    acceptUrl,
  };
}
