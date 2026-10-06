import { Injectable } from '@nestjs/common';
import type { QueryFilter } from 'mongoose';
import { z } from 'zod';
import type { Actor, Principal } from '../auth/principal.js';
import { activityScope, can } from '../authorization/policy.js';
import {
  PageQuerySchema,
  skipOf,
  toPage,
  type Page,
  type PageQuery,
} from '../common/pagination.js';
import { idOf, isObjectId, toObjectId } from '../database/object-id.js';
import { ActionListSchema, resolveActions, type ActionFilterInput } from './audit-action-filter.js';
import { AUDIT_ACTIONS, type AuditAction } from './audit-action.js';
import { AuditEntriesRepository } from './audit-entries.repository.js';
import type { AuditEntry, AuditEntryDocument } from './audit-entry.schema.js';
import {
  namedIds,
  redactEntry,
  type FeedAccess,
  type FeedAccessResolver,
  type RedactionOptions,
} from './audit-view-redaction.js';
import { stripSecrets } from './strip-secrets.js';

const NOT_IN_FEEDS: readonly AuditAction[] = [
  'ACCESS_DENIED',
  'ACCESS_GRANTED',
  'ACCESS_REVOKED',
  'AI_ACTION_CONFIRMED',
];

export interface AuditResource {
  type: string;
  id?: string;
  label?: string;
}

export interface AuditInput {
  action: AuditAction;
  actor: Actor | null;
  resource?: AuditResource;
  context?: Record<string, unknown>;
}

export interface AuditEntryView {
  id: string;
  action: AuditAction;
  actor: (Omit<Actor, 'email'> & { email?: string }) | null;
  resource: AuditResource | null;
  context: Record<string, unknown>;
  createdAt: string;
}

export const AuditListQuerySchema = PageQuerySchema.extend({
  action: z.enum(AUDIT_ACTIONS).optional(),
  actions: ActionListSchema.optional(),
  excludeActions: ActionListSchema.optional(),
  actorId: z.string().optional(),
  resourceType: z.string().min(1).optional(),
  resourceId: z.string().min(1).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

export type AuditListQuery = z.infer<typeof AuditListQuerySchema>;

function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

function toView(entry: AuditEntryDocument): AuditEntryView {
  return {
    id: idOf(entry),
    action: entry.action,
    actor: entry.actor
      ? {
          id: entry.actor.id.toHexString(),
          email: entry.actor.email,
          displayName: entry.actor.displayName,
        }
      : null,
    resource: entry.resource
      ? compact({
          type: entry.resource.type,
          id: entry.resource.id,
          label: entry.resource.label,
        })
      : null,
    context: entry.context,
    createdAt: entry.createdAt.toISOString(),
  };
}

@Injectable()
export class AuditService {
  constructor(private readonly entries: AuditEntriesRepository) {}

  async record(tenantId: string, input: AuditInput): Promise<void> {
    await this.entries.create(tenantId, {
      action: input.action,
      actor: input.actor
        ? {
            id: toObjectId(input.actor.id),
            email: input.actor.email,
            displayName: input.actor.displayName,
          }
        : null,
      resource: input.resource ? compact({ ...input.resource }) : null,
      context: stripSecrets(input.context ?? {}),
    });
  }

  async list(viewer: Principal, query: AuditListQuery): Promise<Page<AuditEntryView>> {
    const actions = resolveActions(query);
    if (actions?.length === 0) return toPage([], 0, query);
    const filter = this.visibleTo(viewer, query.actorId);
    if (actions) filter.action = actions.length === 1 ? actions[0] : { $in: [...actions] };
    if (query.resourceType) filter['resource.type'] = query.resourceType;
    if (query.resourceId) filter['resource.id'] = query.resourceId;
    if (query.from || query.to) {
      filter.createdAt = {
        ...(query.from ? { $gte: query.from } : {}),
        ...(query.to ? { $lte: query.to } : {}),
      };
    }
    const [items, total] = await Promise.all([
      this.entries.find(viewer.tenantId, filter, {
        sort: { createdAt: -1, _id: -1 },
        skip: skipOf(query),
        limit: query.pageSize,
      }),
      this.entries.count(viewer.tenantId, filter),
    ]);
    const redaction = this.redactionFor(viewer);
    return toPage(
      items.map((entry) => redactEntry(toView(entry), redaction)),
      total,
      query,
    );
  }

  async latest(
    viewer: Principal,
    options: ActionFilterInput & { limit: number },
    access: FeedAccessResolver | null = null,
  ): Promise<AuditEntryView[]> {
    const actions = resolveActions(options);
    if (actions?.length === 0) return [];
    const filter = this.visibleTo(viewer);
    if (actions) filter.action = { $in: [...actions] };
    const items = await this.entries.find(viewer.tenantId, filter, {
      sort: { createdAt: -1, _id: -1 },
      limit: options.limit,
    });
    const redaction = this.redactionFor(viewer);
    const views = items.map(toView);
    const named = await resolveAccess(access, views);
    return views.map((view) => redactEntry(view, { ...redaction, access: named }));
  }

  async forResource(
    tenantId: string,
    resource: { type: string; id: string },
    query: PageQuery,
    access: FeedAccessResolver | null = null,
  ): Promise<Page<AuditEntryView>> {
    const about = {
      'resource.type': resource.type,
      'resource.id': resource.id,
    };
    const filter: QueryFilter<AuditEntry> = { ...about, action: { $nin: [...NOT_IN_FEEDS] } };
    const [items, total] = await Promise.all([
      this.entries.find(tenantId, filter, {
        sort: { createdAt: -1, _id: -1 },
        skip: skipOf(query),
        limit: query.pageSize,
      }),
      this.entries.count(tenantId, filter),
    ]);
    const addedIds = items
      .filter((entry) => entry.action === 'COMMENT_ADDED')
      .map((entry) => String(entry.context.commentId));
    const deletedCommentIds = new Set(
      addedIds.length === 0
        ? []
        : (
            await this.entries.distinct(tenantId, 'context.commentId', {
              ...about,
              action: 'COMMENT_DELETED',
              'context.commentId': { $in: addedIds },
            })
          ).map(String),
    );
    const views = items.map(toView);
    const named = await resolveAccess(access, views);
    return toPage(
      views.map((view) => redactEntry(view, { feed: { deletedCommentIds }, access: named })),
      total,
      query,
    );
  }

  countSince(tenantId: string, action: AuditAction, since: Date): Promise<number> {
    return this.entries.count(tenantId, { action, createdAt: { $gte: since } });
  }

  private redactionFor(viewer: Principal): RedactionOptions {
    return { showsSignInFailureReason: can(viewer, 'audit.readAll') };
  }

  private visibleTo(viewer: Principal, requestedActorId?: string): QueryFilter<AuditEntry> {
    const filter: QueryFilter<AuditEntry> = {};
    const actorId = activityScope(viewer) === 'tenant' ? requestedActorId : viewer.userId;
    if (actorId) filter['actor.id'] = isObjectId(actorId) ? toObjectId(actorId) : null;
    return filter;
  }
}

export type AuditActivityPage = Page<AuditEntryView>;

async function resolveAccess(
  access: FeedAccessResolver | null,
  views: readonly AuditEntryView[],
): Promise<FeedAccess | undefined> {
  return access ? access(namedIds(views)) : undefined;
}
