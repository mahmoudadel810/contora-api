import { Inject, Injectable } from '@nestjs/common';
import type { QueryFilter } from 'mongoose';
import type { IdLike } from '../access/access-scope.js';
import { AccessService } from '../access/access.service.js';
import { AuditService, type AuditResource } from '../audit/audit.service.js';
import { AuthService } from '../auth/auth.service.js';
import { actorOf, type Actor, type Principal } from '../auth/principal.js';
import { can } from '../authorization/policy.js';
import { PolicyService } from '../authorization/policy.service.js';
import { errors } from '../common/errors.js';
import { skipOf, toPage, type Page, type PageQuery } from '../common/pagination.js';
import { APP_CONFIG, type AppConfig } from '../config/env.js';
import { idOf, isObjectId, toObjectId } from '../database/object-id.js';
import type { RecordDocument } from '../records/record.schema.js';
import { RecordsRepository } from '../records/records.repository.js';
import { UsersRepository } from '../users/users.repository.js';
import { MAX_ACTIVE_LINKS, validateExpiry } from './expiry.js';
import {
  activeFilter,
  toAdminView,
  toShareLinkView,
  type AdminShareLinkView,
  type CreatedShareLinkView,
  type ShareLink,
  type ShareLinkDocument,
  type ShareLinkView,
} from './share-link.schema.js';
import type { CreateShareLinkInput, ListShareLinksQuery } from './share-links.dto.js';
import { ShareLinksRepository } from './share-links.repository.js';
import { hashSecret, newSecret, shareUrlOf } from './share-token.js';

function recordResource(record: Pick<RecordDocument, '_id' | 'name'>): AuditResource {
  return { type: 'record', id: idOf(record), label: record.name };
}

function linkNotFound() {
  return errors.notFound('Share link');
}

function notActive() {
  return errors.conflict('SHARE_LINK_NOT_ACTIVE', 'This share link is no longer active');
}

