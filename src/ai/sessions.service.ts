import { Injectable } from '@nestjs/common';
import type { Principal } from '../auth/principal.js';
import { can } from '../authorization/policy.js';
import { errors } from '../common/errors.js';
import { toPage, skipOf, type Page } from '../common/pagination.js';
import { ContentTypesService } from '../content-types/content-types.service.js';
import { isObjectId, toObjectId } from '../database/object-id.js';
import { AccessService } from '../access/access.service.js';
import {
  reducedActionView,
  reducedPreview,
  targetsVisible,
  toActionView,
  type ActionView,
} from './actions/action-view.js';
import type { AiPendingActionDocument } from './data/ai-pending-action.schema.js';
import { AiAuditTrail } from './ai-audit-trail.js';
import type { RenameSessionInput, SessionsQuery } from './ai.dto.js';
import { blockView, type Block, type StoredBlock } from './blocks.js';
import {
  AiActionsRepository,
  AiMessagesRepository,
  AiSessionsRepository,
} from './data/ai-data.repositories.js';
import type { AiMessageDocument } from './data/ai-message.schema.js';
import type { AiSessionDocument } from './data/ai-session.schema.js';
import type { Owner } from './data/ai-owned.repository.js';

export interface SessionView {
  id: string;
  title: string;
  messageCount: number;
  lastMessageAt: string;
  createdAt: string;
}

export interface MessageView {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  blocks: Block[];
  toolTrace: Array<{ domain: string; tool: string; ok: boolean; code: string | null }>;
  status: 'complete' | 'stopped' | 'error';
  errorCode: string | null;
  createdAt: string;
}

export interface SessionDetailView {
  session: SessionView;
  messages: MessageView[];
  actions: ActionView[];
}

export const SESSION_MESSAGES_SHOWN = 200;
const LOOKUP_CONCURRENCY = 8;
export const MAX_RECHECKED = 200;

export const ownerOf = (principal: Principal): Owner => ({
  tenantId: principal.tenantId,
  userId: principal.userId,
});

export function toSessionView(session: AiSessionDocument): SessionView {
  return {
    id: session._id.toHexString(),
    title: session.title,
    messageCount: session.messageCount,
    lastMessageAt: session.lastMessageAt.toISOString(),
    createdAt: session.createdAt.toISOString(),
  };
}

async function whichOf(
  ids: string[],
  check: (id: string) => Promise<boolean>,
): Promise<Set<string>> {
  const visible = new Set<string>();
  for (let start = 0; start < ids.length; start += LOOKUP_CONCURRENCY) {
    const batch = ids.slice(start, start + LOOKUP_CONCURRENCY);
    const results = await Promise.all(batch.map((id) => check(id).catch(() => false)));
    batch.forEach((id, index) => {
      if (results[index]) visible.add(id);
    });
  }
  return visible;
}

interface Visibility {
  records: Set<string>;
  folders: Set<string>;
  contentTypes: Set<string>;
  admin: boolean;
  hiddenActions: Set<string>;
  actionStatus: Map<string, string>;
}

const UNAVAILABLE = 'This item is no longer available';

function withFolderName<T extends { id: string; folderName: string | null }>(
  card: T,
  scope: StoredBlock['scope'],
  visible: Visibility,
): T {
  const folderId = scope?.cardFolders?.[card.id];
  return folderId !== undefined && !visible.folders.has(folderId)
    ? { ...card, folderName: null }
    : card;
}

