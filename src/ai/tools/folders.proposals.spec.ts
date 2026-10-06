import { HttpException } from '@nestjs/common';
import { Types } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';
import type { Principal } from '../../auth/principal.js';
import {
  foldersProposeCreate,
  foldersProposeMove,
  foldersProposeRename,
  foldersProposeTrash,
} from './folders.proposals.js';
import type { ExecuteContext, PlannedAction } from './proposal.js';
import type { ToolServices } from './tool.js';

const ROOT = 'a'.repeat(24);
const FOLDER = 'b'.repeat(24);
const TARGET = 'c'.repeat(24);
const CHILD = 'd'.repeat(24);
const PLANNED = 'e'.repeat(24);
const CREATED = 'f'.repeat(24);

const principal: Principal = {
  userId: '9'.repeat(24),
  tenantId: '8'.repeat(24),
  role: 'member',
  email: 'member@example.test',
  displayName: 'Member',
};

const NAMES: Record<string, string> = {
  [ROOT]: 'Repository',
  [FOLDER]: 'Finance',
  [TARGET]: 'Archive',
  [CHILD]: 'Q1',
};

function folderDoc(id: string, overrides: Record<string, unknown> = {}) {
  const parents: Record<string, string | null> = {
    [ROOT]: null,
    [FOLDER]: ROOT,
    [TARGET]: ROOT,
    [CHILD]: FOLDER,
  };
  const parent = parents[id] ?? ROOT;
  return {
    _id: new Types.ObjectId(id),
    id,
    name: NAMES[id] ?? 'Folder',
    isRoot: id === ROOT,
    parentId: parent === null ? null : new Types.ObjectId(parent),
    ancestorIds:
      id === CHILD
        ? [new Types.ObjectId(ROOT), new Types.ObjectId(FOLDER)]
        : parent
          ? [new Types.ObjectId(ROOT)]
          : [],
    ...overrides,
  };
}

function fakeServices(overrides: Record<string, ReturnType<typeof folderDoc>> = {}) {
  const doc = (id: string) => overrides[id] ?? folderDoc(id);
  return {
    access: {
      requireFolder: vi.fn(async (_p: Principal, id: string) => doc(id)),
    },
    folders: {
      root: vi.fn(async () => ({
        folder: { id: ROOT },
        breadcrumbs: [{ id: ROOT, name: 'Repository' }],
      })),
      get: vi.fn(async (_p: Principal, id: string) => ({
        folder: { id },
        breadcrumbs:
          id === ROOT
            ? [{ id: ROOT, name: 'Repository' }]
            : [
                { id: ROOT, name: 'Repository' },
                { id, name: NAMES[id] ?? 'Folder' },
              ],
      })),
      assertNameFree: vi.fn(async () => undefined),
      create: vi.fn(async (_p: Principal, input: { name: string }) => ({
        id: CREATED,
        name: input.name,
      })),
      rename: vi.fn(async (_p: Principal, id: string, input: { name: string }) => ({
        id,
        name: input.name,
      })),
      move: vi.fn(async (_p: Principal, id: string) => ({ id, name: NAMES[id] })),
    },
    trash: { trashFolder: vi.fn(async () => undefined) },
  };
}

type Fakes = ReturnType<typeof fakeServices>;

const checkCtx = (services: Fakes, planned: PlannedAction[] = []) => ({
  principal,
  services: services as unknown as ToolServices,
  planned: (id: string) => planned.find((action) => action.id === id) ?? null,
});