@Injectable()
export class ShareLinksService {
  constructor(
    private readonly links: ShareLinksRepository,
    private readonly records: RecordsRepository,
    private readonly users: UsersRepository,
    private readonly access: AccessService,
    private readonly policy: PolicyService,
    private readonly audit: AuditService,
    private readonly auth: AuthService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async create(
    principal: Principal,
    recordId: string,
    input: CreateShareLinkInput,
  ): Promise<CreatedShareLinkView> {
    const startedAt = new Date();
    const record = await this.requireShareable(principal, recordId);
    if (!record.file) {
      throw errors.conflict('RECORD_HAS_NO_FILE', 'This record has no file to share');
    }
    const now = new Date();
    const expiresAt = validateExpiry(input.expiresAt, now);
    const passwordHash = input.password ? await this.auth.hashPassword(input.password) : null;
    const token = newSecret();
    const tenantId = principal.tenantId;
    const link = await this.links.create(tenantId, {
      recordId: record._id,
      tokenHash: hashSecret(token),
      passwordHash,
      expiresAt,
      createdBy: toObjectId(principal.userId),
      createdByName: principal.displayName,
      revokedAt: null,
      revokedBy: null,
      revokedByName: null,
      revokeReason: null,
      accessCount: 0,
      lastAccessedAt: null,
      failedCount: 0,
      failWindowStartedAt: null,
      lockedUntil: null,
      proofs: [],
      refusedAuditedAt: null,
    });
    await this.confirmCreated(principal, link, startedAt);
    await this.audit.record(tenantId, {
      action: 'SHARE_LINK_CREATED',
      actor: actorOf(principal),
      resource: recordResource(record),
      context: {
        linkId: idOf(link),
        expiresAt: expiresAt.toISOString(),
        protected: passwordHash !== null,
      },
    });
    return { ...toShareLinkView(link), url: shareUrlOf(this.config.FRONTEND_URL, token) };
  }

  async listForRecord(
    principal: Principal,
    recordId: string,
    query: PageQuery,
  ): Promise<Page<ShareLinkView>> {
    const record = await this.requireShareable(principal, recordId);
    const filter = { recordId: record._id };
    const [links, total] = await Promise.all([
      this.links.find(principal.tenantId, filter, {
        sort: { createdAt: -1, _id: -1 },
        skip: skipOf(query),
        limit: query.pageSize,
      }),
      this.links.count(principal.tenantId, filter),
    ]);
    const now = new Date();
    return toPage(
      links.map((link) => toShareLinkView(link, now)),
      total,
      query,
    );
  }

  async listForTenant(
    principal: Principal,
    query: ListShareLinksQuery,
  ): Promise<Page<AdminShareLinkView>> {
    await this.policy.authorize(principal, 'shareLinks.manageAll', { type: 'shareLink' });
    const now = new Date();
    const filter: QueryFilter<ShareLink> = query.status === 'active' ? activeFilter(now) : {};
    const [links, total] = await Promise.all([
      this.links.find(principal.tenantId, filter, {
        sort: { createdAt: -1, _id: -1 },
        skip: skipOf(query),
        limit: query.pageSize,
      }),
      this.links.count(principal.tenantId, filter),
    ]);
    const recordIds = [...new Set(links.map((link) => link.recordId.toHexString()))];
    const records =
      recordIds.length === 0
        ? []
        : await this.records.find(principal.tenantId, {
            _id: { $in: recordIds.map(toObjectId) },
          });
    const byId = new Map(records.map((record) => [idOf(record), record]));
    return toPage(
      links.map((link) => {
        const record = byId.get(link.recordId.toHexString());
        return toAdminView(
          link,
          record
            ? { id: idOf(record), name: record.name, trashed: record.deletedAt !== null }
            : null,
          now,
        );
      }),
      total,
      query,
    );
  }

  async revoke(principal: Principal, id: string): Promise<void> {
    const tenantId = principal.tenantId;
    const scope = can(principal, 'shareLinks.manageAll')
      ? null
      : await this.access.scopeFor(principal);
    const link = await this.links.findById(tenantId, id);
    if (!link) throw linkNotFound();
    const record = await this.records.findById(tenantId, link.recordId.toHexString());
    const resource: AuditResource = record
      ? recordResource(record)
      : { type: 'record', id: link.recordId.toHexString() };
    if (link.createdBy.equals(principal.userId)) {
      await this.policy.authorize(principal, 'shareLinks.revokeOwn', resource);
    } else if (scope) {
      if (!record || record.deletedAt !== null || scope.levelOfRecord(record) === null) {
        throw linkNotFound();
      }
      await this.policy.authorize(principal, 'shareLinks.manageAll', resource);
    }
    const now = new Date();
    const revoked = await this.links.updateOne(
      tenantId,
      { _id: link._id, ...activeFilter(now) },
      {
        revokedAt: now,
        revokedBy: toObjectId(principal.userId),
        revokedByName: principal.displayName,
        revokeReason: 'REVOKED',
      },
    );
    if (!revoked) throw notActive();
    await this.audit.record(tenantId, {
      action: 'SHARE_LINK_REVOKED',
      actor: actorOf(principal),
      resource,
      context: { linkId: idOf(link), reason: 'REVOKED' },
    });
  }

  async revokeAllForUser(tenantId: string, userId: string, by: Actor | null): Promise<number> {
    if (!isObjectId(userId)) return 0;
    const now = new Date();
    const links = await this.links.find(tenantId, {
      createdBy: toObjectId(userId),
      ...activeFilter(now),
    });
    let count = 0;
    for (const link of links) {
      const revoked = await this.links.updateOne(
        tenantId,
        { _id: link._id, ...activeFilter(now) },
        {
          revokedAt: now,
          revokedBy: by ? toObjectId(by.id) : null,
          revokedByName: by?.displayName ?? null,
          revokeReason: 'SHARER_REMOVED',
        },
      );
      if (!revoked) continue;
      count += 1;
      const record = await this.records.findById(tenantId, link.recordId.toHexString());
      await this.audit.record(tenantId, {
        action: 'SHARE_LINK_REVOKED',
        actor: by,
        resource: record
          ? recordResource(record)
          : { type: 'record', id: link.recordId.toHexString() },
        context: { linkId: idOf(link), reason: 'SHARER_REMOVED' },
      });
    }
    return count;
  }

  async purgeForRecords(tenantId: string, recordIds: readonly IdLike[]): Promise<number> {
    const ids = recordIds
      .map((id) => (typeof id === 'string' ? id : id.toHexString()))
      .filter(isObjectId)
      .map(toObjectId);
    if (ids.length === 0) return 0;
    return this.links.deleteMany(tenantId, { recordId: { $in: ids } });
  }

  private async requireShareable(principal: Principal, recordId: string): Promise<RecordDocument> {
    const record = await this.access.requireRecord(principal, recordId, 'edit');
    await this.policy.authorize(principal, 'shareLinks.create', recordResource(record));
    return record;
  }

  private async confirmCreated(
    principal: Principal,
    link: ShareLinkDocument,
    startedAt: Date,
  ): Promise<void> {
    const tenantId = principal.tenantId;
    const active = await this.links.firstActiveIds(
      tenantId,
      link.recordId,
      new Date(),
      MAX_ACTIVE_LINKS + 1,
    );
    if (active.length > MAX_ACTIVE_LINKS) {
      await this.links.deleteById(tenantId, idOf(link));
      throw errors.conflict(
        'TOO_MANY_SHARE_LINKS',
        `A record can have at most ${MAX_ACTIVE_LINKS} active share links; revoke one first`,
      );
    }
    const sharer = await this.users.findById(tenantId, principal.userId);
    const cutOffSince =
      sharer?.tokensValidAfter != null && sharer.tokensValidAfter.getTime() >= startedAt.getTime();
    if (sharer?.status !== 'active' || cutOffSince) {
      await this.links.deleteById(tenantId, idOf(link));
      throw errors.unauthorized();
    }
  }
}
