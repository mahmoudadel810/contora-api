import { Injectable } from '@nestjs/common';
import type { QueryFilter, UpdateQuery } from 'mongoose';
import { AccessService } from '../access/access.service.js';
import { AiDataService } from '../ai/data/ai-data.service.js';
import { AiExtractionDataService } from '../ai-extraction/ai-extraction-data.service.js';
import { AuditService } from '../audit/audit.service.js';
import { actorOf, type Principal } from '../auth/principal.js';
import { SessionsService } from '../auth/sessions.service.js';
import { can } from '../authorization/policy.js';
import { PolicyService } from '../authorization/policy.service.js';
import { errors } from '../common/errors.js';
import { DomainEvents } from '../events/domain-events.js';
import { MyRecordsService } from '../my-records/my-records.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { SavedSearchesService } from '../saved-searches/saved-searches.service.js';
import { ShareLinksService } from '../shares/share-links.service.js';
import type { Role } from '../users/role.js';
import { toUserView, type User, type UserDocument, type UserView } from '../users/user.schema.js';
import { UsersRepository } from '../users/users.repository.js';

function lastAdmin() {
  return errors.conflict('LAST_ADMIN', 'A tenant must keep at least one admin');
}

function changedConcurrently() {
  return errors.conflict(
    'MEMBER_CHANGED_CONCURRENTLY',
    'This member was changed meanwhile; reload and try again',
  );
}

export function memberSuspended() {
  return errors.conflict('MEMBER_SUSPENDED', 'This member is suspended; reactivate them first');
}

export const PEOPLE_LIMIT = 1000;

export interface PersonView {
  id: string;
  displayName: string;
}

export interface RejoinInput {
  email: string;
  role: Role;
  displayName: string;
  passwordHash: string;
}

@Injectable()
export class MembersService {
  constructor(
    private readonly users: UsersRepository,
    private readonly sessions: SessionsService,
    private readonly policy: PolicyService,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly myRecords: MyRecordsService,
    private readonly savedSearches: SavedSearchesService,
    private readonly notifications: NotificationsService,
    private readonly access: AccessService,
    private readonly shareLinks: ShareLinksService,
    private readonly aiExtractions: AiExtractionDataService,
    private readonly aiData: AiDataService,
  ) {}

  async list(principal: Principal): Promise<UserView[]> {
    await this.policy.authorize(principal, 'members.read');
    const users = await this.users.find(
      principal.tenantId,
      {},
      { sort: { status: 1, displayName: 1 } },
    );
    return users.map((user) => this.view(principal, user));
  }

  async people(principal: Principal): Promise<PersonView[]> {
    const users = await this.users.find(
      principal.tenantId,
      { status: 'active' },
      { sort: { displayName: 1, _id: 1 }, limit: PEOPLE_LIMIT },
    );
    return users.map((user) => ({ id: user.id as string, displayName: user.displayName }));
  }

  async changeRole(principal: Principal, userId: string, role: Role): Promise<UserView> {
    await this.policy.authorize(principal, 'members.manage', { type: 'user', id: userId });
    const tenantId = principal.tenantId;
    const target = await this.requireMember(tenantId, userId);
    if (target.status === 'suspended') throw memberSuspended();
    if (target.role === role) return this.view(principal, target);
    if (target.role === 'admin') await this.assertNotLastAdmin(tenantId);
    const updated = await this.users.updateOne(
      tenantId,
      { _id: target._id, status: 'active', role: target.role },
      { role },
    );
    if (!updated) {
      const now = await this.requireMember(tenantId, userId);
      if (now.status === 'suspended') throw memberSuspended();
      return this.view(principal, now);
    }
    if (target.role === 'admin') {
      await this.undoIfNoAdminLeft(tenantId, { _id: target._id, role }, { role: target.role });
    }
    await this.audit.record(tenantId, {
      action: 'MEMBER_ROLE_CHANGED',
      actor: actorOf(principal),
      resource: { type: 'user', id: userId, label: target.email },
      context: { from: target.role, to: role },
    });
    await this.events.emit({
      type: 'member.roleChanged',
      tenantId,
      actor: actorOf(principal),
      userId,
      role,
    });
    return this.view(principal, updated);
  }

  async suspend(principal: Principal, userId: string): Promise<UserView> {
    await this.policy.authorize(principal, 'members.manage', { type: 'user', id: userId });
    if (userId === principal.userId) {
      throw errors.badRequest('CANNOT_SUSPEND_SELF', 'You cannot suspend yourself');
    }
    const tenantId = principal.tenantId;
    const target = await this.requireMember(tenantId, userId);
    if (target.status === 'suspended') return this.view(principal, target);
    if (target.role === 'admin') await this.assertNotLastAdmin(tenantId);
    const suspended = await this.users.updateOne(
      tenantId,
      { _id: target._id, status: 'active', role: target.role },
      { status: 'suspended' },
    );
    if (!suspended) {
      const now = await this.requireMember(tenantId, userId);
      if (now.status === 'suspended' && now.role === target.role) return this.view(principal, now);
      throw changedConcurrently();
    }
    if (target.role === 'admin') {
      await this.undoIfNoAdminLeft(
        tenantId,
        { _id: target._id, status: 'suspended' },
        { status: 'active' },
      );
    }
    await this.sessions.endAll(tenantId, userId);
    await this.audit.record(tenantId, {
      action: 'MEMBER_SUSPENDED',
      actor: actorOf(principal),
      resource: { type: 'user', id: userId, label: target.email },
      context: { role: target.role },
    });
    return this.view(principal, suspended);
  }

