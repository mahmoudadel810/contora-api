import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { TenantRepository } from '../database/tenant.repository.js';
import { Blob } from './blob.schema.js';

@Injectable()
export class BlobsRepository extends TenantRepository<Blob> {
  constructor(@InjectModel(Blob.name) model: Model<Blob>) {
    super(model);
  }
}
