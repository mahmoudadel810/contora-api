import { z } from 'zod';
import { can } from '../../authorization/policy.js';
import { errors } from '../../common/errors.js';
import { parseWith } from '../../common/zod.pipe.js';
import {
  CreateFolderSchema,
  MoveFolderSchema,
  RenameFolderSchema,
} from '../../folders/folders.dto.js';
import { folderLink } from '../links.js';
import {
  assertBase,
  defineProposal,
  nothingToChange,
  pathOf,
  plannedRef,
  type CheckContext,
  type ExecuteContext,
  type Proposal,
} from './proposal.js';
import { objectId } from './search.tools.js';

const REF_PLACEHOLDER = '0'.repeat(24);
const StoredFolderName = z.string().trim().min(1).max(120);

const folderResult = (id: string, name: string) => ({
  resourceType: 'folder',
  id,
  name,
  link: folderLink(id),
});

function rootRefusal(verb: string) {
  return errors.badRequest('ROOT_FOLDER', `The root folder cannot be ${verb}`);
}

async function changeableFolder(ctx: CheckContext | ExecuteContext, id: string) {
  const folder = await ctx.services.access.requireFolder(ctx.principal, id, 'edit', {
    itself: true,
  });
  const detail = await ctx.services.folders.get(ctx.principal, id);
  return { folder, path: pathOf(detail.breadcrumbs) };
}

export const foldersProposeCreate = defineProposal({
  tool: 'folders_propose_create',
  domain: 'folders',
  confirmLabel: 'create',
  description:
    'Prepare a new folder. parentId is the folder to create it in (null with a null parentRef: the root); parentRef is the actionId of an earlier folders_propose_create in this answer.',
  input: z
    .object({
      name: z.string().min(1).max(120),
      parentId: objectId.nullable(),
      parentRef: objectId.nullable(),
    })
    .strict(),
  stored: z
    .object({
      name: StoredFolderName,
      parentId: objectId.nullable(),
      parentRef: objectId.nullable(),
    })
    .strict(),
  async check(ctx, input) {
    if (!can(ctx.principal, 'folders.write')) throw errors.forbidden();
    if (input.parentId !== null && input.parentRef !== null) {
      throw errors.validation([
        { path: 'parentId', message: 'Give at most one of parentId and parentRef' },
      ]);
    }
    let parentId: string | null = input.parentId;
    let parentPath: string;
    if (input.parentRef !== null) {
      parentPath =
        plannedRef(ctx, input.parentRef, ['folders_propose_create']).creates ?? 'the new folder';
    } else {
      parentId ??= (await ctx.services.folders.root(ctx.principal)).folder.id;
      const parentDoc = await ctx.services.access.requireFolder(ctx.principal, parentId, 'edit');
      parentPath = pathOf((await ctx.services.folders.get(ctx.principal, parentId)).breadcrumbs);
      await ctx.services.folders.assertNameFree(ctx.principal.tenantId, parentDoc._id, input.name);
    }
    const { name } = parseWith(CreateFolderSchema, {
      name: input.name,
      parentId: parentId ?? REF_PLACEHOLDER,
    });
    const path = `${parentPath} / ${name}`;
    return {
      args: { name, parentId, parentRef: input.parentRef },
      base: null,
      title: `Create folder “${name}”`,
      summary: `In ${parentPath}`,
      changes: [{ label: 'Folder', before: null, after: path }],
      targets: { records: [], folders: input.parentId === null ? [] : [input.parentId] },
      refs: input.parentRef === null ? [] : [input.parentRef],
      destructive: false,
      reviewEach: false,
      needsFile: false,
      creates: path,
    };
  },
  async execute(ctx, args) {
    const parentId = args.parentId ?? ctx.resolved(args.parentRef as string);
    await ctx.services.access.requireFolder(ctx.principal, parentId, 'edit');
    const folder = await ctx.services.folders.create(
      ctx.principal,
      parseWith(CreateFolderSchema, { name: args.name, parentId }),
    );
    return {
      status: 'done',
      result: folderResult(folder.id, folder.name),
      resource: { type: 'folder', id: folder.id, label: folder.name },
      note: `✓ Created folder “${folder.name}”`,
    };
  },
});

