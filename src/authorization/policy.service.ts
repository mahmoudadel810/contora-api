import { Injectable } from '@nestjs/common';
import { AuditService, type AuditResource } from '../audit/audit.service.js';
import { actorOf, type Principal } from '../auth/principal.js';
import { errors } from '../common/errors.js';
import { can, type Action } from './policy.js';

@Injectable()
export class PolicyService {
  constructor(private readonly audit: AuditService) {}

  async authorize(principal: Principal, action: Action, resource?: AuditResource): Promise<void> {
    if (can(principal, action)) return;
    await this.audit.record(principal.tenantId, {
      action: 'ACCESS_DENIED',
      actor: actorOf(principal),
      resource,
      context: { attemptedAction: action, role: principal.role },
    });
    throw errors.forbidden();
  }
}