function refiltered(block: StoredBlock, visible: Visibility): Block | null {
  const gone = (): Block => ({ kind: 'notice', id: block.id, tone: 'info', text: UNAVAILABLE });
  const scope = block.scope;
  if (scope?.domain === 'admin' && !visible.admin) return null;
  if (scope?.derived && !visible.admin) return gone();
  if (scope?.recordId && !visible.records.has(scope.recordId)) return gone();
  if (scope?.folderId && !visible.folders.has(scope.folderId)) return gone();
  if (block.kind !== 'confirm' && !targetsVisible(scope?.targets, visible)) return gone();
  switch (block.kind) {
    case 'record':
      return visible.records.has(block.record.id)
        ? {
            ...(blockView(block) as typeof block),
            record: withFolderName(block.record, scope, visible),
          }
        : gone();
    case 'file':
      return visible.records.has(block.recordId) ? blockView(block) : gone();
    case 'records': {
      const items = block.items
        .filter((item) => visible.records.has(item.id))
        .map((item) => withFolderName(item, scope, visible));
      if (items.length === 0) return gone();
      return {
        ...(blockView(block) as typeof block),
        items,
        total: items.length === block.items.length ? block.total : items.length,
      };
    }
    case 'folders': {
      const items = block.items.filter((item) => visible.folders.has(item.id));
      if (items.length === block.items.length) return blockView(block);
      return items.length === 0 ? gone() : { ...(blockView(block) as typeof block), items };
    }
    case 'contentType':
      return visible.contentTypes.has(block.contentType.id) ? blockView(block) : gone();
    case 'confirm': {
      if ('unavailable' in block) return blockView(block);
      const hidden =
        visible.hiddenActions.has(block.actionId) || !targetsVisible(scope?.targets, visible);
      if (!hidden) return blockView(block);
      const status = visible.actionStatus.get(block.actionId) ?? 'cancelled';
      return reducedPreview(blockView(block) as unknown as Record<string, unknown>, status);
    }
    case 'plan':
      return {
        ...(blockView(block) as typeof block),
        steps: block.steps.map((step) =>
          visible.hiddenActions.has(step.actionId) ? { ...step, title: UNAVAILABLE } : step,
        ),
      };
    default:
      return blockView(block);
  }
}

@Injectable()
export class SessionsService {
  constructor(
    private readonly sessions: AiSessionsRepository,
    private readonly messages: AiMessagesRepository,
    private readonly actions: AiActionsRepository,
    private readonly access: AccessService,
    private readonly contentTypes: ContentTypesService,
    private readonly trail: AiAuditTrail,
  ) {}

  async list(principal: Principal, query: SessionsQuery): Promise<Page<SessionView>> {
    const owner = ownerOf(principal);
    const [items, total] = await Promise.all([
      this.sessions.find(
        owner,
        {},
        { sort: { lastMessageAt: -1, _id: -1 }, skip: skipOf(query), limit: query.pageSize },
      ),
      this.sessions.count(owner, {}),
    ]);
    return toPage(items.map(toSessionView), total, query);
  }

  async require(principal: Principal, id: string): Promise<AiSessionDocument> {
    const session = await this.sessions.findById(ownerOf(principal), id);
    if (!session) throw errors.notFound('Session');
    return session;
  }

  async get(principal: Principal, id: string): Promise<SessionDetailView> {
    const owner = ownerOf(principal);
    const session = await this.require(principal, id);
    const recent = await this.messages.find(
      owner,
      { sessionId: session._id, regenerated: false },
      { sort: { createdAt: -1, _id: -1 }, limit: SESSION_MESSAGES_SHOWN },
    );
    const messages = recent.reverse();
    const actions = await this.actions.find(
      owner,
      { sessionId: session._id, messageId: { $in: messages.map((message) => message._id) } },
      { sort: { createdAt: 1, _id: 1 } },
    );
    const visible = await this.visibility(principal, messages, actions);
    return {
      session: toSessionView(session),
      messages: messages.map((message) => this.messageView(message, visible)),
      actions: actions.map((action) => {
        const view = toActionView(action);
        return visible.hiddenActions.has(view.id) ? reducedActionView(view) : view;
      }),
    };
  }

  async rename(principal: Principal, id: string, input: RenameSessionInput): Promise<SessionView> {
    const session = isObjectId(id)
      ? await this.sessions.updateOne(
          ownerOf(principal),
          { _id: toObjectId(id) },
          { $set: { title: input.title } },
        )
      : null;
    if (!session) throw errors.notFound('Session');
    return toSessionView(session);
  }

