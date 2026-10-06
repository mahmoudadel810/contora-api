import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { rm, stat } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Types, type Connection } from 'mongoose';
import { APP_CONFIG, type AppConfig } from '../config/env.js';
import { isDuplicateKey } from '../common/duplicate-key.js';
import { errors } from '../common/errors.js';
import { toObjectId } from '../database/object-id.js';
import type { BlobDocument, FileRef } from './blob.schema.js';
import { BlobsRepository } from './blobs.repository.js';
import { safeFileName } from './file-name.js';
import { FILE_STORAGE, type FileStorage } from './file-storage.js';

export const VERSIONS_COLLECTION = 'record_versions';

export const SWEEP_LIMIT = 200;

export interface UploadedFile {
  path: string;
  originalName: string;
  mimeType: string;
}

function sha256Of(path: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolvePromise(hash.digest('hex')));
  });
}

@Injectable()
export class BlobsService {
  private readonly logger = new Logger(BlobsService.name);

  constructor(
    private readonly blobs: BlobsRepository,
    @InjectConnection() private readonly connection: Connection,
    @Inject(FILE_STORAGE) private readonly storage: FileStorage,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async ingest(tenantId: string, upload: UploadedFile): Promise<FileRef> {
    const [sha256, info] = await Promise.all([sha256Of(upload.path), stat(upload.path)]);
    let blob = await this.blobs.updateOne(
      tenantId,
      { sha256 },
      { $set: { lastUsedAt: new Date() } },
    );
    if (blob && (await this.storage.exists(blob.storageKey))) {
      await rm(upload.path, { force: true });
    } else if (blob) {
      await this.storage.putFromPath(blob.storageKey, upload.path);
    } else {
      const storageKey = `blobs/${tenantId}/${sha256.slice(0, 2)}/${sha256}-${new Types.ObjectId().toHexString()}`;
      await this.storage.putFromPath(storageKey, upload.path);
      blob = await this.createOrFind(tenantId, sha256, info.size, storageKey);
    }
    return {
      blobId: blob._id,
      sha256,
      size: info.size,
      mimeType: upload.mimeType || 'application/octet-stream',
      fileName: safeFileName(upload.originalName),
    };
  }

  async open(tenantId: string, file: FileRef): Promise<Readable> {
    const blob = await this.blobs.findOne(tenantId, { _id: file.blobId });
    if (!blob) throw errors.notFound('File');
    return this.storage.open(blob.storageKey);
  }

  async releaseUnreferenced(tenantId: string, blobIds: Types.ObjectId[]): Promise<number> {
    const tenant = toObjectId(tenantId);
    const cutoff = new Date(Date.now() - this.config.BLOB_REUSE_GRACE_SECONDS * 1000);
    let released = 0;
    for (const blobId of blobIds) {
      const stillUsed = await this.connection
        .collection(VERSIONS_COLLECTION)
        .countDocuments({ tenantId: tenant, 'file.blobId': blobId }, { limit: 1 });
      if (stillUsed > 0) continue;
      const blob = await this.blobs.findOneAndDelete(tenantId, {
        _id: blobId,
        $or: [{ lastUsedAt: null }, { lastUsedAt: { $lte: cutoff } }],
      });
      if (blob) {
        await this.storage.remove(blob.storageKey);
        released += 1;
      }
    }
    return released;
  }

  async sweepUnreferenced(tenantId: string, limit = SWEEP_LIMIT): Promise<number> {
    try {
      const tenant = toObjectId(tenantId);
      const cutoff = new Date(Date.now() - this.config.BLOB_REUSE_GRACE_SECONDS * 1000);
      const candidates = await this.blobs.aggregate<{ _id: Types.ObjectId }>(
        tenantId,
        { $or: [{ lastUsedAt: null }, { lastUsedAt: { $lte: cutoff } }] },
        [
          { $sort: { lastUsedAt: 1, _id: 1 } },
          {
            $lookup: {
              from: VERSIONS_COLLECTION,
              localField: '_id',
              foreignField: 'file.blobId',
              pipeline: [{ $match: { tenantId: tenant } }, { $limit: 1 }, { $project: { _id: 1 } }],
              as: 'references',
            },
          },
          { $match: { references: { $size: 0 } } },
          { $limit: limit },
          { $project: { _id: 1 } },
        ],
      );
      if (candidates.length === 0) return 0;
      const swept = await this.releaseUnreferenced(
        tenantId,
        candidates.map((blob) => blob._id),
      );
      if (swept > 0) this.logger.log(`Swept ${swept} unreferenced blob(s) of tenant ${tenantId}`);
      return swept;
    } catch (error) {
      this.logger.warn(
        `Blob sweep for tenant ${tenantId} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 0;
    }
  }

  async usage(tenantId: string): Promise<{ bytes: number; files: number }> {
    const [result] = await this.blobs.aggregate<{ bytes: number; files: number }>(tenantId, {}, [
      { $group: { _id: null, bytes: { $sum: '$size' }, files: { $sum: 1 } } },
    ]);
    return { bytes: result?.bytes ?? 0, files: result?.files ?? 0 };
  }

  private async createOrFind(
    tenantId: string,
    sha256: string,
    size: number,
    storageKey: string,
  ): Promise<BlobDocument> {
    try {
      return await this.blobs.create(tenantId, {
        sha256,
        size,
        storageKey,
        lastUsedAt: new Date(),
      });
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
      await this.storage.remove(storageKey);
      const existing = await this.blobs.updateOne(
        tenantId,
        { sha256 },
        { $set: { lastUsedAt: new Date() } },
      );
      if (!existing) throw error;
      return existing;
    }
  }
}
