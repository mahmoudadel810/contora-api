import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export const REVOKE_REASONS = ['REVOKED', 'SHARER_REMOVED'] as const;
export type RevokeReason = (typeof REVOKE_REASONS)[number];

@Schema({ _id: false })
export class ShareProof {
  @Prop({ required: true }) hash: string;
  @Prop({ required: true }) expiresAt: Date;
}

export const ShareProofSchema = SchemaFactory.createForClass(ShareProof);

@Schema({ collection: 'share_links', timestamps: { createdAt: true, updatedAt: false } })
export class ShareLink {
  @Prop({ type: Types.ObjectId, required: true }) tenantId: Types.ObjectId;
  @Prop({ type: Types.ObjectId, required: true }) recordId: Types.ObjectId;
  @Prop({ required: true }) tokenHash: string;
  @Prop({ type: String, default: null }) passwordHash: string | null;
  @Prop({ required: true }) expiresAt: Date;
  @Prop({ type: Types.ObjectId, required: true }) createdBy: Types.ObjectId;
  @Prop({ required: true }) createdByName: string;
  @Prop({ type: Date, default: null }) revokedAt: Date | null;
  @Prop({ type: Types.ObjectId, default: null }) revokedBy: Types.ObjectId | null;
  @Prop({ type: String, default: null }) revokedByName: string | null;
  @Prop({ type: String, enum: [...REVOKE_REASONS, null], default: null })
  revokeReason: RevokeReason | null;
  @Prop({ required: true, default: 0 }) accessCount: number;
  @Prop({ type: Date, default: null }) lastAccessedAt: Date | null;
  @Prop({ required: true, default: 0 }) failedCount: number;
  @Prop({ type: Date, default: null }) failWindowStartedAt: Date | null;
  @Prop({ type: Date, default: null }) lockedUntil: Date | null;
  @Prop({ type: [ShareProofSchema], default: [] }) proofs: ShareProof[];
  @Prop({ type: Date, default: null }) refusedAuditedAt: Date | null;
  createdAt: Date;
}

export type ShareLinkDocument = HydratedDocument<ShareLink>;
export const ShareLinkSchema = SchemaFactory.createForClass(ShareLink);
ShareLinkSchema.index({ tokenHash: 1 }, { unique: true });
ShareLinkSchema.index({ tenantId: 1, recordId: 1, createdAt: -1 });
ShareLinkSchema.index({ tenantId: 1, createdBy: 1, revokedAt: 1 });
ShareLinkSchema.index({ tenantId: 1, revokedAt: 1, createdAt: -1, expiresAt: 1 });
ShareLinkSchema.index({ tenantId: 1, createdAt: -1 });

export type ShareLinkStatus = 'active' | 'expired' | 'revoked';

export interface ShareLinkView {
  id: string;
  recordId: string;
  status: ShareLinkStatus;
  expiresAt: string;
  hasPassword: boolean;
  sharedBy: { id: string; displayName: string };
  createdAt: string;
  accessCount: number;
  lastAccessedAt: string | null;
  revokedAt: string | null;
  revokedBy: { id: string; displayName: string } | null;
  revokeReason: RevokeReason | null;
}

export interface CreatedShareLinkView extends ShareLinkView {
  url: string;
}

export interface AdminShareLinkView extends ShareLinkView {
  record: { id: string; name: string; trashed: boolean } | null;
}

export interface PublicShareView {
  passwordRequired: false;
  fileName: string;
  size: number;
  mimeType: string;
  sharedByName: string;
  expiresAt: string;
  inlinePreview: boolean;
}

export type ResolvedShare = PublicShareView | { passwordRequired: true };

export interface UnlockedShare {
  access: string;
  accessExpiresAt: string;
  file: PublicShareView;
}

export function statusOf(link: ShareLink, now = new Date()): ShareLinkStatus {
  if (link.revokedAt) return 'revoked';
  if (link.expiresAt.getTime() <= now.getTime()) return 'expired';
  return 'active';
}

export function activeFilter(now: Date) {
  return { revokedAt: null, expiresAt: { $gt: now } };
}

export function toShareLinkView(link: ShareLinkDocument, now = new Date()): ShareLinkView {
  return {
    id: link._id.toHexString(),
    recordId: link.recordId.toHexString(),
    status: statusOf(link, now),
    expiresAt: link.expiresAt.toISOString(),
    hasPassword: link.passwordHash !== null,
    sharedBy: { id: link.createdBy.toHexString(), displayName: link.createdByName },
    createdAt: link.createdAt.toISOString(),
    accessCount: link.accessCount,
    lastAccessedAt: link.lastAccessedAt?.toISOString() ?? null,
    revokedAt: link.revokedAt?.toISOString() ?? null,
    revokedBy: link.revokedBy
      ? { id: link.revokedBy.toHexString(), displayName: link.revokedByName ?? '' }
      : null,
    revokeReason: link.revokeReason,
  };
}

export function toAdminView(
  link: ShareLinkDocument,
  record: AdminShareLinkView['record'],
  now = new Date(),
): AdminShareLinkView {
  return { ...toShareLinkView(link, now), record };
}
