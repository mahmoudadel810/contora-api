import { z } from 'zod';
import { can } from '../../authorization/policy.js';
import { errors } from '../../common/errors.js';
import { folderLink, recordLink } from '../links.js';
import {
  defineProposal,
  type CheckContext,
  type ExecuteContext,
  type Proposal,
} from './proposal.js';
import { objectId } from './search.tools.js';

const RestoreStored = z.object({ kind: z.enum(['record', 'folder']), id: objectId }).strict();
type RestoreTarget = z.infer<typeof RestoreStored>;

async function restorable(
  ctx: CheckContext | ExecuteContext,
  { kind, id }: RestoreTarget,
): Promise<{ name: string }> {
  await ctx.services.policy.authorize(ctx.principal, 'admin.overview', { type: kind, id });
  const item =
    kind === 'record'
      ? await ctx.services.access.requireRecord(ctx.principal, id, 'edit', { trashed: true })
      : await ctx.services.access.requireFolder(ctx.principal, id, 'edit', { trashed: true });
  const listed = await ctx.services.trash.list(ctx.principal);
  const shown =
    kind === 'record'
      ? listed.records.find((record) => record.id === id && !record.trashedWithFolder)
      : listed.folders.find((folder) => folder.id === id);
  if (!shown) {
    throw errors.badRequest(
      'RESTORE_WITH_FOLDER',
      'This item was trashed with its folder; restore the folder instead',
    );
  }
  return item;
}

export const adminProposeRestore = defineProposal({
  tool: 'admin_propose_restore',
  domain: 'admin',
  confirmLabel: 'confirm',
  description:
    'Prepare restoring a record or a folder (with what was trashed with it) from the trash, by the id from admin_list_trash.',
  input: z.object({ kind: z.enum(['record', 'folder']), id: objectId }).strict(),
  stored: RestoreStored,
  available: (principal) => can(principal, 'admin.overview'),
  async check(ctx, input) {
    const item = await restorable(ctx, input);
    return {
      args: { kind: input.kind, id: input.id },
      base: null,
      title: `Restore ${input.kind} “${item.name}”`,
      summary:
        input.kind === 'folder'
          ? 'With the subfolders and records trashed with it'
          : 'Back to its folder (or the root if that folder is gone)',
      changes: [{ label: item.name, before: 'Trash', after: 'Restored' }],
      targets: { records: [], folders: [] },
      originIds: [input.id],
      refs: [],
      destructive: false,
      reviewEach: false,
      needsFile: false,
    };
  },
  async execute(ctx, args) {
    const item = await restorable(ctx, args);
    if (args.kind === 'record') {
      const record = await ctx.services.trash.restoreRecord(ctx.principal, args.id);
      return {
        status: 'done',
        result: {
          resourceType: 'record',
          id: record.id,
          name: record.name,
          link: recordLink(record.id),
        },
        resource: { type: 'record', id: record.id, label: record.name },
        note: `✓ Restored “${record.name}”`,
      };
    }
    await ctx.services.trash.restoreFolder(ctx.principal, args.id);
    return {
      status: 'done',
      result: { resourceType: 'folder', id: args.id, name: item.name, link: folderLink(args.id) },
      resource: { type: 'folder', id: args.id, label: item.name },
      note: `✓ Restored folder “${item.name}”`,
    };
  },
});

export const ADMIN_PROPOSALS: Proposal[] = [adminProposeRestore];
