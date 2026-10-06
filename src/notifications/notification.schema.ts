import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export const NOTIFICATION_KINDS = [
  'COMMENT_ON_RECORD',
  'NEW_VERSION_OF_FAVORITE',
  'CHECKOUT_FORCE_RELEASED',
  'ROLE_CHANGED',
  'MENTION',
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

@Schema({ collection: 'notifications', timestamps: { createdAt: true, updatedAt: false } })
export class Notification {
  @Prop({ type: Types.ObjectId, required: true }) tenantId: Types.ObjectId;
  @Prop({ type: Types.ObjectId, required: true }) userId: Types.ObjectId;
  @Prop({ type: String, required: true, enum: NOTIFICATION_KINDS }) kind: NotificationKind;
  @Prop({ required: true }) title: string;
  @Prop({ type: String, default: '' }) body: string;
  @Prop({ type: Types.ObjectId, default: null }) recordId: Types.ObjectId | null;
  @Prop({ type: Types.ObjectId, default: null }) commentId: Types.ObjectId | null;
  @Prop({ type: Types.ObjectId, required: true }) actorId: Types.ObjectId;
  @Prop({ required: true }) actorName: string;
  @Prop({ type: Date, default: null }) readAt: Date | null;
  createdAt: Date;
}

export type NotificationDocument = HydratedDocument<Notification>;
export const NotificationSchema = SchemaFactory.createForClass(Notification);
NotificationSchema.index({ tenantId: 1, userId: 1, createdAt: -1 });
NotificationSchema.index({ tenantId: 1, userId: 1, readAt: 1 });
NotificationSchema.index({ tenantId: 1, recordId: 1 });

export interface NotificationView {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  recordId: string | null;
  commentId: string | null;
  actor: { id: string; displayName: string };
  read: boolean;
  createdAt: string;
}

export function toNotificationView(n: NotificationDocument): NotificationView {
  return {
    id: n._id.toHexString(),
    kind: n.kind,
    title: n.title,
    body: n.body,
    recordId: n.recordId?.toHexString() ?? null,
    commentId: n.commentId?.toHexString() ?? null,
    actor: { id: n.actorId.toHexString(), displayName: n.actorName },
    read: n.readAt !== null,
    createdAt: n.createdAt.toISOString(),
  };
}
