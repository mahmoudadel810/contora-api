import type { Readable } from 'node:stream';
import { HttpStatus, Injectable } from '@nestjs/common';
import type { QueryFilter, UpdateQuery } from 'mongoose';
import { AccessService } from '../access/access.service.js';
import { AuditService, type AuditResource } from '../audit/audit.service.js';
import { AuthService } from '../auth/auth.service.js';
import { AppError, errors } from '../common/errors.js';
import { idOf } from '../database/object-id.js';
import { INLINE_SAFE } from '../records/file-response.js';
import type { RecordDocument } from '../records/record.schema.js';
import { RecordsRepository } from '../records/records.repository.js';
import type { OpenedFile } from '../records/records.service.js';
import type { FileRef } from '../storage/blob.schema.js';
import { BlobsService } from '../storage/blobs.service.js';
import { UsersRepository } from '../users/users.repository.js';
import {
  LOCK_MS,
  LOCK_THRESHOLD,
  LOCK_WINDOW_MS,
  MAX_PROOFS,
  PROOF_TTL_MS,
  REFUSED_AUDIT_INTERVAL_MS,
} from './expiry.js';
import type {
  PublicShareView,
  ResolvedShare,
  ShareLink,
  ShareLinkDocument,
  UnlockedShare,
} from './share-link.schema.js';
import type { ContentQuery } from './share-links.dto.js';
import { ShareLinksRepository } from './share-links.repository.js';
import { hashSecret, newSecret, parseShareToken } from './share-token.js';
import { uaFamilyOf } from './ua-family.js';

export type RefusedReason =
  'revoked' | 'expired' | 'record_unavailable' | 'no_file' | 'sharer_inactive' | 'sharer_no_access';

export interface ShareRequest {
  token: unknown;
  access?: unknown;
  userAgent?: unknown;
}

interface LiveShare {
  link: ShareLinkDocument;
  tenantId: string;
  record: RecordDocument;
  file: FileRef;
}

function shareNotFound(): AppError {
  return errors.notFound('Share link');
}

function locked(): AppError {
  return new AppError(
    HttpStatus.TOO_MANY_REQUESTS,
    'SHARE_LINK_LOCKED',
    'Too many wrong passwords; try again later',
  );
}

function notLocked(now: Date): QueryFilter<ShareLink> {
  return { $or: [{ lockedUntil: null }, { lockedUntil: { $lte: now } }] };
}

function publicViewOf(live: LiveShare): PublicShareView {
  return {
    passwordRequired: false,
    fileName: live.file.fileName,
    size: live.file.size,
    mimeType: live.file.mimeType,
    sharedByName: live.link.createdByName,
    expiresAt: live.link.expiresAt.toISOString(),
    inlinePreview: INLINE_SAFE.test(live.file.mimeType),
  };
}

function resourceOf(link: ShareLinkDocument, record: RecordDocument | null): AuditResource {
  return record
    ? { type: 'record', id: idOf(record), label: record.name }
    : { type: 'record', id: link.recordId.toHexString() };
}

@Injectable()
export class ShareAccessService {
  constructor(
    private readonly links: ShareLinksRepository,
    private readonly records: RecordsRepository,
    private readonly users: UsersRepository,
    private readonly access: AccessService,
    private readonly blobs: BlobsService,
    private readonly auth: AuthService,
    private readonly audit: AuditService,
  ) {}

  async resolve(request: ShareRequest): Promise<ResolvedShare> {
    const now = new Date();
    const live = await this.requireLive(request.token, now);
    const proof = parseShareToken(request.access);
    if (live.link.passwordHash !== null && !this.holdsProof(live.link, proof, now)) {
      return { passwordRequired: true };
    }
    await this.claim(live, proof, now);
    await this.served(live, 'view', request.userAgent);
    return publicViewOf(live);
  }

