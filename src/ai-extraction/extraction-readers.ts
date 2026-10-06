import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { TenantRepository } from '../database/tenant.repository.js';
import { Blob } from '../storage/blob.schema.js';

@Injectable()
export class ExtractionBlobsReader extends TenantRepository<Blob> {
  constructor(@InjectModel(Blob.name) model: Model<Blob>) {
    super(model);
  }
}
