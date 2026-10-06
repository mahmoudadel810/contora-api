import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, type QueryFilter, type Types } from 'mongoose';
import { AccessService } from '../access/access.service.js';
import { AuditService } from '../audit/audit.service.js';
import { actorOf, type Principal } from '../auth/principal.js';
import { can } from '../authorization/policy.js';
import { PolicyService } from '../authorization/policy.service.js';
import { AppError, errors } from '../common/errors.js';
import { APP_CONFIG, type AppConfig } from '../config/env.js';
import { TenantRepository } from '../database/tenant.repository.js';
import { isObjectId, toObjectId } from '../database/object-id.js';
import { DomainEvents } from '../events/domain-events.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { escapeRegex } from '../records/metadata.js';
import type { RecordDocument } from '../records/record.schema.js';
import { VersionsRepository } from '../records/records.repository.js';
import { RecordsService } from '../records/records.service.js';
import type { User, UserDocument } from '../users/user.schema.js';
import { UsersRepository } from '../users/users.repository.js';
import {
  RecordComment,
  toCommentView,
  type CommentView,
  type MentionedPerson,
  type RecordCommentDocument,
} from './comment.schema.js';
import { FORMER_USER, mentionIds, plainExcerpt } from './mention-tokens.js';

const EXCERPT = 80;
const SNIPPET = 120;
export const MAX_COMMENT_BODY = 4000;
const CANDIDATE_LIMIT = 20;
const CANDIDATE_OVERFETCH = 3;
const CANDIDATE_ROUNDS = 5;
const CANDIDATE_SORT = { displayName: 1 as const, _id: 1 as const };

@Injectable()
export class CommentsService {
  private readonly repository: TenantRepository<RecordComment>;

  constructor(
    @InjectModel(RecordComment.name) model: Model<RecordComment>,
    private readonly records: RecordsService,
    private readonly policy: PolicyService,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly users: UsersRepository,
    private readonly versions: VersionsRepository,
    private readonly notifications: NotificationsService,
    private readonly access: AccessService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    this.repository = new TenantRepository(model);
  }

  async list(principal: Principal, recordId: string): Promise<CommentView[]> {
    await this.policy.authorize(principal, 'records.read');
    const record = await this.records.requireVisible(principal, recordId);
    const comments = await this.repository.find(
      principal.tenantId,
      { recordId: record._id },
      { sort: { createdAt: 1, _id: 1 }, limit: 500 },
    );
    return this.viewsOf(principal.tenantId, comments);
  }

  async add(principal: Principal, recordId: string, body: string): Promise<CommentView> {
    await this.policy.authorize(principal, 'records.read', { type: 'record', id: recordId });
    const record = await this.records.requireVisible(principal, recordId);
    const text = this.checkedBody(body);
    const mentioned = await this.checkedMentions(principal, record, text);
    const names = this.plainNames(mentioned.people);
    const comment = await this.repository.create(principal.tenantId, {
      recordId: record._id,
      body: text,
      mentions: mentioned.ids.map((id) => ({ type: 'user' as const, id: toObjectId(id) })),
      authorId: toObjectId(principal.userId),
      authorName: principal.displayName,
    });
    const excerpt = plainExcerpt(text, names, EXCERPT);
    await this.audit.record(principal.tenantId, {
      action: 'COMMENT_ADDED',
      actor: actorOf(principal),
      resource: { type: 'record', id: recordId, label: record.name },
      context: { commentId: comment.id, excerpt, mentionCount: mentioned.ids.length },
    });
    await this.auditMentions(principal, record, comment._id.toHexString(), mentioned);
    await this.events.emit({
      type: 'comment.added',
      tenantId: principal.tenantId,
      actor: actorOf(principal),
      record: { id: recordId, name: record.name, createdBy: record.createdBy.toHexString() },
      excerpt,
      commentId: comment._id.toHexString(),
      mentionIds: mentioned.ids,
      snippet: plainExcerpt(text, names, SNIPPET),
    });
    await this.clearIfDeletedMeanwhile(principal.tenantId, recordId, comment);
    return toCommentView(comment, mentioned.people);
  }