  async unlock(request: ShareRequest, password: string): Promise<UnlockedShare> {
    const now = new Date();
    let live: LiveShare;
    try {
      live = await this.requireLive(request.token, now);
    } catch (error) {
      await this.auth.comparePassword(password, null);
      throw error;
    }
    const { link, tenantId } = live;
    if (link.passwordHash === null) {
      await this.claim(live, null, now);
      await this.served(live, 'view', request.userAgent);
      return {
        access: newSecret(),
        accessExpiresAt: link.expiresAt.toISOString(),
        file: publicViewOf(live),
      };
    }
    const reserved = await this.reserveAttempt(live, now);
    if (!reserved) throw locked();
    if (!(await this.auth.comparePassword(password, link.passwordHash))) {
      return this.failed(live, reserved, now);
    }
    await this.links.updateOne(
      tenantId,
      { _id: link._id, failedCount: { $gte: 1 } },
      { $inc: { failedCount: -1 } },
    );
    const access = newSecret();
    const accessExpiresAt = new Date(
      Math.min(now.getTime() + PROOF_TTL_MS, link.expiresAt.getTime()),
    );
    const issued = await this.links.updateOne(
      tenantId,
      { _id: link._id, revokedAt: null, expiresAt: { $gt: now }, ...notLocked(now) },
      {
        $push: {
          proofs: {
            $each: [{ hash: hashSecret(access), expiresAt: accessExpiresAt }],
            $slice: -MAX_PROOFS,
          },
        },
      } as UpdateQuery<ShareLink>,
    );
    if (!issued) {
      const current = await this.links.findById(tenantId, idOf(link));
      if (current?.lockedUntil && current.lockedUntil.getTime() > Date.now()) throw locked();
      throw shareNotFound();
    }
    return { access, accessExpiresAt: accessExpiresAt.toISOString(), file: publicViewOf(live) };
  }

  async content(
    request: ShareRequest,
    disposition: ContentQuery['disposition'],
  ): Promise<OpenedFile> {
    const now = new Date();
    const live = await this.requireLive(request.token, now);
    const proof = parseShareToken(request.access);
    if (live.link.passwordHash !== null && !this.holdsProof(live.link, proof, now)) {
      throw errors.forbidden('This link needs its password', 'SHARE_LINK_PASSWORD_REQUIRED');
    }
    let stream: Readable;
    try {
      stream = await this.blobs.open(live.tenantId, live.file);
    } catch {
      throw shareNotFound();
    }
    const kind =
      disposition === 'inline' && INLINE_SAFE.test(live.file.mimeType) ? 'preview' : 'download';
    try {
      await this.claim(live, proof, now);
      await this.served(live, kind, request.userAgent);
    } catch (error) {
      stream.destroy();
      throw error;
    }
    return {
      stream,
      file: {
        sha256: live.file.sha256,
        size: live.file.size,
        mimeType: live.file.mimeType,
        fileName: live.file.fileName,
      },
    };
  }

  private async requireLive(rawToken: unknown, now: Date): Promise<LiveShare> {
    const token = parseShareToken(rawToken);
    if (!token) throw shareNotFound();
    const link = await this.links.findByTokenHashAcrossTenants(hashSecret(token));
    if (!link) throw shareNotFound();
    const tenantId = link.tenantId.toHexString();
    if (link.revokedAt !== null) return this.refused(link, null, 'revoked', now);
    if (link.expiresAt.getTime() <= now.getTime()) {
      return this.refused(link, null, 'expired', now);
    }
    const record = await this.records.findById(tenantId, link.recordId.toHexString());
    if (!record || record.deletedAt !== null || record.purgeToken !== null) {
      return this.refused(link, record, 'record_unavailable', now);
    }
    if (!record.file) return this.refused(link, record, 'no_file', now);
    const sharerId = link.createdBy.toHexString();
    const sharer = await this.users.findById(tenantId, sharerId);
    if (!sharer || sharer.status !== 'active') {
      return this.refused(link, record, 'sharer_inactive', now);
    }
    if (sharer.role !== 'admin') {
      const scope = await this.access.scopeForUser(tenantId, sharerId);
      if (scope.levelOfRecord({ _id: record._id, folderId: record.folderId }) === null) {
        return this.refused(link, record, 'sharer_no_access', now);
      }
    }
    return { link, tenantId, record, file: record.file };
  }