  async remove(principal: Principal, id: string): Promise<void> {
    const owner = ownerOf(principal);
    const session = await this.require(principal, id);
    await this.actions.deleteMany(owner, { sessionId: session._id });
    await this.messages.deleteMany(owner, { sessionId: session._id });
    await this.sessions.deleteMany(owner, { _id: session._id });
    await this.trail.record(owner, session.id as string, {
      kind: 'session_deleted',
      outcome: 'ok',
      argsSummary: { messageCount: session.messageCount },
    });
  }

  private messageView(message: AiMessageDocument, visible: Visibility): MessageView {
    const blocks = (message.blocks as unknown as StoredBlock[])
      .map((block) => refiltered(block, visible))
      .filter((block): block is Block => block !== null);
    return {
      id: message._id.toHexString(),
      role: message.role,
      text: message.text,
      blocks,
      toolTrace: message.toolTrace.map(({ domain, tool, ok, code }) => ({
        domain,
        tool,
        ok,
        code,
      })),
      status: message.status,
      errorCode: message.errorCode,
      createdAt: message.createdAt.toISOString(),
    };
  }

  private async visibility(
    principal: Principal,
    messages: AiMessageDocument[],
    actions: AiPendingActionDocument[] = [],
  ): Promise<Visibility> {
    const recordIds = new Set<string>();
    const folderIds = new Set<string>();
    const addRecord = (id: string) => {
      if (recordIds.size < MAX_RECHECKED) recordIds.add(id);
    };
    const addFolder = (id: string) => {
      if (folderIds.size < MAX_RECHECKED) folderIds.add(id);
    };
    let hasContentTypes = false;
    for (const action of [...actions].reverse()) {
      action.targets.records.forEach(addRecord);
      action.targets.folders.forEach(addFolder);
    }
    for (const message of [...messages].reverse()) {
      for (const block of message.blocks as unknown as StoredBlock[]) {
        if (block.scope?.recordId) addRecord(block.scope.recordId);
        if (block.scope?.folderId) addFolder(block.scope.folderId);
        Object.values(block.scope?.cardFolders ?? {}).forEach(addFolder);
        block.scope?.targets?.records.forEach(addRecord);
        block.scope?.targets?.folders.forEach(addFolder);
        if (block.kind === 'record') addRecord(block.record.id);
        if (block.kind === 'file') addRecord(block.recordId);
        if (block.kind === 'records') block.items.forEach((item) => addRecord(item.id));
        if (block.kind === 'folders') block.items.forEach((item) => addFolder(item.id));
        if (block.kind === 'contentType') hasContentTypes = true;
      }
    }
    const [records, folders, contentTypes] = await Promise.all([
      whichOf([...recordIds], async (id) =>
        Boolean(await this.access.requireRecord(principal, id, 'view')),
      ),
      whichOf([...folderIds], async (id) =>
        Boolean(await this.access.requireFolder(principal, id, 'view')),
      ),
      hasContentTypes
        ? this.contentTypes
            .list(principal, { status: 'all' })
            .then((types) => new Set(types.map((type) => type.id)))
            .catch(() => new Set<string>())
        : Promise.resolve(new Set<string>()),
    ]);
    const seen = { records, folders };
    const admin = can(principal, 'admin.overview');
    const hiddenActions = new Set(
      actions
        .filter(
          (action) =>
            (action.domain === 'admin' && !admin) || !targetsVisible(action.targets, seen),
        )
        .map((action) => action._id.toHexString()),
    );
    const actionStatus = new Map(
      actions.map((action) => [action._id.toHexString(), toActionView(action).status]),
    );
    return {
      records,
      folders,
      contentTypes,
      admin,
      hiddenActions,
      actionStatus,
    };
  }
}
