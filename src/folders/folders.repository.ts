import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { isDuplicateKey } from '../common/duplicate-key.js';
import { TenantRepository } from '../database/tenant.repository.js';
import { toObjectId } from '../database/object-id.js';
import { Folder, type FolderDocument } from './folder.schema.js';

export const ROOT_NAME = 'Repository';

@Injectable()
export class FoldersRepository extends TenantRepository<Folder> {
  constructor(@InjectModel(Folder.name) model: Model<Folder>) {
    super(model);
  }

  async ensureRoot(tenantId: string, createdBy: string): Promise<FolderDocument> {
    try {
      return await this.upsertRoot(tenantId, createdBy);
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
      return this.upsertRoot(tenantId, createdBy);
    }
  }

  private async upsertRoot(tenantId: string, createdBy: string): Promise<FolderDocument> {
    const tenant = toObjectId(tenantId);
    const root = await this.model
      .findOneAndUpdate(
        { tenantId: tenant, isRoot: true },
        {
          $setOnInsert: {
            tenantId: tenant,
            name: ROOT_NAME,
            nameKey: ROOT_NAME.toLowerCase(),
            isRoot: true,
            parentId: null,
            ancestorIds: [],
            createdBy: toObjectId(createdBy),
            deletedAt: null,
            deletedBy: null,
            deletedByName: null,
            trashBatchId: null,
            purgeToken: null,
            purgeClaimedAt: null,
            trashRoot: false,
          },
        },
        { upsert: true, returnDocument: 'after' },
      )
      .exec();
    return root;
  }

  async acquireMoveLease(tenantId: string, token: string, ttlMs: number): Promise<boolean> {
    const now = new Date();
    const result = await this.model
      .updateOne(
        this.scope(tenantId, {
          isRoot: true,
          $or: [{ moveLeaseUntil: null }, { moveLeaseUntil: { $lte: now } }],
        }),
        { $set: { moveLeaseToken: token, moveLeaseUntil: new Date(now.getTime() + ttlMs) } },
        { timestamps: false },
      )
      .exec();
    return result.modifiedCount === 1;
  }

  async releaseMoveLease(tenantId: string, token: string): Promise<void> {
    await this.model
      .updateOne(
        this.scope(tenantId, { isRoot: true, moveLeaseToken: token }),
        { $set: { moveLeaseToken: null, moveLeaseUntil: null } },
        { timestamps: false },
      )
      .exec();
  }
}
