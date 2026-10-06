import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AuditService } from '../audit/audit.service.js';
import { AuthService, type IssuedSession } from '../auth/auth.service.js';
import { actorOf, type Principal } from '../auth/principal.js';
import { PolicyService } from '../authorization/policy.service.js';
import { errors } from '../common/errors.js';
import { APP_CONFIG, type AppConfig } from '../config/env.js';
import { TenantRepository } from '../database/tenant.repository.js';
import { toObjectId } from '../database/object-id.js';
import { Tenant } from '../tenants/tenant.schema.js';
import type { Role } from '../users/role.js';
import type { UserDocument } from '../users/user.schema.js';
import { UsersRepository } from '../users/users.repository.js';
import {
  Invitation,
  statusOf,
  toInvitationView,
  type InvitationDocument,
  type InvitationStatus,
  type InvitationView,
} from './invitation.schema.js';
import { MembersService, memberSuspended } from './members.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface InvitationPreview {
  tenantName: string;
  email: string;
  role: Role;
  status: InvitationStatus;
  expiresAt: string;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

@Injectable()
export class InvitationsService {
  private readonly logger = new Logger('Invitations');
  private readonly repository: TenantRepository<Invitation>;

  constructor(
    @InjectModel(Invitation.name) private readonly model: Model<Invitation>,
    @InjectModel(Tenant.name) private readonly tenants: Model<Tenant>,
    private readonly users: UsersRepository,
    private readonly auth: AuthService,
    private readonly members: MembersService,
    private readonly policy: PolicyService,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    this.repository = new TenantRepository(model);
  }

  async create(principal: Principal, email: string, role: Role): Promise<InvitationView> {
    await this.policy.authorize(principal, 'invitations.manage', {
      type: 'invitation',
      label: email,
    });
    const tenantId = principal.tenantId;
    await this.assertInvitable(tenantId, email);
    const now = new Date();
    const replaced = await this.repository.updateMany(
      tenantId,
      { email, acceptedAt: null, revokedAt: null, expiresAt: { $gt: now } },
      { revokedAt: now },
    );
    const token = randomBytes(32).toString('base64url');
    const invitation = await this.repository.create(tenantId, {
      email,
      role,
      tokenHash: hashToken(token),
      invitedBy: toObjectId(principal.userId),
      invitedByName: principal.displayName,
      expiresAt: new Date(now.getTime() + this.config.INVITATION_TTL_DAYS * DAY_MS),
      acceptedAt: null,
      revokedAt: null,
    });
    const acceptUrl = `${this.config.FRONTEND_URL.replace(/\/+$/, '')}/invitations/accept?token=${token}`;
    if (this.config.NODE_ENV === 'development') {
      this.logger.log(`Invitation for ${email} (${role}): ${acceptUrl}`);
    }
    await this.audit.record(tenantId, {
      action: 'INVITATION_CREATED',
      actor: actorOf(principal),
      resource: { type: 'invitation', id: invitation.id, label: email },
      context: { role, expiresAt: invitation.expiresAt.toISOString(), replacedPending: replaced },
    });
    return toInvitationView(invitation, acceptUrl);
  }

  async list(principal: Principal): Promise<InvitationView[]> {
    await this.policy.authorize(principal, 'invitations.manage');
    const invitations = await this.repository.find(
      principal.tenantId,
      {},
      { sort: { createdAt: -1 } },
    );
    return invitations.map((invitation) => toInvitationView(invitation));
  }

  async revoke(principal: Principal, id: string): Promise<void> {
    await this.policy.authorize(principal, 'invitations.manage', { type: 'invitation', id });
    const invitation = await this.repository.findById(principal.tenantId, id);
    if (!invitation) throw errors.notFound('Invitation');
    this.assertPending(invitation);
    const revoked = await this.repository.updateOne(
      principal.tenantId,
      { _id: invitation._id, acceptedAt: null, revokedAt: null },
      { revokedAt: new Date() },
    );
    if (!revoked) {
      const current = await this.repository.findById(principal.tenantId, id);
      if (!current) throw errors.notFound('Invitation');
      this.assertPending(current);
      throw errors.conflict('INVITATION_NOT_PENDING', 'This invitation is no longer pending');
    }
    await this.audit.record(principal.tenantId, {
      action: 'INVITATION_REVOKED',
      actor: actorOf(principal),
      resource: { type: 'invitation', id, label: invitation.email },
    });
  }

