import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import type { Principal } from '../auth/principal.js';
import { PolicyService } from '../authorization/policy.service.js';
import { errors } from '../common/errors.js';
import { TenantRepository } from '../database/tenant.repository.js';
import { isObjectId, toObjectId } from '../database/object-id.js';
import { isDuplicateKey } from '../common/duplicate-key.js';
import { SavedSearch, toSavedSearchView, type SavedSearchView } from './saved-search.schema.js';
import type { CreateSavedSearchInput } from './saved-searches.dto.js';

export const MAX_SAVED_SEARCHES = 50;

@Injectable()
export class SavedSearchesService {
  private readonly repository: TenantRepository<SavedSearch>;

  constructor(
    @InjectModel(SavedSearch.name) model: Model<SavedSearch>,
    private readonly policy: PolicyService,
  ) {
    this.repository = new TenantRepository(model);
  }

  async clearForUser(tenantId: string, userId: string): Promise<void> {
    await this.repository.deleteMany(tenantId, { userId: toObjectId(userId) });
  }

  async list(principal: Principal): Promise<SavedSearchView[]> {
    await this.policy.authorize(principal, 'records.read');
    const searches = await this.repository.find(
      principal.tenantId,
      { userId: toObjectId(principal.userId) },
      { sort: { name: 1 }, limit: MAX_SAVED_SEARCHES },
    );
    return searches.map(toSavedSearchView);
  }

  async create(principal: Principal, input: CreateSavedSearchInput): Promise<SavedSearchView> {
    await this.policy.authorize(principal, 'records.read');
    const userId = toObjectId(principal.userId);
    const count = await this.repository.count(principal.tenantId, { userId });
    if (count >= MAX_SAVED_SEARCHES) {
      throw errors.conflict(
        'SAVED_SEARCH_LIMIT',
        `You can keep at most ${MAX_SAVED_SEARCHES} saved searches; delete one first`,
      );
    }
    try {
      const search = await this.repository.create(principal.tenantId, {
        userId,
        name: input.name,
        criteria: input.criteria,
      });
      return toSavedSearchView(search);
    } catch (error) {
      if (isDuplicateKey(error)) {
        throw errors.conflict(
          'NAME_TAKEN',
          `You already have a saved search named "${input.name}"`,
        );
      }
      throw error;
    }
  }

  async remove(principal: Principal, id: string): Promise<void> {
    await this.policy.authorize(principal, 'records.read');
    const removed = isObjectId(id)
      ? await this.repository.deleteMany(principal.tenantId, {
          _id: toObjectId(id),
          userId: toObjectId(principal.userId),
        })
      : 0;
    if (removed === 0) throw errors.notFound('Saved search');
  }
}
