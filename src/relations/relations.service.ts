import { Injectable } from '@nestjs/common';
import type { Types } from 'mongoose';
import type { AccessScope } from '../access/access-scope.js';
import { AccessService } from '../access/access.service.js';
import { AuditService } from '../audit/audit.service.js';
import { actorOf, type Principal } from '../auth/principal.js';
import { PolicyService } from '../authorization/policy.service.js';
import { isDuplicateKey } from '../common/duplicate-key.js';
import { errors } from '../common/errors.js';
import { ContentTypesRepository } from '../content-types/content-types.repository.js';
import { isObjectId, toObjectId } from '../database/object-id.js';
import { FoldersService } from '../folders/folders.service.js';
import type { RecordDocument } from '../records/record.schema.js';
import { RecordsRepository } from '../records/records.repository.js';
import { RecordsService } from '../records/records.service.js';
import { labelFor, pairKeyOf, type RelationDirection } from './relation-kinds.js';
import type { RelationList, RelationView } from './relation.schema.js';
import type { AddRelationInput } from './relations.dto.js';
import { RelationsRepository, type JoinedRelation } from './relations.repository.js';

export const RELATION_LIMIT = 50;
export const RELATION_LIST_LIMIT = 200;

@Injectable()
export class RelationsService {
  constructor(
    private readonly repository: RelationsRepository,
    private readonly records: RecordsService,
    private readonly recordsRepository: RecordsRepository,
    private readonly folders: FoldersService,
    private readonly contentTypes: ContentTypesRepository,
    private readonly policy: PolicyService,
    private readonly audit: AuditService,
    private readonly access: AccessService,
  ) {}

  async list(principal: Principal, recordId: string): Promise<RelationList> {
    await this.policy.authorize(principal, 'records.read');
    const tenantId = principal.tenantId;
    const record = await this.records.requireVisible(principal, recordId);
    const scope = await this.access.scopeFor(principal);
    const { items, total } = await this.repository.listFor(
      tenantId,
      record._id,
      RELATION_LIST_LIMIT,
      scope.recordFilter('view'),
    );
    return { items: await this.hydrate(tenantId, record._id, items, scope), total };
  }

  async add(
    principal: Principal,
    recordId: string,
    input: AddRelationInput,
  ): Promise<RelationView> {
    await this.policy.authorize(principal, 'records.write', { type: 'record', id: recordId });
    if (input.otherId === recordId) {
      throw errors.badRequest('SELF_RELATION', 'A record cannot be related to itself');
    }
    const tenantId = principal.tenantId;
    const scope = await this.access.scopeFor(principal);
    const record = await this.records.requireVisible(principal, recordId);
    const other = await this.records.requireVisible(principal, input.otherId);
    const [source, target] = input.direction === 'outgoing' ? [record, other] : [other, record];
    await this.access.assertLevel(
      principal,
      { type: 'record', id: source.id as string, label: source.name },
      scope.levelOfRecord(source),
      'edit',
    );
    const outgoing = await this.repository.count(tenantId, { sourceId: source._id });
    if (outgoing >= RELATION_LIMIT) {
      throw errors.conflict(
        'RELATION_LIMIT',
        `"${source.name}" already has the maximum of ${RELATION_LIMIT} relations`,
      );
    }
    const created = await this.repository
      .create(tenantId, {
        sourceId: source._id,
        targetId: target._id,
        kind: input.kind,
        pairKey: pairKeyOf(source.id as string, target.id as string),
        createdBy: toObjectId(principal.userId),
        createdByName: principal.displayName,
      })
      .catch((error: unknown) => {
        if (isDuplicateKey(error)) {
          throw errors.conflict('RELATION_EXISTS', 'These records are already related this way');
        }
        throw error;
      });
    const endsLeft = await this.recordsRepository.count(tenantId, {
      _id: { $in: [source._id, target._id] },
      purgeToken: null,
    });
    if (endsLeft < 2) {
      await this.repository.deleteOne(tenantId, { _id: created._id });
      throw errors.notFound('Record');
    }
    await this.audit.record(tenantId, {
      action: 'RELATION_ADDED',
      actor: actorOf(principal),
      resource: { type: 'record', id: recordId, label: record.name },
      context: this.auditContext(created.id as string, input.kind, input.direction, other),
    });
    const joined: JoinedRelation = {
      _id: created._id,
      sourceId: created.sourceId,
      targetId: created.targetId,
      kind: created.kind,
      createdBy: created.createdBy,
      createdByName: created.createdByName,
      createdAt: created.createdAt,
      other: {
        _id: other._id,
        name: other.name,
        contentTypeId: other.contentTypeId,
        folderId: other.folderId,
      },
    };
    return (await this.hydrate(tenantId, record._id, [joined], scope))[0];
  }