  private async refused(
    link: ShareLinkDocument,
    record: RecordDocument | null,
    reason: RefusedReason,
    now: Date,
  ): Promise<never> {
    const tenantId = link.tenantId.toHexString();
    const claimed = await this.links.updateOne(
      tenantId,
      {
        _id: link._id,
        $or: [
          { refusedAuditedAt: null },
          { refusedAuditedAt: { $lte: new Date(now.getTime() - REFUSED_AUDIT_INTERVAL_MS) } },
        ],
      },
      { refusedAuditedAt: now },
    );
    if (claimed) {
      await this.audit.record(tenantId, {
        action: 'SHARE_LINK_ACCESSED',
        actor: null,
        resource: resourceOf(link, record),
        context: { linkId: idOf(link), outcome: 'refused', reason },
      });
    }
    throw shareNotFound();
  }

  private holdsProof(link: ShareLinkDocument, proof: string | null, now: Date): boolean {
    if (!proof) return false;
    const hash = hashSecret(proof);
    return link.proofs.some((p) => p.hash === hash && p.expiresAt.getTime() > now.getTime());
  }

  private async claim(live: LiveShare, proof: string | null, now: Date): Promise<void> {
    const needsProof = live.link.passwordHash !== null;
    if (needsProof && !proof) throw shareNotFound();
    const filter = {
      _id: live.link._id,
      revokedAt: null,
      expiresAt: { $gt: now },
      ...(needsProof && proof
        ? { proofs: { $elemMatch: { hash: hashSecret(proof), expiresAt: { $gt: now } } } }
        : {}),
    } as QueryFilter<ShareLink>;
    const claimed = await this.links.updateOne(live.tenantId, filter, {
      $inc: { accessCount: 1 },
      $set: { lastAccessedAt: now },
    });
    if (!claimed) throw shareNotFound();
  }

  private async served(
    live: LiveShare,
    kind: 'view' | 'preview' | 'download',
    userAgent: unknown,
  ): Promise<void> {
    await this.audit.record(live.tenantId, {
      action: 'SHARE_LINK_ACCESSED',
      actor: null,
      resource: resourceOf(live.link, live.record),
      context: {
        linkId: idOf(live.link),
        outcome: 'served',
        kind,
        versionNumber: live.record.currentVersion,
        uaFamily: uaFamilyOf(userAgent),
      },
    });
  }

  private async reserveAttempt(live: LiveShare, now: Date): Promise<ShareLinkDocument | null> {
    const { link, tenantId } = live;
    const windowStart = new Date(now.getTime() - LOCK_WINDOW_MS);
    const inWindow = () =>
      this.links.updateOne(
        tenantId,
        {
          _id: link._id,
          $and: [
            notLocked(now),
            { failWindowStartedAt: { $gt: windowStart } },
            { failedCount: { $lt: LOCK_THRESHOLD } },
          ],
        },
        { $inc: { failedCount: 1 } },
      );
    const newWindow = () =>
      this.links.updateOne(
        tenantId,
        {
          _id: link._id,
          $and: [
            notLocked(now),
            {
              $or: [{ failWindowStartedAt: null }, { failWindowStartedAt: { $lte: windowStart } }],
            },
          ],
        },
        { $set: { failedCount: 1, failWindowStartedAt: now } },
      );
    return (await inWindow()) ?? (await newWindow()) ?? (await inWindow());
  }

  private async failed(live: LiveShare, reserved: ShareLinkDocument, now: Date): Promise<never> {
    const { link, tenantId } = live;
    let setLock = false;
    if (reserved.failedCount >= LOCK_THRESHOLD) {
      const lockedLink = await this.links.updateOne(
        tenantId,
        { _id: link._id, ...notLocked(now) },
        {
          $set: {
            lockedUntil: new Date(now.getTime() + LOCK_MS),
            failedCount: 0,
            failWindowStartedAt: null,
          },
        },
      );
      setLock = lockedLink !== null;
    }
    await this.audit.record(tenantId, {
      action: 'SHARE_LINK_PASSWORD_FAILED',
      actor: null,
      resource: resourceOf(link, live.record),
      context: {
        linkId: idOf(link),
        failuresInWindow: reserved.failedCount,
        locked: setLock,
      },
    });
    if (setLock) throw locked();
    throw errors.forbidden('Wrong password', 'SHARE_LINK_PASSWORD_INCORRECT');
  }
}