const executeCtx = (services: Fakes, resolved: Record<string, string> = {}): ExecuteContext => ({
  principal,
  services: services as unknown as ToolServices,
  file: null,
  resolved: (id) => resolved[id] as string,
});

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HttpException) return (error.getResponse() as { code: string }).code;
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('folders_propose_create', () => {
  it('defaults to the root (not a user-named target) and checks edit on it', async () => {
    const services = fakeServices();
    const preview = await foldersProposeCreate.check(checkCtx(services), {
      name: 'Contracts',
      parentId: null,
      parentRef: null,
    });
    expect(services.access.requireFolder).toHaveBeenCalledWith(principal, ROOT, 'edit');
    expect(services.folders.assertNameFree).toHaveBeenCalled();
    expect(preview).toMatchObject({
      args: { name: 'Contracts', parentId: ROOT, parentRef: null },
      changes: [{ label: 'Folder', before: null, after: 'Repository / Contracts' }],
      targets: { records: [], folders: [] },
      creates: 'Repository / Contracts',
    });
    expect(services.folders.create).not.toHaveBeenCalled();
  });

  it('nests under a folder planned earlier in the same answer, resolved at confirm', async () => {
    const services = fakeServices();
    const planned: PlannedAction = {
      id: PLANNED,
      tool: 'folders_propose_create',
      step: 1,
      args: {},
      creates: 'Repository / 2026',
    };
    const preview = await foldersProposeCreate.check(checkCtx(services, [planned]), {
      name: 'Q1',
      parentId: null,
      parentRef: PLANNED,
    });
    expect(preview).toMatchObject({ refs: [PLANNED], creates: 'Repository / 2026 / Q1' });
    await foldersProposeCreate.execute(
      executeCtx(services, { [PLANNED]: CREATED }),
      preview.args,
      null,
    );
    expect(services.folders.create).toHaveBeenCalledWith(principal, {
      name: 'Q1',
      parentId: CREATED,
    });
  });

  it('refuses both a parentId and a parentRef', async () => {
    expect(
      await codeOf(
        foldersProposeCreate.check(checkCtx(fakeServices()), {
          name: 'X',
          parentId: FOLDER,
          parentRef: PLANNED,
        }),
      ),
    ).toBe('VALIDATION_FAILED');
  });
});

describe('folders_propose_rename', () => {
  it('checks the folder itself, refuses the root, and is stale once renamed by someone else', async () => {
    const services = fakeServices();
    const preview = await foldersProposeRename.check(checkCtx(services), {
      id: FOLDER,
      name: 'Money',
    });
    expect(services.access.requireFolder).toHaveBeenCalledWith(principal, FOLDER, 'edit', {
      itself: true,
    });
    expect(preview).toMatchObject({
      base: { name: 'Finance' },
      args: { id: FOLDER, name: 'Money' },
    });
    expect(
      await codeOf(foldersProposeRename.check(checkCtx(services), { id: ROOT, name: 'Top' })),
    ).toBe('ROOT_FOLDER');
    const renamed = fakeServices({ [FOLDER]: folderDoc(FOLDER, { name: 'Budget' }) });
    expect(
      await codeOf(
        foldersProposeRename.execute(
          executeCtx(renamed),
          { id: FOLDER, name: 'Money' },
          { name: 'Finance' },
        ),
      ),
    ).toBe('ACTION_STALE');
    expect(renamed.folders.rename).not.toHaveBeenCalled();
  });
});

describe('folders_propose_move', () => {
  it('is reviewed on its own, refuses a move into its own subtree, and goes stale', async () => {
    const services = fakeServices();
    const preview = await foldersProposeMove.check(checkCtx(services), {
      id: FOLDER,
      parentId: TARGET,
    });
    expect(preview).toMatchObject({
      reviewEach: true,
      base: { parentId: ROOT },
      changes: [
        { label: 'Place', before: 'Repository / Finance', after: 'Repository / Archive / Finance' },
      ],
    });
    expect(
      await codeOf(foldersProposeMove.check(checkCtx(services), { id: FOLDER, parentId: CHILD })),
    ).toBe('INVALID_MOVE');
    await foldersProposeMove.execute(
      executeCtx(services),
      { id: FOLDER, parentId: TARGET },
      { parentId: ROOT },
    );
    expect(services.folders.move).toHaveBeenCalledWith(principal, FOLDER, { parentId: TARGET });
    const movedAway = fakeServices({
      [FOLDER]: folderDoc(FOLDER, { parentId: new Types.ObjectId(TARGET) }),
    });
    expect(
      await codeOf(
        foldersProposeMove.execute(
          executeCtx(movedAway),
          { id: FOLDER, parentId: TARGET },
          { parentId: ROOT },
        ),
      ),
    ).toBe('ACTION_STALE');
  });
});

describe('folders_propose_trash', () => {
  it('is destructive and runs TrashService.trashFolder', async () => {
    const services = fakeServices();
    const preview = await foldersProposeTrash.check(checkCtx(services), { id: FOLDER });
    expect(preview).toMatchObject({
      destructive: true,
      changes: [{ label: 'Finance', before: 'Repository / Finance', after: 'Trash' }],
    });
    expect(services.trash.trashFolder).not.toHaveBeenCalled();
    await foldersProposeTrash.execute(executeCtx(services), { id: FOLDER }, null);
    expect(services.trash.trashFolder).toHaveBeenCalledWith(principal, FOLDER);
  });
});
