import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, type QueryFilter, type Types } from 'mongoose';
import { TenantRepository } from '../database/tenant.repository.js';
import { Folder } from '../folders/folder.schema.js';
import { RecordEntity } from '../records/record.schema.js';
import { AccessGrant } from './access-grant.schema.js';

@Injectable()
export class AccessGrantsRepository extends TenantRepository<AccessGrant> {
  constructor(@InjectModel(AccessGrant.name) model: Model<AccessGrant>) {
    super(model);
  }

  async tenantsWithGrants(): Promise<string[]> {
    const ids = (await this.model.distinct('tenantId').exec()) as Types.ObjectId[];
    return ids.map((id) => id.toHexString());
  }
}

export interface FolderPath {
  _id: Types.ObjectId;
  parentId: Types.ObjectId | null;
  ancestorIds: Types.ObjectId[];
  isRoot: boolean;
}

@Injectable()
export class AccessFoldersReader extends TenantRepository<Folder> {
  constructor(@InjectModel(Folder.name) model: Model<Folder>) {
    super(model);
  }

  paths(tenantId: string, filter: QueryFilter<Folder>): Promise<FolderPath[]> {
    return this.model
      .find(this.scope(tenantId, filter), { _id: 1, parentId: 1, ancestorIds: 1, isRoot: 1 })
      .lean<FolderPath[]>()
      .exec();
  }
}

@Injectable()
export class AccessRecordsReader extends TenantRepository<RecordEntity> {
  constructor(@InjectModel(RecordEntity.name) model: Model<RecordEntity>) {
    super(model);
  }
}
