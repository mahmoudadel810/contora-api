import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, type QueryFilter, type Types } from 'mongoose';
import { AccessService } from '../access/access.service.js';
import type { Principal } from '../auth/principal.js';
import { PolicyService } from '../authorization/policy.service.js';
import { errors } from '../common/errors.js';
import { TenantRepository } from '../database/tenant.repository.js';
import { isObjectId, toObjectId } from '../database/object-id.js';
import { DomainEvents, type DomainEvent } from '../events/domain-events.js';
import { MyRecordsService } from '../my-records/my-records.service.js';
import { UsersRepository } from '../users/users.repository.js';
import {
  Notification,
  toNotificationView,
  type NotificationDocument,
  type NotificationKind,
  type NotificationView,
} from './notification.schema.js';
import { NotificationHub } from './notification-hub.js';

const LIST_LIMIT = 50;

interface Draft {
  kind: NotificationKind;
  title: string;
  body?: string;
  recordId?: string;
  commentId?: string;
}

export interface NotificationList {
  items: NotificationView[];
  unread: number;
}

@Injectable()
export class NotificationsService implements OnModuleInit {
  private readonly logger = new Logger('Notifications');
  private readonly repository: TenantRepository<Notification>;

  constructor(
    @InjectModel(Notification.name) model: Model<Notification>,
    private readonly events: DomainEvents,
    private readonly myRecords: MyRecordsService,
    private readonly policy: PolicyService,
    private readonly users: UsersRepository,
    private readonly access: AccessService,
    private readonly hub: NotificationHub,
  ) {
    this.repository = new TenantRepository(model);
  }

  onModuleInit(): void {
    this.events.subscribe((event) => this.handle(event));
  }

  async list(principal: Principal, unreadOnly: boolean): Promise<NotificationList> {
    await this.policy.authorize(principal, 'records.read');
    const mine = { userId: toObjectId(principal.userId) };
    const shown = await this.shownTo(principal, unreadOnly ? { ...mine, readAt: null } : mine);
    const [items, unread] = await Promise.all([
      this.repository.find(principal.tenantId, shown, {
        sort: { createdAt: -1, _id: -1 },
        limit: LIST_LIMIT,
      }),
      this.unreadCount(principal),
    ]);
    return { items: items.map(toNotificationView), unread };
  }

  async unreadCount(principal: Principal): Promise<number> {
    await this.policy.authorize(principal, 'records.read');
    const unread = { userId: toObjectId(principal.userId), readAt: null };
    return this.repository.count(principal.tenantId, await this.shownTo(principal, unread));
  }

  private async shownTo(
    principal: Principal,
    filter: QueryFilter<Notification>,
  ): Promise<QueryFilter<Notification>> {
    if ((await this.access.scopeFor(principal)).unrestricted) return filter;
    const recordIds = (await this.repository.distinct(principal.tenantId, 'recordId', {
      ...filter,
      recordId: { $ne: null },
    })) as Types.ObjectId[];
    const visible = await this.access.visibleRecordIds(principal, recordIds);
    return {
      $and: [
        filter,
        { $or: [{ recordId: null }, { recordId: { $in: [...visible].map(toObjectId) } }] },
      ],
    };
  }

  async markRead(principal: Principal, id: string): Promise<void> {
    await this.policy.authorize(principal, 'records.read');
    const filter = { userId: toObjectId(principal.userId) };
    const found = isObjectId(id)
      ? await this.repository.findOne(principal.tenantId, { ...filter, _id: toObjectId(id) })
      : null;
    if (!found) throw errors.notFound('Notification');
    await this.repository.updateOne(
      principal.tenantId,
      { ...filter, _id: found._id, readAt: null },
      { readAt: new Date() },
    );
    await this.publishUnread(principal);
  }

  async markAllRead(principal: Principal): Promise<void> {
    await this.policy.authorize(principal, 'records.read');
    await this.repository.updateMany(
      principal.tenantId,
      { userId: toObjectId(principal.userId), readAt: null },
      { readAt: new Date() },
    );
    await this.publishUnread(principal);
  }

