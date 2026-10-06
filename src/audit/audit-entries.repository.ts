import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { TenantRepository } from '../database/tenant.repository.js';
import { AuditEntry } from './audit-entry.schema.js';

@Injectable()
export class AuditEntriesRepository extends TenantRepository<AuditEntry> {
  constructor(@InjectModel(AuditEntry.name) model: Model<AuditEntry>) {
    super(model);
  }
}
