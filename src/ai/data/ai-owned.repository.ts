import type { HydratedDocument, Model, QueryFilter, Types, UpdateQuery } from 'mongoose';
import { isObjectId, toObjectId } from '../../database/object-id.js';
import {
  type FindOptions,
  type NewEntity,
  TenantRepository,
  type TenantOwned,
} from '../../database/tenant.repository.js';

export interface Owner {
  tenantId: string;
  userId: string;
}

export interface UserOwned extends TenantOwned {
  userId: Types.ObjectId;
}

export class AiOwnedRepository<T extends UserOwned> {
  private readonly tenantScoped: TenantRepository<T>;

  constructor(model: Model<T>) {
    this.tenantScoped = new TenantRepository(model);
  }

  private owned(owner: Owner, filter: QueryFilter<T> = {}): QueryFilter<T> {
    return { ...filter, userId: toObjectId(owner.userId) } as QueryFilter<T>;
  }

  create(owner: Owner, data: Omit<NewEntity<T>, 'userId'>): Promise<HydratedDocument<T>> {
    return this.tenantScoped.create(owner.tenantId, {
      ...data,
      userId: toObjectId(owner.userId),
    } as NewEntity<T>);
  }

  findById(owner: Owner, id: string): Promise<HydratedDocument<T> | null> {
    if (!isObjectId(id)) return Promise.resolve(null);
    return this.findOne(owner, { _id: toObjectId(id) } as QueryFilter<T>);
  }

  findOne(owner: Owner, filter: QueryFilter<T>): Promise<HydratedDocument<T> | null> {
    return this.tenantScoped.findOne(owner.tenantId, this.owned(owner, filter));
  }

  find(owner: Owner, filter: QueryFilter<T>, options?: FindOptions) {
    return this.tenantScoped.find(owner.tenantId, this.owned(owner, filter), options);
  }

  count(owner: Owner, filter: QueryFilter<T>): Promise<number> {
    return this.tenantScoped.count(owner.tenantId, this.owned(owner, filter));
  }

  updateOne(
    owner: Owner,
    filter: QueryFilter<T>,
    update: UpdateQuery<T>,
  ): Promise<HydratedDocument<T> | null> {
    return this.tenantScoped.updateOne(owner.tenantId, this.owned(owner, filter), update);
  }

  updateMany(owner: Owner, filter: QueryFilter<T>, update: UpdateQuery<T>): Promise<number> {
    return this.tenantScoped.updateMany(owner.tenantId, this.owned(owner, filter), update);
  }

  deleteMany(owner: Owner, filter: QueryFilter<T>): Promise<number> {
    return this.tenantScoped.deleteMany(owner.tenantId, this.owned(owner, filter));
  }
}