export const foldersProposeRename = defineProposal({
  tool: 'folders_propose_rename',
  domain: 'folders',
  confirmLabel: 'update',
  description: 'Prepare renaming one folder (not the root).',
  input: z.object({ id: objectId, name: z.string().min(1).max(120) }).strict(),
  stored: z.object({ id: objectId, name: StoredFolderName }).strict(),
  async check(ctx, input) {
    const { folder, path } = await changeableFolder(ctx, input.id);
    if (folder.isRoot) throw rootRefusal('renamed');
    const { name } = parseWith(RenameFolderSchema, { name: input.name });
    if (name === folder.name) throw nothingToChange('The folder already has this name');
    return {
      args: { id: input.id, name },
      base: { name: folder.name },
      title: `Rename folder “${folder.name}”`,
      summary: path,
      changes: [{ label: 'Name', before: folder.name, after: name }],
      targets: { records: [], folders: [input.id] },
      refs: [],
      destructive: false,
      reviewEach: false,
      needsFile: false,
    };
  },
  async execute(ctx, args, base) {
    const folder = await ctx.services.access.requireFolder(ctx.principal, args.id, 'edit', {
      itself: true,
    });
    assertBase(base, 'name', folder.name);
    const view = await ctx.services.folders.rename(
      ctx.principal,
      args.id,
      parseWith(RenameFolderSchema, { name: args.name }),
    );
    return {
      status: 'done',
      result: folderResult(view.id, view.name),
      resource: { type: 'folder', id: view.id, label: view.name },
      note: `✓ Renamed folder “${folder.name}” to “${view.name}”`,
    };
  },
});

export const foldersProposeMove = defineProposal({
  tool: 'folders_propose_move',
  domain: 'folders',
  confirmLabel: 'move',
  description:
    'Prepare moving one folder (with everything inside it) into another folder. The user confirms each move.',
  input: z.object({ id: objectId, parentId: objectId }).strict(),
  stored: z.object({ id: objectId, parentId: objectId }).strict(),
  async check(ctx, input) {
    const { folder, path } = await changeableFolder(ctx, input.id);
    if (folder.isRoot) throw rootRefusal('moved');
    const target = await ctx.services.access.requireFolder(ctx.principal, input.parentId, 'edit');
    if (target._id.equals(folder._id) || target.ancestorIds.some((id) => id.equals(folder._id))) {
      throw errors.badRequest(
        'INVALID_MOVE',
        'A folder cannot be moved into itself or one of its subfolders',
      );
    }
    if (folder.parentId?.equals(target._id)) {
      throw nothingToChange('The folder is already in this folder');
    }
    await ctx.services.folders.assertNameFree(ctx.principal.tenantId, target._id, folder.name);
    const targetPath = pathOf(
      (await ctx.services.folders.get(ctx.principal, input.parentId)).breadcrumbs,
    );
    return {
      args: { id: input.id, parentId: input.parentId },
      base: { parentId: folder.parentId?.toHexString() ?? null },
      title: `Move folder “${folder.name}”`,
      summary: `Into ${targetPath}, with everything inside it`,
      changes: [{ label: 'Place', before: path, after: `${targetPath} / ${folder.name}` }],
      targets: { records: [], folders: [input.id, input.parentId] },
      refs: [],
      destructive: false,
      reviewEach: true,
      needsFile: false,
    };
  },
  async execute(ctx, args, base) {
    const folder = await ctx.services.access.requireFolder(ctx.principal, args.id, 'edit', {
      itself: true,
    });
    assertBase(base, 'parentId', folder.parentId?.toHexString() ?? null);
    await ctx.services.access.requireFolder(ctx.principal, args.parentId, 'edit');
    const view = await ctx.services.folders.move(
      ctx.principal,
      args.id,
      parseWith(MoveFolderSchema, { parentId: args.parentId }),
    );
    return {
      status: 'done',
      result: folderResult(view.id, view.name),
      resource: { type: 'folder', id: view.id, label: view.name },
      note: `✓ Moved folder “${view.name}”`,
    };
  },
});

export const foldersProposeTrash = defineProposal({
  tool: 'folders_propose_trash',
  domain: 'folders',
  confirmLabel: 'trash',
  description:
    'Prepare moving one folder, with its subfolders and records, to the trash. The user must confirm this explicitly; admins can restore it.',
  input: z.object({ id: objectId }).strict(),
  stored: z.object({ id: objectId }).strict(),
  async check(ctx, input) {
    if (!can(ctx.principal, 'folders.trash')) throw errors.forbidden();
    const { folder, path } = await changeableFolder(ctx, input.id);
    if (folder.isRoot) throw rootRefusal('deleted');
    return {
      args: { id: input.id },
      base: null,
      title: `Move folder “${folder.name}” to the trash`,
      summary: 'Its subfolders and records go to the trash with it',
      changes: [{ label: folder.name, before: path, after: 'Trash' }],
      targets: { records: [], folders: [input.id] },
      refs: [],
      destructive: true,
      reviewEach: false,
      needsFile: false,
    };
  },
  async execute(ctx, args) {
    const folder = await ctx.services.access.requireFolder(ctx.principal, args.id, 'edit', {
      itself: true,
    });
    await ctx.services.trash.trashFolder(ctx.principal, args.id);
    return {
      status: 'done',
      result: { resourceType: 'folder', id: args.id, name: folder.name, link: null },
      resource: { type: 'folder', id: args.id, label: folder.name },
      note: `✓ Moved folder “${folder.name}” to the trash`,
    };
  },
});

export const FOLDERS_PROPOSALS: Proposal[] = [
  foldersProposeCreate,
  foldersProposeRename,
  foldersProposeMove,
  foldersProposeTrash,
];
