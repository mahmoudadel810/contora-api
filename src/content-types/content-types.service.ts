import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import { AuditService } from '../audit/audit.service.js';
import { actorOf, type Principal } from '../auth/principal.js';
import { PolicyService } from '../authorization/policy.service.js';
import { errors } from '../common/errors.js';
import { toObjectId } from '../database/object-id.js';
import { RECORDS_COLLECTION } from '../records/record.schema.js';
import {
  nameKeyOf,
  toContentTypeView,
  type ContentTypeDocument,
  type ContentTypeView,
} from './content-type.schema.js';
import type { ContentTypeBody, ContentTypeListQuery } from './content-types.dto.js';
import { ContentTypesRepository } from './content-types.repository.js';

export const DELETE_MARK_MS = 30_000;

export function isBeingDeleted(type: ContentTypeDocument, now = new Date()): boolean {
  return (
    !!type.deleteToken &&
    !!type.deleteClaimedAt &&
    type.deleteClaimedAt.getTime() > now.getTime() - DELETE_MARK_MS
  );
}

export function deletingError() {
  return errors.conflict(
    'CONTENT_TYPE_DELETING',
    'This content type is being deleted; reload and try again',
  );
}

@Injectable()
export class ContentTypesService {
  constructor(
    private readonly repository: ContentTypesRepository,
    private readonly policy: PolicyService,
    private readonly audit: AuditService,
    @InjectConnection() private readonly connection: Connection,
  ) {}

  async list(principal: Principal, query: ContentTypeListQuery): Promise<ContentTypeView[]> {
    await this.policy.authorize(principal, 'contentTypes.read');
    const filter = query.status === 'all' ? {} : { status: query.status };
    const types = await this.repository.find(principal.tenantId, filter, { sort: { nameKey: 1 } });
    return types.map(toContentTypeView);
  }

  async get(principal: Principal, id: string): Promise<ContentTypeView> {
    await this.policy.authorize(principal, 'contentTypes.read');
    return toContentTypeView(await this.require(principal.tenantId, id));
  }

  async create(principal: Principal, body: ContentTypeBody): Promise<ContentTypeView> {
    await this.policy.authorize(principal, 'contentTypes.manage', {
      type: 'contentType',
      label: body.name,
    });
    await this.assertNameFree(principal.tenantId, body.name);
    const created = await this.repository.create(principal.tenantId, {
      name: body.name,
      nameKey: nameKeyOf(body.name),
      description: body.description,
      fields: body.fields,
      schemaVersion: 1,
      status: 'active',
      aiExtraction: body.aiExtraction ?? false,
      createdBy: toObjectId(principal.userId),
    });
    await this.audit.record(principal.tenantId, {
      action: 'CONTENT_TYPE_CREATED',
      actor: actorOf(principal),
      resource: { type: 'contentType', id: created.id, label: created.name },
      context: { fieldCount: created.fields.length },
    });
    return toContentTypeView(created);
  }

  async update(principal: Principal, id: string, body: ContentTypeBody): Promise<ContentTypeView> {
    await this.policy.authorize(principal, 'contentTypes.manage', { type: 'contentType', id });
    const existing = await this.require(principal.tenantId, id);
    if (nameKeyOf(body.name) !== existing.nameKey)
      await this.assertNameFree(principal.tenantId, body.name);
    const fieldsChanged = !isDeepStrictEqual(
      JSON.parse(JSON.stringify(existing.fields)),
      JSON.parse(JSON.stringify(body.fields)),
    );
    const aiExtractionChanged =
      body.aiExtraction !== undefined && body.aiExtraction !== (existing.aiExtraction === true);
    const updated = await this.repository.updateById(principal.tenantId, id, {
      name: body.name,
      nameKey: nameKeyOf(body.name),
      description: body.description,
      fields: body.fields,
      ...(body.aiExtraction === undefined ? {} : { aiExtraction: body.aiExtraction }),
      ...(fieldsChanged ? { $inc: { schemaVersion: 1 } } : {}),
    });
    if (!updated) throw errors.notFound('Content type');
    await this.audit.record(principal.tenantId, {
      action: 'CONTENT_TYPE_UPDATED',
      actor: actorOf(principal),
      resource: { type: 'contentType', id, label: updated.name },
      context: {
        fieldsChanged,
        schemaVersion: updated.schemaVersion,
        previousName: existing.name,
        ...(aiExtractionChanged ? { aiExtraction: updated.aiExtraction } : {}),
      },
    });
    return toContentTypeView(updated);
  }

  async setArchived(principal: Principal, id: string, archived: boolean): Promise<ContentTypeView> {
    await this.policy.authorize(principal, 'contentTypes.manage', { type: 'contentType', id });
    const updated = await this.repository.updateById(principal.tenantId, id, {
      status: archived ? 'archived' : 'active',
    });
    if (!updated) throw errors.notFound('Content type');
    await this.audit.record(principal.tenantId, {
      action: archived ? 'CONTENT_TYPE_ARCHIVED' : 'CONTENT_TYPE_UNARCHIVED',
      actor: actorOf(principal),
      resource: { type: 'contentType', id, label: updated.name },
    });
    return toContentTypeView(updated);
  }

  async delete(principal: Principal, id: string): Promise<void> {
    await this.policy.authorize(principal, 'contentTypes.manage', { type: 'contentType', id });
    const tenantId = principal.tenantId;
    const existing = await this.require(tenantId, id);
    const token = randomUUID();
    const now = new Date();
    const claimed = await this.repository.updateOne(
      tenantId,
      {
        _id: existing._id,
        $or: [
          { deleteToken: null },
          { deleteClaimedAt: { $lte: new Date(now.getTime() - DELETE_MARK_MS) } },
        ],
      },
      { deleteToken: token, deleteClaimedAt: now },
    );
    if (!claimed) {
      await this.require(tenantId, id);
      throw deletingError();
    }
    try {
      const inUse = await this.connection
        .collection(RECORDS_COLLECTION)
        .countDocuments({ tenantId: toObjectId(tenantId), contentTypeId: existing._id });
      if (inUse > 0) {
        throw errors.conflict(
          'CONTENT_TYPE_IN_USE',
          `This content type is used by ${inUse} record(s); archive it instead`,
        );
      }
      const deleted = await this.repository.deleteMany(tenantId, {
        _id: existing._id,
        deleteToken: token,
        deleteClaimedAt: { $gt: new Date(Date.now() - DELETE_MARK_MS) },
      });
      if (deleted === 0) throw deletingError();
    } catch (error) {
      await this.repository.updateOne(
        tenantId,
        { _id: existing._id, deleteToken: token },
        { deleteToken: null, deleteClaimedAt: null },
      );
      throw error;
    }
    await this.audit.record(tenantId, {
      action: 'CONTENT_TYPE_DELETED',
      actor: actorOf(principal),
      resource: { type: 'contentType', id, label: existing.name },
    });
  }

  async require(tenantId: string, id: string): Promise<ContentTypeDocument> {
    const type = await this.repository.findById(tenantId, id);
    if (!type) throw errors.notFound('Content type');
    return type;
  }

  private async assertNameFree(tenantId: string, name: string): Promise<void> {
    if (await this.repository.exists(tenantId, { nameKey: nameKeyOf(name) })) {
      throw errors.conflict('NAME_TAKEN', 'A content type with this name already exists');
    }
  }
}
