import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { TenantRepository } from '../database/tenant.repository.js';
import { ContentType } from './content-type.schema.js';

@Injectable()
export class ContentTypesRepository extends TenantRepository<ContentType> {
  constructor(@InjectModel(ContentType.name) model: Model<ContentType>) {
    super(model);
  }
}
