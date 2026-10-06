import { z } from 'zod';
import { notice } from '../blocks.js';
import { MODEL_ROWS, objectId } from './search.tools.js';
import { defineTool, type ToolDef } from './tool.js';

export const COMMENT_EXCERPT = 300;

const excerpt = (text: string) =>
  text.length > COMMENT_EXCERPT ? `${text.slice(0, COMMENT_EXCERPT - 1)}…` : text;

const collabListComments = defineTool({
  name: 'collab_list_comments',
  domain: 'collab',
  description: 'The comments on one record, oldest first (author, date, text).',
  input: z.object({ recordId: objectId }).strict(),
  async run(ctx, input) {
    await ctx.services.access.requireRecord(ctx.principal, input.recordId, 'view');
    const comments = await ctx.services.comments.list(ctx.principal, input.recordId);
    const rows = comments.map((comment) => ({
      id: comment.id,
      author: comment.author.displayName,
      authorId: comment.author.id,
      own: comment.author.id === ctx.principal.userId,
      createdAt: comment.createdAt,
      body: excerpt(comment.body),
    }));
    return {
      data: {
        total: rows.length,
        truncated: rows.length > MODEL_ROWS,
        items: rows.slice(-MODEL_ROWS),
      },
      blocks:
        rows.length === 0
          ? [notice('This record has no comments yet.')]
          : [
              {
                kind: 'table',
                title: 'Comments',
                columns: ['By', 'Date', 'Comment'],
                rows: rows.slice(-MODEL_ROWS).map((row) => [row.author, row.createdAt, row.body]),
                truncated: rows.length > MODEL_ROWS,
                scope: { domain: 'collab', recordId: input.recordId },
              },
            ],
    };
  },
});

const collabListRelations = defineTool({
  name: 'collab_list_relations',
  domain: 'collab',
  description: 'The relations of one record (references, supersedes, part of, related to).',
  input: z.object({ recordId: objectId }).strict(),
  async run(ctx, input) {
    await ctx.services.access.requireRecord(ctx.principal, input.recordId, 'view');
    const relations = await ctx.services.relations.list(ctx.principal, input.recordId);
    const rows = relations.items.slice(0, MODEL_ROWS);
    return {
      data: {
        total: relations.total,
        truncated: relations.total > rows.length,
        items: rows.map((relation) => ({
          id: relation.id,
          kind: relation.kind,
          direction: relation.direction,
          label: relation.label,
          other: { id: relation.other.id, name: relation.other.name },
        })),
      },
      blocks:
        rows.length === 0
          ? [notice('This record has no relations yet.')]
          : [
              {
                kind: 'table',
                title: 'Relations',
                columns: ['Relation', 'Record', 'Folder'],
                rows: rows.map((relation) => [
                  relation.label,
                  relation.other.name,
                  relation.other.folderPath.map((crumb) => crumb.name).join(' / '),
                ]),
                truncated: relations.total > rows.length,
                scope: {
                  domain: 'collab',
                  recordId: input.recordId,
                  targets: {
                    records: rows.map((relation) => relation.other.id),
                    folders: rows.flatMap((relation) =>
                      relation.other.folderId ? [relation.other.folderId] : [],
                    ),
                  },
                },
              },
            ],
    };
  },
});

export const COLLAB_TOOLS: ToolDef[] = [collabListComments, collabListRelations] as ToolDef[];
