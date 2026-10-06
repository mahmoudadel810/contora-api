import { HttpStatus } from '@nestjs/common';
import { z } from 'zod';
import type { Principal } from '../../auth/principal.js';
import { AppError, errors } from '../../common/errors.js';
import { parseWith } from '../../common/zod.pipe.js';
import { labelFor, RELATION_KINDS } from '../../relations/relation-kinds.js';
import { AddRelationSchema } from '../../relations/relations.dto.js';
import { recordLink } from '../links.js';
import {
  defineProposal,
  nothingToChange,
  type CheckContext,
  type ExecuteContext,
  type Proposal,
} from './proposal.js';
import { objectId } from './search.tools.js';

export const CommentBodySchema = z.object({ body: z.string().trim().min(1).max(2000) }).strict();

const recordResult = (id: string, name: string) => ({
  resourceType: 'record',
  id,
  name,
  link: recordLink(id),
});

function recordAt(ctx: CheckContext | ExecuteContext, id: string, min: 'view' | 'edit') {
  return ctx.services.access.requireRecord(ctx.principal, id, min);
}

function notOwnComment(): AppError {
  return new AppError(
    HttpStatus.FORBIDDEN,
    'COMMENT_NOT_OWN',
    'The assistant can delete only your own comments',
  );
}

async function ownComment(
  ctx: CheckContext | ExecuteContext,
  principal: Principal,
  recordId: string,
  commentId: string,
) {
  const comments = await ctx.services.comments.list(principal, recordId);
  const comment = comments.find((candidate) => candidate.id === commentId);
  if (!comment) throw errors.notFound('Comment');
  if (comment.author.id !== principal.userId) throw notOwnComment();
  return comment;
}

const excerpt = (text: string) => (text.length > 200 ? `${text.slice(0, 199)}…` : text);

export const collabProposeComment = defineProposal({
  tool: 'collab_propose_comment',
  domain: 'collab',
  confirmLabel: 'create',
  description: 'Prepare a comment on a record, in the user’s name, with the exact text to post.',
  input: z.object({ recordId: objectId, body: z.string().min(1).max(2000) }).strict(),
  stored: z.object({ recordId: objectId, body: z.string().trim().min(1).max(2000) }).strict(),
  async check(ctx, input) {
    const record = await recordAt(ctx, input.recordId, 'view');
    const { body } = parseWith(CommentBodySchema, { body: input.body });
    return {
      args: { recordId: input.recordId, body },
      base: null,
      title: `Comment on “${record.name}”`,
      summary: 'Posted in your name',
      changes: [{ label: 'Comment', before: null, after: body }],
      targets: { records: [input.recordId], folders: [] },
      refs: [],
      destructive: false,
      reviewEach: false,
      needsFile: false,
    };
  },
  async execute(ctx, args) {
    const record = await recordAt(ctx, args.recordId, 'view');
    const { body } = parseWith(CommentBodySchema, { body: args.body });
    await ctx.services.comments.add(ctx.principal, args.recordId, body);
    return {
      status: 'done',
      result: recordResult(args.recordId, record.name),
      resource: { type: 'record', id: args.recordId, label: record.name },
      note: `✓ Commented on “${record.name}”`,
    };
  },
});

export const collabProposeDeleteComment = defineProposal({
  tool: 'collab_propose_delete_comment',
  domain: 'collab',
  confirmLabel: 'delete',
  description:
    'Prepare deleting one of the user’s own comments (never someone else’s). The user must confirm it explicitly.',
  input: z.object({ recordId: objectId, commentId: objectId }).strict(),
  stored: z.object({ recordId: objectId, commentId: objectId }).strict(),
  async check(ctx, input) {
    const record = await recordAt(ctx, input.recordId, 'view');
    const comment = await ownComment(ctx, ctx.principal, input.recordId, input.commentId);
    return {
      args: { recordId: input.recordId, commentId: input.commentId },
      base: null,
      title: `Delete your comment on “${record.name}”`,
      summary: 'The comment is deleted for everyone',
      changes: [{ label: 'Comment', before: excerpt(comment.body), after: null }],
      targets: { records: [input.recordId], folders: [] },
      refs: [],
      destructive: true,
      reviewEach: false,
      needsFile: false,
    };
  },
  async execute(ctx, args) {
    const record = await recordAt(ctx, args.recordId, 'view');
    await ownComment(ctx, ctx.principal, args.recordId, args.commentId);
    await ctx.services.comments.remove(ctx.principal, args.recordId, args.commentId);
    return {
      status: 'done',
      result: recordResult(args.recordId, record.name),
      resource: { type: 'record', id: args.recordId, label: record.name },
      note: `✓ Deleted your comment on “${record.name}”`,
      auditContext: { commentId: args.commentId },
    };
  },
});

const RelationStored = z
  .object({
    recordId: objectId,
    otherId: objectId,
    kind: z.enum(RELATION_KINDS),
    direction: z.enum(['outgoing', 'incoming']),
  })
  .strict();