  private async handle(event: DomainEvent): Promise<void> {
    switch (event.type) {
      case 'comment.added': {
        const followers = await this.myRecords.favoritedBy(event.tenantId, event.record.id);
        const mentioned = new Set(event.mentionIds);
        const watchers = [event.record.createdBy, ...followers].filter((id) => !mentioned.has(id));
        await this.send(event, watchers, {
          kind: 'COMMENT_ON_RECORD',
          title: `${event.actor.displayName} commented on "${event.record.name}"`,
          body: event.excerpt,
          recordId: event.record.id,
          commentId: event.commentId,
        });
        await this.send(event, event.mentionIds, {
          kind: 'MENTION',
          title: `${event.actor.displayName} mentioned you on "${event.record.name}"`,
          body: event.snippet,
          recordId: event.record.id,
          commentId: event.commentId,
        });
        return;
      }
      case 'version.created': {
        const followers = await this.myRecords.favoritedBy(event.tenantId, event.record.id);
        await this.send(event, followers, {
          kind: 'NEW_VERSION_OF_FAVORITE',
          title: `"${event.record.name}" has a new version (v${event.versionNumber})`,
          recordId: event.record.id,
        });
        return;
      }
      case 'checkout.forceReleased':
        await this.send(
          event,
          [event.holderId],
          {
            kind: 'CHECKOUT_FORCE_RELEASED',
            title: `${event.actor.displayName} released your check-out of "${event.record.name}"`,
            body: 'Changes you had not uploaded as a new version are not in the record.',
            recordId: event.record.id,
          },
          {
            kind: 'CHECKOUT_FORCE_RELEASED',
            title: 'An admin released your check-out',
            body: 'Changes you had not uploaded as a new version are not in the record.',
          },
        );
        return;
      case 'member.roleChanged':
        await this.send(event, [event.userId], {
          kind: 'ROLE_CHANGED',
          title: `${event.actor.displayName} changed your role to ${event.role}`,
        });
        return;
    }
  }

  async clearForUser(tenantId: string, userId: string): Promise<void> {
    await this.repository.deleteMany(tenantId, { userId: toObjectId(userId) });
  }

  async purgeForRecords(tenantId: string, recordIds: Types.ObjectId[]): Promise<void> {
    await this.repository.deleteMany(tenantId, { recordId: { $in: recordIds } });
  }

  private async send(
    event: { tenantId: string; actor: { id: string; displayName: string } },
    recipients: string[],
    draft: Draft,
    blind?: Draft,
  ): Promise<void> {
    const candidates = [...new Set(recipients)].filter((id) => id !== event.actor.id);
    if (candidates.length === 0) return;
    const active = await this.users.find(event.tenantId, {
      _id: { $in: candidates.map(toObjectId) },
      status: 'active',
    });
    const viewers = draft.recordId
      ? await this.access.viewersOf(event.tenantId, draft.recordId, candidates)
      : null;
    for (const userId of active.map((user) => user.id as string)) {
      const shown = viewers === null || viewers.has(userId) ? draft : blind;
      if (shown) await this.create(event, userId, shown);
    }
  }

  private async create(
    event: { tenantId: string; actor: { id: string; displayName: string } },
    userId: string,
    draft: Draft,
  ): Promise<void> {
    const row = await this.repository.create(event.tenantId, {
      userId: toObjectId(userId),
      kind: draft.kind,
      title: draft.title.slice(0, 300),
      body: (draft.body ?? '').slice(0, 300),
      recordId: draft.recordId ? toObjectId(draft.recordId) : null,
      commentId: draft.commentId ? toObjectId(draft.commentId) : null,
      actorId: toObjectId(event.actor.id),
      actorName: event.actor.displayName,
      readAt: null,
    });
    await this.publishCreated(event.tenantId, row);
  }

  async clearBodyForComment(
    tenantId: string,
    recordId: string,
    commentId: string,
  ): Promise<string[]> {
    if (!isObjectId(recordId) || !isObjectId(commentId)) return [];
    const about = { recordId: toObjectId(recordId), commentId: toObjectId(commentId) };
    const owners = (
      (await this.repository.distinct(tenantId, 'userId', about)) as Types.ObjectId[]
    ).map((id) => id.toHexString());
    if (owners.length === 0) return [];
    await this.repository.updateMany(tenantId, about, { body: '' });
    for (const userId of owners) this.hub.publish(tenantId, userId, 'cleared', { commentId });
    return owners;
  }

  private async publishCreated(tenantId: string, row: NotificationDocument): Promise<void> {
    const userId = row.userId.toHexString();
    if (!this.hub.isListening(tenantId, userId)) return;
    try {
      const user = await this.users.findById(tenantId, userId);
      if (!user || user.status !== 'active') return;
      const unread = await this.unreadCount({
        userId,
        tenantId,
        role: user.role,
        email: user.email,
        displayName: user.displayName,
      });
      this.hub.publish(tenantId, userId, 'notification', { item: toNotificationView(row), unread });
    } catch (error) {
      this.logger.warn(`Could not push a notification: ${messageOf(error)}`);
    }
  }

  private async publishUnread(principal: Principal): Promise<void> {
    if (!this.hub.isListening(principal.tenantId, principal.userId)) return;
    try {
      const unread = await this.unreadCount(principal);
      this.hub.publish(principal.tenantId, principal.userId, 'unread', { unread });
    } catch (error) {
      this.logger.warn(`Could not push the unread count: ${messageOf(error)}`);
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
