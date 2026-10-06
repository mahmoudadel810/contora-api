import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { TenantRepository } from '../database/tenant.repository.js';
import { Invitation } from './invitation.schema.js';

@Injectable()
export class InvitationsRepository extends TenantRepository<Invitation> {
  constructor(@InjectModel(Invitation.name) model: Model<Invitation>) {
    super(model);
  }

  countPending(tenantId: string, now: Date): Promise<number> {
    return this.count(tenantId, { acceptedAt: null, revokedAt: null, expiresAt: { $gt: now } });
  }
}