  async reactivate(principal: Principal, userId: string): Promise<UserView> {
    await this.policy.authorize(principal, 'members.manage', { type: 'user', id: userId });
    const tenantId = principal.tenantId;
    const target = await this.requireMember(tenantId, userId);
    if (target.status === 'active') return this.view(principal, target);
    const { user: reactivated } = await this.sessions.cutOff(tenantId, userId, {
      filter: { status: 'suspended' },
      update: { status: 'active' },
    });
    if (!reactivated) {
      return this.view(principal, await this.requireMember(tenantId, userId));
    }
    await this.audit.record(tenantId, {
      action: 'MEMBER_REACTIVATED',
      actor: actorOf(principal),
      resource: { type: 'user', id: userId, label: target.email },
      context: { role: reactivated.role },
    });
    return this.view(principal, reactivated);
  }

  async remove(principal: Principal, userId: string): Promise<void> {
    await this.policy.authorize(principal, 'members.manage', { type: 'user', id: userId });
    if (userId === principal.userId) {
      throw errors.badRequest('CANNOT_REMOVE_SELF', 'You cannot remove yourself');
    }
    const tenantId = principal.tenantId;
    const target = await this.requireMember(tenantId, userId);
    const countsAsAdmin = target.status === 'active' && target.role === 'admin';
    if (countsAsAdmin) await this.assertNotLastAdmin(tenantId);
    const removed = await this.users.updateOne(
      tenantId,
      { _id: target._id, status: target.status, role: target.role },
      { status: 'removed' },
    );
    if (!removed) {
      await this.requireMember(tenantId, userId);
      throw changedConcurrently();
    }
    if (countsAsAdmin) {
      await this.undoIfNoAdminLeft(
        tenantId,
        { _id: target._id, status: 'removed' },
        { status: target.status },
      );
    }
    await this.sessions.endAll(tenantId, userId);
    const grantsRemoved = await this.access.clearForUser(tenantId, userId);
    await this.aiExtractions.clearForUser(tenantId, userId);
    await this.aiData.clearForUser(tenantId, userId);
    await this.audit.record(tenantId, {
      action: 'MEMBER_REMOVED',
      actor: actorOf(principal),
      resource: { type: 'user', id: userId, label: target.email },
      context: { role: target.role, grantsRemoved },
    });
    await this.shareLinks.revokeAllForUser(tenantId, userId, actorOf(principal));
  }

  async rejoin(tenantId: string, input: RejoinInput): Promise<UserDocument | null> {
    const startedAt = new Date();
    const existing = await this.users.findOne(tenantId, { email: input.email, status: 'removed' });
    if (!existing) return null;
    await this.access.clearForUser(tenantId, existing.id as string, { createdBefore: startedAt });
    await this.shareLinks.revokeAllForUser(tenantId, existing.id as string, null);
    const { user } = await this.sessions.cutOff(
      tenantId,
      existing.id as string,
      {
        filter: { email: input.email, status: 'removed' },
        update: {
          status: 'active',
          role: input.role,
          displayName: input.displayName,
          passwordHash: input.passwordHash,
          lastSignInAt: new Date(),
        },
      },
      { startedBefore: startedAt },
    );
    if (!user) return null;
    const userId = user.id as string;
    await Promise.all([
      this.myRecords.clearForUser(tenantId, userId),
      this.savedSearches.clearForUser(tenantId, userId),
      this.notifications.clearForUser(tenantId, userId),
      this.aiExtractions.clearForUser(tenantId, userId),
      this.aiData.clearForUser(tenantId, userId),
    ]);
    return user;
  }

  private view(principal: Principal, user: UserDocument): UserView {
    return toUserView(user, { withSignIn: can(principal, 'members.manage') });
  }

  private async requireMember(tenantId: string, userId: string): Promise<UserDocument> {
    const user = await this.users.findById(tenantId, userId);
    if (!user || user.status === 'removed') throw errors.notFound('Member');
    return user;
  }

  private async assertNotLastAdmin(tenantId: string): Promise<void> {
    if ((await this.activeAdmins(tenantId)) <= 1) throw lastAdmin();
  }

  private async undoIfNoAdminLeft(
    tenantId: string,
    changed: QueryFilter<User>,
    undo: UpdateQuery<User>,
  ): Promise<void> {
    if ((await this.activeAdmins(tenantId)) > 0) return;
    await this.users.updateOne(tenantId, changed, undo);
    throw lastAdmin();
  }

  private activeAdmins(tenantId: string): Promise<number> {
    return this.users.count(tenantId, { role: 'admin', status: 'active' });
  }
}
