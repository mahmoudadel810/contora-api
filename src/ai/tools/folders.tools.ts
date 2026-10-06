import { z } from 'zod';
import type { FolderDetailView, FolderView } from '../../folders/folder.schema.js';
import { ListRecordsQuerySchema } from '../../records/records.dto.js';
import { notice, type BlockDraft } from '../blocks.js';
import { folderLink } from '../links.js';
import { MODEL_ROWS, objectId, recordRow, recordsBlock } from './search.tools.js';
import { defineTool, type ToolDef } from './tool.js';

const BLOCK_FOLDERS = 100;

const linkOf = (folder: Pick<FolderView, 'id' | 'isRoot'>) =>
  folderLink(folder.isRoot ? null : folder.id);

export function pathsOf(folders: FolderView[]): Map<string, string> {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const paths = new Map<string, string>();
  const pathOf = (folder: FolderView, seen: Set<string>): string => {
    const known = paths.get(folder.id);
    if (known !== undefined) return known;
    const parent = folder.parentId ? byId.get(folder.parentId) : undefined;
    const path =
      parent && !seen.has(parent.id)
        ? `${pathOf(parent, new Set([...seen, folder.id]))} / ${folder.name}`
        : folder.name;
    paths.set(folder.id, path);
    return path;
  };
  for (const folder of folders) pathOf(folder, new Set());
  return paths;
}

const foldersGetTree = defineTool({
  name: 'folders_get_tree',
  domain: 'folders',
  description: 'All folders the user can see, with their paths.',
  input: z.object({}).strict(),
  async run(ctx) {
    const folders = await ctx.services.folders.tree(ctx.principal);
    const paths = pathsOf(folders);
    const items = folders
      .map((folder) => ({
        id: folder.id,
        name: folder.name,
        path: paths.get(folder.id) ?? folder.name,
        link: linkOf(folder),
      }))
      .sort((a, b) => a.path.localeCompare(b.path));
    return {
      data: {
        total: items.length,
        truncated: items.length > MODEL_ROWS,
        items: items.slice(0, MODEL_ROWS).map(({ id, name, path }) => ({ id, name, path })),
      },
      blocks: [{ kind: 'folders', items: items.slice(0, BLOCK_FOLDERS) }],
    };
  },
});

const foldersGetFolder = defineTool({
  name: 'folders_get_folder',
  domain: 'folders',
  description:
    'One folder (null id = the root): its path, its subfolders and the first 20 records in it.',
  input: z.object({ id: objectId.nullable() }).strict(),
  async run(ctx, input) {
    const detail: FolderDetailView = input.id
      ? await ctx.services.folders.get(ctx.principal, input.id)
      : await ctx.services.folders.root(ctx.principal);
    const records = await ctx.services.records.list(
      ctx.principal,
      ListRecordsQuerySchema.parse({ folderId: detail.folder.id, pageSize: String(MODEL_ROWS) }),
      {},
    );
    const path = detail.breadcrumbs.map((crumb) => crumb.name).join(' / ');
    const blocks: BlockDraft[] = [
      {
        kind: 'folders',
        items: [
          { id: detail.folder.id, name: detail.folder.name, path, link: linkOf(detail.folder) },
          ...detail.folders.slice(0, BLOCK_FOLDERS).map((child) => ({
            id: child.id,
            name: child.name,
            path: `${path} / ${child.name}`,
            link: linkOf(child),
          })),
        ],
      },
      records.items.length > 0
        ? recordsBlock(
            `Records in ${detail.folder.name}`,
            records.items,
            records.total,
            null,
            detail.folder.id,
          )
        : notice('This folder holds no records.'),
    ];
    return {
      data: {
        folder: { id: detail.folder.id, name: detail.folder.name, path },
        subfolders: detail.folders.slice(0, MODEL_ROWS).map(({ id, name }) => ({ id, name })),
        subfoldersTotal: detail.folders.length,
        records: records.items.map(recordRow),
        recordsTotal: records.total,
        truncated: records.total > records.items.length || detail.folders.length > MODEL_ROWS,
      },
      blocks,
    };
  },
});

export const FOLDERS_TOOLS: ToolDef[] = [foldersGetTree, foldersGetFolder] as ToolDef[];
