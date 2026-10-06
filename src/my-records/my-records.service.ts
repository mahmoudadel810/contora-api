import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, type Types } from 'mongoose';
import type { AccessScope } from '../access/access-scope.js';
import { AccessService } from '../access/access.service.js';
import type { Principal } from '../auth/principal.js';
import { PolicyService } from '../authorization/policy.service.js';
import { isDuplicateKey } from '../common/duplicate-key.js';
import { TenantRepository } from '../database/tenant.repository.js';
import { isObjectId, toObjectId } from '../database/object-id.js';
import { errors } from '../common/errors.js';
import type { RecordView } from '../records/record.view.js';
import { RecordsRepository } from '../records/records.repository.js';
import { RecordsService } from '../records/records.service.js';
import { RecordFavorite, RecordViewEntry } from './favorite.schema.js';

export const RECENT_LIMIT = 20;
export const VIEWS_KEPT = 100;
const FAVORITES_LIMIT = 200;

export interface RecentRecordView {
  record: RecordView;
  viewedAt: string;
}

@Injectable()
export class MyRecordsService {
  private readonly favorites: TenantRepository<RecordFavorite>;
  private readonly views: TenantRepository<RecordViewEntry>;

  constructor(
    @InjectModel(RecordFavorite.name) favoriteModel: Model<RecordFavorite>,
    @InjectModel(RecordViewEntry.name) viewModel: Model<RecordViewEntry>,
    private readonly records: RecordsService,
    private readonly recordsRepository: RecordsRepository,
    private readonly policy: PolicyService,
    private readonly access: AccessService,
  ) {
    this.favorites = new TenantRepository(favoriteModel);
    this.views = new TenantRepository(viewModel);
  }

  async isFavorite(principal: Principal, recordId: string): Promise<boolean> {
    await this.policy.authorize(principal, 'records.read');
    const record = await this.records.requireVisible(principal, recordId);
    return this.favorites.exists(principal.tenantId, this.mine(principal, record._id));
  }

  async addFavorite(principal: Principal, recordId: string): Promise<void> {
    await this.policy.authorize(principal, 'records.read');
    const record = await this.records.requireVisible(principal, recordId);
    const filter = this.mine(principal, record._id);
    if (await this.favorites.exists(principal.tenantId, filter)) return;
    try {
      await this.favorites.create(principal.tenantId, {
        userId: toObjectId(principal.userId),
        recordId: record._id,
      });
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
    }
  }

  async favoritedBy(tenantId: string, recordId: string): Promise<string[]> {
    const rows = await this.favorites.find(tenantId, { recordId: toObjectId(recordId) });
    return rows.map((row) => row.userId.toHexString());
  }

  async removeFavorite(principal: Principal, recordId: string): Promise<void> {
    await this.policy.authorize(principal, 'records.read');
    if (!isObjectId(recordId)) throw errors.notFound('Record');
    const removed = await this.favorites.deleteMany(
      principal.tenantId,
      this.mine(principal, toObjectId(recordId)),
    );
    if (removed === 0) await this.records.requireVisible(principal, recordId);
  }

  async listFavorites(principal: Principal): Promise<RecordView[]> {
    await this.policy.authorize(principal, 'records.read');
    const rows = await this.favorites.find(
      principal.tenantId,
      { userId: toObjectId(principal.userId) },
      { sort: { createdAt: -1 }, limit: FAVORITES_LIMIT },
    );
    const scope = await this.access.scopeFor(principal);
    const live = await this.liveRecords(
      principal.tenantId,
      rows.map((row) => row.recordId),
      scope,
    );
    return this.records.withNames(
      principal.tenantId,
      rows.flatMap((row) => live.get(row.recordId.toHexString()) ?? []),
      scope,
    );
  }

  async recordView(principal: Principal, recordId: string): Promise<void> {
    await this.policy.authorize(principal, 'records.read');
    const record = await this.records.requireVisible(principal, recordId);
    await this.views
      .upsertOne(principal.tenantId, this.mine(principal, record._id), {
        $set: { viewedAt: new Date() },
      })
      .catch((error: unknown) => {
        if (!isDuplicateKey(error)) throw error;
      });
    await this.pruneViews(principal);
  }

  private async pruneViews(principal: Principal): Promise<void> {
    const mine = { userId: toObjectId(principal.userId) };
    const [oldestKept] = await this.views.find(principal.tenantId, mine, {
      sort: { viewedAt: -1, _id: -1 },
      skip: VIEWS_KEPT - 1,
      limit: 1,
    });
    if (!oldestKept) return;
    await this.views.deleteMany(principal.tenantId, {
      ...mine,
      viewedAt: { $lt: oldestKept.viewedAt },
    });
  }

  async listRecent(principal: Principal): Promise<RecentRecordView[]> {
    await this.policy.authorize(principal, 'records.read');
    const rows = await this.views.find(
      principal.tenantId,
      { userId: toObjectId(principal.userId) },
      { sort: { viewedAt: -1 }, limit: RECENT_LIMIT * 2 },
    );
    const scope = await this.access.scopeFor(principal);
    const live = await this.liveRecords(
      principal.tenantId,
      rows.map((row) => row.recordId),
      scope,
    );
    const shown = rows.filter((row) => live.has(row.recordId.toHexString())).slice(0, RECENT_LIMIT);
    const views = await this.records.withNames(
      principal.tenantId,
      shown.map((row) => live.get(row.recordId.toHexString())!),
      scope,
    );
    return views.map((record, index) => ({
      record,
      viewedAt: shown[index].viewedAt.toISOString(),
    }));
  }

  async clearForUser(tenantId: string, userId: string): Promise<void> {
    const filter = { userId: toObjectId(userId) };
    await Promise.all([
      this.favorites.deleteMany(tenantId, filter),
      this.views.deleteMany(tenantId, filter),
    ]);
  }

  async purgeForRecords(tenantId: string, recordIds: Types.ObjectId[]): Promise<void> {
    const filter = { recordId: { $in: recordIds } };
    await Promise.all([
      this.favorites.deleteMany(tenantId, filter),
      this.views.deleteMany(tenantId, filter),
    ]);
  }

  private mine(principal: Principal, recordId: Types.ObjectId) {
    return { userId: toObjectId(principal.userId), recordId };
  }

  private async liveRecords(tenantId: string, ids: Types.ObjectId[], scope: AccessScope) {
    if (ids.length === 0) return new Map();
    const found = await this.recordsRepository.find(tenantId, {
      $and: [scope.recordFilter('view'), { _id: { $in: ids }, deletedAt: null }],
    });
    return new Map(found.map((record) => [record.id as string, record]));
  }
}