  async preview(token: string): Promise<InvitationPreview> {
    const invitation = await this.findByToken(token);
    const tenant = await this.tenants.findById(invitation.tenantId).exec();
    if (!tenant) throw errors.notFound('Invitation');
    return {
      tenantName: tenant.name,
      email: invitation.email,
      role: invitation.role,
      status: statusOf(invitation),
      expiresAt: invitation.expiresAt.toISOString(),
    };
  }

  async accept(
    token: string,
    displayName: string,
    password: string,
    userAgent: string | null = null,
  ): Promise<IssuedSession> {
    const invitation = await this.findByToken(token);
    this.assertPending(invitation);
    const tenantId = invitation.tenantId.toHexString();
    const claimed = await this.model
      .findOneAndUpdate(
        { _id: invitation._id, acceptedAt: null, revokedAt: null },
        { acceptedAt: new Date() },
        { returnDocument: 'after' },
      )
      .exec();
    if (!claimed)
      throw errors.conflict('INVITATION_NOT_PENDING', 'This invitation is no longer pending');
    let joined: { user: UserDocument; rejoined: boolean };
    try {
      joined = await this.join(tenantId, invitation, displayName, password);
    } catch (error) {
      await this.model.updateOne({ _id: invitation._id }, { acceptedAt: null }).exec();
      throw error;
    }
    const { user, rejoined } = joined;
    await this.audit.record(tenantId, {
      action: 'INVITATION_ACCEPTED',
      actor: { id: user.id, email: user.email, displayName: user.displayName },
      resource: { type: 'invitation', id: invitation.id, label: invitation.email },
      context: { role: invitation.role, ...(rejoined ? { rejoined: true } : {}) },
    });
    return this.auth.issueFor(user, userAgent);
  }

  private async assertInvitable(tenantId: string, email: string): Promise<void> {
    const existing = await this.users.findByEmailAcrossTenants(email);
    if (!existing) return;
    if (!existing.tenantId.equals(tenantId) || existing.status === 'active') {
      throw errors.conflict('EMAIL_TAKEN', 'An account with this email already exists');
    }
    if (existing.status === 'suspended') throw memberSuspended();
  }

  private async join(
    tenantId: string,
    invitation: InvitationDocument,
    displayName: string,
    password: string,
  ): Promise<{ user: UserDocument; rejoined: boolean }> {
    const existing = await this.users.findByEmailAcrossTenants(invitation.email);
    if (existing && existing.tenantId.equals(tenantId) && existing.status === 'removed') {
      const user = await this.members.rejoin(tenantId, {
        email: invitation.email,
        role: invitation.role,
        displayName,
        passwordHash: await this.auth.hashPassword(password),
      });
      if (!user) {
        throw errors.conflict('EMAIL_TAKEN', 'An account with this email already exists');
      }
      return { user, rejoined: true };
    }
    const user = await this.auth.createMember(
      tenantId,
      { email: invitation.email, password, displayName, role: invitation.role },
      { signingIn: true },
    );
    return { user, rejoined: false };
  }

  private async findByToken(token: string): Promise<InvitationDocument> {
    const invitation = await this.model.findOne({ tokenHash: hashToken(token) }).exec();
    if (!invitation) throw errors.notFound('Invitation');
    return invitation;
  }

  private assertPending(invitation: InvitationDocument): void {
    const status = statusOf(invitation);
    if (status !== 'pending') {
      throw errors.conflict('INVITATION_NOT_PENDING', `This invitation is ${status}`);
    }
  }
}
