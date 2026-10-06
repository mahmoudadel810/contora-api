import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, type Types } from 'mongoose';
import { TenantRepository } from '../database/tenant.repository.js';
import { activeFilter, ShareLink, type ShareLinkDocument } from './share-link.schema.js';

@Injectable()
export class ShareLinksRepository extends TenantRepository<ShareLink> {
  constructor(@InjectModel(ShareLink.name) model: Model<ShareLink>) {
    super(model);
  }

  findByTokenHashAcrossTenants(tokenHash: string): Promise<ShareLinkDocument | null> {
    return this.model.findOne({ tokenHash }).exec();
  }

  async firstActiveIds(
    tenantId: string,
    recordId: Types.ObjectId,
    now: Date,
    limit: number,
  ): Promise<string[]> {
    const links = await this.find(
      tenantId,
      { recordId, ...activeFilter(now) },
      { sort: { _id: 1 }, limit },
    );
    return links.map((link) => link._id.toHexString());
  }
}
