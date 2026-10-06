import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

@Schema({ collection: 'blobs', timestamps: { createdAt: true, updatedAt: false } })
export class Blob {
  @Prop({ type: Types.ObjectId, required: true }) tenantId: Types.ObjectId;
  @Prop({ required: true }) sha256: string;
  @Prop({ required: true }) size: number;
  @Prop({ required: true }) storageKey: string;
  @Prop({ type: Date, default: null }) lastUsedAt: Date | null;
  createdAt: Date;
}

export type BlobDocument = HydratedDocument<Blob>;
export const BlobSchema = SchemaFactory.createForClass(Blob);
BlobSchema.index({ tenantId: 1, sha256: 1 }, { unique: true });
BlobSchema.index({ tenantId: 1, lastUsedAt: 1, _id: 1 });

export interface FileRef {
  blobId: Types.ObjectId;
  sha256: string;
  size: number;
  mimeType: string;
  fileName: string;
}

export interface FileRefView {
  sha256: string;
  size: number;
  mimeType: string;
  fileName: string;
}

export function toFileRefView(file: FileRef | null): FileRefView | null {
  return file
    ? { sha256: file.sha256, size: file.size, mimeType: file.mimeType, fileName: file.fileName }
    : null;
}