export const collabProposeRelation = defineProposal({
  tool: 'collab_propose_relation',
  domain: 'collab',
  confirmLabel: 'create',
  description:
    'Prepare a relation between two records: kind relatedTo, references, supersedes or partOf; direction outgoing (recordId → otherId) or incoming (otherId → recordId). The user confirms each relation.',
  input: z
    .object({
      recordId: objectId,
      otherId: objectId,
      kind: z.enum(RELATION_KINDS),
      direction: z.enum(['outgoing', 'incoming']).nullable(),
    })
    .strict(),
  stored: RelationStored,
  async check(ctx, input) {
    const record = await recordAt(ctx, input.recordId, 'edit');
    const other = await recordAt(ctx, input.otherId, 'view');
    const parsed = parseWith(AddRelationSchema, {
      kind: input.kind,
      otherId: input.otherId,
      direction: input.direction ?? 'outgoing',
    });
    if (input.otherId === input.recordId) {
      throw errors.badRequest('SELF_RELATION', 'A record cannot be related to itself');
    }
    const label = labelFor(parsed.kind, parsed.direction);
    return {
      args: {
        recordId: input.recordId,
        otherId: input.otherId,
        kind: parsed.kind,
        direction: parsed.direction,
      },
      base: null,
      title: `Relate “${record.name}” to “${other.name}”`,
      summary: `${record.name} — ${label} — ${other.name}`,
      changes: [{ label, before: null, after: other.name }],
      targets: { records: [input.recordId, input.otherId], folders: [] },
      refs: [],
      destructive: false,
      reviewEach: true,
      needsFile: false,
    };
  },
  async execute(ctx, args) {
    const record = await recordAt(ctx, args.recordId, 'edit');
    await recordAt(ctx, args.otherId, 'view');
    await ctx.services.relations.add(
      ctx.principal,
      args.recordId,
      parseWith(AddRelationSchema, {
        kind: args.kind,
        otherId: args.otherId,
        direction: args.direction,
      }),
    );
    return {
      status: 'done',
      result: recordResult(args.recordId, record.name),
      resource: { type: 'record', id: args.recordId, label: record.name },
      note: `✓ Related “${record.name}”`,
    };
  },
});

export const collabProposeRemoveRelation = defineProposal({
  tool: 'collab_propose_remove_relation',
  domain: 'collab',
  confirmLabel: 'remove',
  description:
    'Prepare removing one relation of a record (by the relation id from collab_list_relations). The user must confirm it explicitly.',
  input: z.object({ recordId: objectId, relationId: objectId }).strict(),
  stored: z.object({ recordId: objectId, relationId: objectId }).strict(),
  async check(ctx, input) {
    const record = await recordAt(ctx, input.recordId, 'edit');
    const relations = await ctx.services.relations.list(ctx.principal, input.recordId);
    const relation = relations.items.find((candidate) => candidate.id === input.relationId);
    if (!relation) throw errors.notFound('Relation');
    return {
      args: { recordId: input.recordId, relationId: input.relationId },
      base: null,
      title: `Remove a relation of “${record.name}”`,
      summary: `${relation.label} “${relation.other.name}”`,
      changes: [{ label: relation.label, before: relation.other.name, after: null }],
      targets: { records: [input.recordId, relation.other.id], folders: [] },
      refs: [],
      destructive: true,
      reviewEach: false,
      needsFile: false,
    };
  },
  async execute(ctx, args) {
    const record = await recordAt(ctx, args.recordId, 'edit');
    await ctx.services.relations.remove(ctx.principal, args.recordId, args.relationId);
    return {
      status: 'done',
      result: recordResult(args.recordId, record.name),
      resource: { type: 'record', id: args.recordId, label: record.name },
      note: `✓ Removed a relation of “${record.name}”`,
      auditContext: { relationId: args.relationId },
    };
  },
});

export const collabProposeFavorite = defineProposal({
  tool: 'collab_propose_favorite',
  domain: 'collab',
  confirmLabel: 'confirm',
  description: 'Prepare adding a record to the user’s favorites (favorite: true) or removing it.',
  input: z.object({ recordId: objectId, favorite: z.boolean() }).strict(),
  stored: z.object({ recordId: objectId, favorite: z.boolean() }).strict(),
  async check(ctx, input) {
    const record = await recordAt(ctx, input.recordId, 'view');
    const now = await ctx.services.myRecords.isFavorite(ctx.principal, input.recordId);
    if (now === input.favorite) {
      throw nothingToChange(input.favorite ? 'Already a favorite' : 'Not a favorite');
    }
    return {
      args: { recordId: input.recordId, favorite: input.favorite },
      base: null,
      title: `${input.favorite ? 'Add' : 'Remove'} “${record.name}” ${input.favorite ? 'to' : 'from'} your favorites`,
      summary: 'Only you see your favorites',
      changes: [
        { label: 'Favorite', before: now ? 'Yes' : 'No', after: input.favorite ? 'Yes' : 'No' },
      ],
      targets: { records: [input.recordId], folders: [] },
      refs: [],
      destructive: false,
      reviewEach: false,
      needsFile: false,
    };
  },
  async execute(ctx, args) {
    const record = await recordAt(ctx, args.recordId, 'view');
    if (args.favorite) await ctx.services.myRecords.addFavorite(ctx.principal, args.recordId);
    else await ctx.services.myRecords.removeFavorite(ctx.principal, args.recordId);
    return {
      status: 'done',
      result: recordResult(args.recordId, record.name),
      resource: null,
      note: args.favorite
        ? `✓ Added “${record.name}” to your favorites`
        : `✓ Removed “${record.name}” from your favorites`,
    };
  },
});

export const COLLAB_PROPOSALS: Proposal[] = [
  collabProposeComment,
  collabProposeDeleteComment,
  collabProposeRelation,
  collabProposeRemoveRelation,
  collabProposeFavorite,
];
