import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import type { AccessLevel, AccessScope } from '../access/access-scope.js';

@Schema({ collection: 'folders', timestamps: true })
export class Folder {
  @Prop({ type: Types.ObjectId, required: true }) tenantId: Types.ObjectId;
  @Prop({ required: true, trim: true }) name: string;
  @Prop({ required: true }) nameKey: string;
  @Prop({ required: true, default: false }) isRoot: boolean;
  @Prop({ type: Types.ObjectId, default: null }) parentId: Types.ObjectId | null;
  @Prop({ type: [Types.ObjectId], default: [] }) ancestorIds: Types.ObjectId[];
  @Prop({ type: Types.ObjectId, required: true }) createdBy: Types.ObjectId;
  @Prop({ type: Date, default: null }) deletedAt: Date | null;
  @Prop({ type: Types.ObjectId, default: null }) deletedBy: Types.ObjectId | null;
  @Prop({ type: String, default: null }) deletedByName: string | null;
  @Prop({ type: String, default: null }) trashBatchId: string | null;
  @Prop({ type: String, default: null }) purgeToken: string | null;
  @Prop({ type: Date, default: null }) purgeClaimedAt: Date | null;
  @Prop({ default: false }) trashRoot: boolean;
  @Prop({ type: String }) moveLeaseToken?: string | null;
  @Prop({ type: Date }) moveLeaseUntil?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type FolderDocument = HydratedDocument<Folder>;
export const FolderSchema = SchemaFactory.createForClass(Folder);
FolderSchema.index({ tenantId: 1 }, { unique: true, partialFilterExpression: { isRoot: true } });
FolderSchema.index({ tenantId: 1, parentId: 1, nameKey: 1 });
FolderSchema.index({ tenantId: 1, ancestorIds: 1 });
FolderSchema.index({ tenantId: 1, trashBatchId: 1 });

export interface FolderView {
  id: string;
  name: string;
  parentId: string | null;
  isRoot: boolean;
  createdAt: string;
  updatedAt: string;
  access?: AccessLevel;
  accessItself?: AccessLevel | null;
}

export interface FolderCrumb {
  id: string;
  name: string;
}

export interface FolderDetailView {
  folder: FolderView;
  breadcrumbs: FolderCrumb[];
  folders: FolderView[];
  access?: AccessLevel;
  accessItself?: AccessLevel | null;
}

export function toFolderView(folder: FolderDocument, scope: AccessScope): FolderView {
  const access = scope.levelOfFolder(folder);
  return {
    id: folder._id.toHexString(),
    name: folder.name,
    parentId: scope.visibleParentId(folder),
    isRoot: folder.isRoot,
    createdAt: folder.createdAt.toISOString(),
    updatedAt: folder.updatedAt.toISOString(),
    ...(access === null ? {} : { access }),
    accessItself: folder.isRoot ? null : scope.levelOfFolderItself(folder),
  };
}

export function folderNameKey(name: string): string {
  return name.trim().toLowerCase();
}