  async remove(principal: Principal, recordId: string, relationId: string): Promise<void> {
    await this.policy.authorize(principal, 'records.write', { type: 'record', id: recordId });
    const tenantId = principal.tenantId;
    const scope = await this.access.scopeFor(principal);
    const record = await this.records.requireVisible(principal, recordId);
    if (!isObjectId(relationId)) throw errors.notFound('Relation');
    const filter = {
      _id: toObjectId(relationId),
      $or: [{ sourceId: record._id }, { targetId: record._id }],
    };
    const relation = await this.repository.findOne(tenantId, filter);
    if (!relation) throw errors.notFound('Relation');
    const outgoing = relation.sourceId.equals(record._id);
    const otherId = outgoing ? relation.targetId : relation.sourceId;
    const other = await this.recordsRepository.findOne(tenantId, {
      _id: otherId,
      deletedAt: null,
    });
    if (!other || scope.levelOfRecord(other) === null) throw errors.notFound('Relation');
    const source = outgoing ? record : other;
    await this.access.assertLevel(
      principal,
      { type: 'record', id: source.id as string, label: source.name },
      scope.levelOfRecord(source),
      'edit',
    );
    if (!(await this.repository.deleteOne(tenantId, filter))) throw errors.notFound('Relation');
    await this.audit.record(tenantId, {
      action: 'RELATION_REMOVED',
      actor: actorOf(principal),
      resource: { type: 'record', id: recordId, label: record.name },
      context: this.auditContext(
        relationId,
        relation.kind,
        outgoing ? 'outgoing' : 'incoming',
        other,
      ),
    });
  }

  async purgeForRecords(tenantId: string, recordIds: Types.ObjectId[]): Promise<number> {
    if (recordIds.length === 0) return 0;
    return this.repository.deleteMany(tenantId, {
      $or: [{ sourceId: { $in: recordIds } }, { targetId: { $in: recordIds } }],
    });
  }

  private auditContext(
    relationId: string,
    kind: JoinedRelation['kind'],
    direction: RelationDirection,
    other: RecordDocument,
  ): Record<string, unknown> {
    return {
      relationId,
      kind,
      direction,
      label: labelFor(kind, direction),
      otherId: other.id as string,
      otherName: other.name,
    };
  }

  private async hydrate(
    tenantId: string,
    viewedId: Types.ObjectId,
    rows: JoinedRelation[],
    scope: AccessScope,
  ): Promise<RelationView[]> {
    if (rows.length === 0) return [];
    const typeIds = [...new Set(rows.map((r) => r.other.contentTypeId.toHexString()))];
    const folderIds = [...new Set(rows.map((r) => r.other.folderId.toHexString()))];
    const [types, paths] = await Promise.all([
      this.contentTypes.find(tenantId, { _id: { $in: typeIds.map(toObjectId) } }),
      this.folders.pathsOf(tenantId, folderIds.map(toObjectId), scope),
    ]);
    const typeNames = new Map(types.map((t) => [t.id as string, t.name]));
    return rows.map((row) => {
      const direction: RelationDirection = row.sourceId.equals(viewedId) ? 'outgoing' : 'incoming';
      const folderId = row.other.folderId.toHexString();
      const folderVisible = scope.levelOfFolderId(row.other.folderId) !== null;
      return {
        id: row._id.toHexString(),
        kind: row.kind,
        direction,
        label: labelFor(row.kind, direction),
        other: {
          id: row.other._id.toHexString(),
          name: row.other.name,
          contentTypeName: typeNames.get(row.other.contentTypeId.toHexString()) ?? null,
          folderId: folderVisible ? folderId : null,
          folderPath: folderVisible ? (paths.get(folderId) ?? []) : [],
        },
        createdBy: { id: row.createdBy.toHexString(), displayName: row.createdByName },
        createdAt: row.createdAt.toISOString(),
      };
    });
  }
}