  async remove(principal: Principal, recordId: string, commentId: string): Promise<void> {
    const record = await this.records.requireVisible(principal, recordId);
    const comment = isObjectId(commentId)
      ? await this.repository.findOne(principal.tenantId, {
          _id: toObjectId(commentId),
          recordId: record._id,
        })
      : null;
    if (!comment) throw errors.notFound('Comment');
    if (!comment.authorId.equals(principal.userId)) {
      await this.policy.authorize(principal, 'comments.moderate', {
        type: 'record',
        id: recordId,
        label: record.name,
      });
    }
    await this.repository.deleteById(principal.tenantId, commentId);
    const excerpt = await this.excerptOf(principal.tenantId, comment);
    await this.audit.record(principal.tenantId, {
      action: 'COMMENT_DELETED',
      actor: actorOf(principal),
      resource: { type: 'record', id: recordId, label: record.name },
      context: { commentId, author: comment.authorName, excerpt },
    });
    await this.notifications.clearBodyForComment(principal.tenantId, recordId, commentId);
  }

  async purgeForRecords(tenantId: string, recordIds: Types.ObjectId[]): Promise<number> {
    return this.repository.deleteMany(tenantId, { recordId: { $in: recordIds } });
  }

  async mentionableAmong(
    tenantId: string,
    record: RecordDocument,
    ids: readonly string[],
  ): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    return this.access.viewersOf(tenantId, record._id.toHexString(), ids);
  }

  async mentionCandidates(
    principal: Principal,
    recordId: string,
    q: string,
  ): Promise<{ items: MentionCandidate[] }> {
    await this.policy.authorize(principal, 'records.read');
    const record = await this.records.requireVisible(principal, recordId);
    const caller = toObjectId(principal.userId);
    const matching = this.candidateFilter(principal, q.trim());
    const collaborators = [...(await this.collaboratorIdsOf(principal.tenantId, record))]
      .filter((id) => id !== principal.userId)
      .map(toObjectId);
    const first = await this.viewingCandidates(
      principal.tenantId,
      record,
      { ...matching, _id: { $in: collaborators } },
      CANDIDATE_LIMIT,
    );
    const rest =
      first.length < CANDIDATE_LIMIT
        ? await this.viewingCandidates(
            principal.tenantId,
            record,
            { ...matching, _id: { $nin: [...collaborators, caller] } },
            CANDIDATE_LIMIT - first.length,
          )
        : [];
    return {
      items: [
        ...first.map((user) => candidateOf(user, true)),
        ...rest.map((user) => candidateOf(user, false)),
      ],
    };
  }

  private async viewingCandidates(
    tenantId: string,
    record: RecordDocument,
    filter: QueryFilter<User>,
    limit: number,
  ): Promise<UserDocument[]> {
    const found: UserDocument[] = [];
    let skip = 0;
    for (let round = 0; round < CANDIDATE_ROUNDS && found.length < limit; round += 1) {
      const batch = (limit - found.length) * CANDIDATE_OVERFETCH;
      const users = await this.users.find(tenantId, filter, {
        sort: CANDIDATE_SORT,
        skip,
        limit: batch,
      });
      skip += users.length;
      const viewers = await this.mentionableAmong(
        tenantId,
        record,
        users.map((user) => user._id.toHexString()),
      );
      found.push(...users.filter((user) => viewers.has(user._id.toHexString())));
      if (users.length < batch) break;
    }
    return found.slice(0, limit);
  }

  private candidateFilter(principal: Principal, q: string): QueryFilter<User> {
    const active: QueryFilter<User> = { status: 'active' };
    if (q === '') return active;
    const prefix = escapeRegex(q);
    const byName: QueryFilter<User> = {
      displayName: { $regex: `(^|\\s)${prefix}`, $options: 'i' },
    };
    const byEmail: QueryFilter<User> = { email: { $regex: `^${prefix}`, $options: 'i' } };
    return {
      ...active,
      $or: can(principal, 'members.read') ? [byName, byEmail] : [byName],
    };
  }

  private async collaboratorIdsOf(tenantId: string, record: RecordDocument): Promise<Set<string>> {
    const [versionAuthors, commenters] = await Promise.all([
      this.versions.distinct(tenantId, 'createdBy', { recordId: record._id }),
      this.repository.distinct(tenantId, 'authorId', { recordId: record._id }),
    ]);
    return new Set(
      [record.createdBy, ...versionAuthors, ...commenters].map((id) =>
        (id as Types.ObjectId).toHexString(),
      ),
    );
  }

  private checkedBody(body: string): string {
    const text = body.trim();
    if (text.length === 0 || text.length > MAX_COMMENT_BODY) {
      throw errors.validation([
        { path: 'body', message: `A comment has 1 to ${MAX_COMMENT_BODY} characters` },
      ]);
    }
    return text;
  }

  private async checkedMentions(
    principal: Principal,
    record: RecordDocument,
    text: string,
  ): Promise<Mentioned> {
    const ids = mentionIds(text);
    const max = this.config.COMMENT_MENTION_MAX_RECIPIENTS;
    if (ids.length > max) {
      throw new AppError(
        HttpStatus.BAD_REQUEST,
        'MENTION_LIMIT_EXCEEDED',
        `A comment can mention at most ${max} people`,
        { max },
      );
    }
    if (ids.includes(principal.userId)) {
      throw errors.badRequest('MENTION_SELF', 'You cannot mention yourself');
    }
    if (ids.length === 0) return { ids, people: new Map() };
    const mentionable = await this.mentionableAmong(principal.tenantId, record, ids);
    const refused = ids.filter((id) => !mentionable.has(id));
    if (refused.length > 0) {
      const members = await this.users.find(principal.tenantId, {
        _id: { $in: refused.map(toObjectId) },
      });
      const activeHere = new Set(
        members.filter((user) => user.status === 'active').map((user) => user._id.toHexString()),
      );
      throw new AppError(
        HttpStatus.BAD_REQUEST,
        'MENTION_NO_ACCESS',
        'Some of the people you mentioned cannot see this record',
        {
          mentions: refused.map((id) => ({
            id,
            reason: activeHere.has(id) ? 'no_access' : 'unavailable',
          })),
          canGrant: can(principal, 'access.manage'),
        },
      );
    }
    return { ids, people: await this.peopleById(principal.tenantId, ids) };
  }

  private async auditMentions(
    principal: Principal,
    record: RecordDocument,
    commentId: string,
    mentioned: Mentioned,
  ): Promise<void> {
    for (const recipientId of mentioned.ids) {
      await this.audit.record(principal.tenantId, {
        action: 'COMMENT_MENTIONED',
        actor: actorOf(principal),
        resource: { type: 'record', id: record._id.toHexString(), label: record.name },
        context: {
          commentId,
          recipientId,
          recipientName: mentioned.people.get(recipientId)?.displayName ?? FORMER_USER,
          versionId: null,
        },
      });
    }
  }

  private async clearIfDeletedMeanwhile(
    tenantId: string,
    recordId: string,
    comment: RecordCommentDocument,
  ): Promise<void> {
    if (await this.repository.exists(tenantId, { _id: comment._id })) return;
    await this.notifications.clearBodyForComment(tenantId, recordId, comment._id.toHexString());
  }

  private async excerptOf(tenantId: string, comment: RecordCommentDocument): Promise<string> {
    const ids = (comment.mentions ?? []).map((mention) => mention.id.toHexString());
    const people = await this.peopleById(tenantId, ids);
    return plainExcerpt(comment.body, this.plainNames(people), EXCERPT);
  }

  private async viewsOf(
    tenantId: string,
    comments: RecordCommentDocument[],
  ): Promise<CommentView[]> {
    const ids = comments.flatMap((comment) =>
      (comment.mentions ?? []).map((mention) => mention.id.toHexString()),
    );
    const people = await this.peopleById(tenantId, ids);
    return comments.map((comment) => toCommentView(comment, people));
  }

  private async peopleById(
    tenantId: string,
    ids: readonly string[],
  ): Promise<Map<string, MentionedPerson>> {
    const distinct = [...new Set(ids)];
    if (distinct.length === 0) return new Map();
    const users = await this.users.find(tenantId, { _id: { $in: distinct.map(toObjectId) } });
    return new Map(
      users.map((user) => [
        user._id.toHexString(),
        { displayName: user.displayName, status: user.status },
      ]),
    );
  }

  private plainNames(people: ReadonlyMap<string, MentionedPerson>): Map<string, string> {
    return new Map(
      [...people]
        .filter(([, person]) => person.status !== 'removed')
        .map(([id, person]) => [id, person.displayName]),
    );
  }
}

export interface MentionCandidate {
  id: string;
  displayName: string;
  collaborator: boolean;
}

interface Mentioned {
  ids: string[];
  people: Map<string, MentionedPerson>;
}

function candidateOf(user: UserDocument, collaborator: boolean): MentionCandidate {
  return { id: user._id.toHexString(), displayName: user.displayName, collaborator };
}
