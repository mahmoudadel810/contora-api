import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import type { Types } from 'mongoose';
import type { AccessScope } from '../access/access-scope.js';
import { AccessService } from '../access/access.service.js';
import { AuditService } from '../audit/audit.service.js';
import { actorOf, type Principal } from '../auth/principal.js';
import { PolicyService } from '../authorization/policy.service.js';
import { errors } from '../common/errors.js';
import { toObjectId } from '../database/object-id.js';
import {
  folderNameKey,
  toFolderView,
  type FolderCrumb,
  type FolderDetailView,
  type FolderDocument,
  type FolderView,
} from './folder.schema.js';
import type { CreateFolderInput, MoveFolderInput, RenameFolderInput } from './folders.dto.js';
import { FoldersRepository } from './folders.repository.js';

export const FOLDER_MOVE_LEASE_MS = 30_000;

function movedConcurrently() {
  return errors.conflict(
    'FOLDER_MOVED_CONCURRENTLY',
    'The folder or the target folder was moved meanwhile; reload and try again',
  );
}

@Injectable()
export class FoldersService {
  private readonly logger = new Logger('Folders');

  constructor(
    private readonly repository: FoldersRepository,
    private readonly policy: PolicyService,
    private readonly audit: AuditService,
    private readonly access: AccessService,
  ) {}

  ensureRoot(principal: Principal): Promise<FolderDocument> {
    return this.repository.ensureRoot(principal.tenantId, principal.userId);
  }

  async root(principal: Principal): Promise<FolderDetailView> {
    await this.policy.authorize(principal, 'folders.read');
    const scope = await this.access.scopeFor(principal);
    const root = await this.ensureRoot(principal);
    if (scope.levelOfFolder(root) === null) throw errors.notFound('Folder');
    return this.detail(principal.tenantId, root, scope);
  }

  async get(principal: Principal, id: string): Promise<FolderDetailView> {
    await this.policy.authorize(principal, 'folders.read');
    const folder = await this.access.requireFolder(principal, id, 'view');
    return this.detail(principal.tenantId, folder, await this.access.scopeFor(principal));
  }

  async tree(principal: Principal): Promise<FolderView[]> {
    await this.policy.authorize(principal, 'folders.read');
    await this.ensureRoot(principal);
    const scope = await this.access.scopeFor(principal);
    const folders = await this.repository.find(
      principal.tenantId,
      { $and: [{ deletedAt: null }, scope.folderFilter('view')] },
      { sort: { nameKey: 1 } },
    );
    return folders.map((folder) => toFolderView(folder, scope));
  }

  async create(principal: Principal, input: CreateFolderInput): Promise<FolderView> {
    await this.policy.authorize(principal, 'folders.write', { type: 'folder', label: input.name });
    const parent = await this.access.requireFolder(principal, input.parentId, 'edit', {
      what: 'Parent folder',
    });
    await this.assertNameFree(principal.tenantId, parent._id, input.name);
    const created = await this.repository.create(principal.tenantId, {
      name: input.name,
      nameKey: folderNameKey(input.name),
      isRoot: false,
      parentId: parent._id,
      ancestorIds: [...parent.ancestorIds, parent._id],
      createdBy: toObjectId(principal.userId),
      deletedAt: null,
      deletedBy: null,
      deletedByName: null,
      trashBatchId: null,
      purgeToken: null,
      purgeClaimedAt: null,
      trashRoot: false,
    });
    await this.audit.record(principal.tenantId, {
      action: 'FOLDER_CREATED',
      actor: actorOf(principal),
      resource: { type: 'folder', id: created.id, label: created.name },
      context: { parentId: parent.id },
    });
    return toFolderView(created, await this.access.scopeFor(principal));
  }

  async rename(principal: Principal, id: string, input: RenameFolderInput): Promise<FolderView> {
    await this.policy.authorize(principal, 'folders.write', { type: 'folder', id });
    const folder = await this.access.requireFolder(principal, id, 'edit', { itself: true });
    this.assertNotRoot(folder, 'renamed');
    if (folderNameKey(input.name) !== folder.nameKey) {
      await this.assertNameFree(principal.tenantId, folder.parentId, input.name);
    }
    const updated = await this.repository.updateById(principal.tenantId, id, {
      name: input.name,
      nameKey: folderNameKey(input.name),
    });
    if (!updated) throw errors.notFound('Folder');
    await this.audit.record(principal.tenantId, {
      action: 'FOLDER_RENAMED',
      actor: actorOf(principal),
      resource: { type: 'folder', id, label: updated.name },
      context: { previousName: folder.name },
    });
    return toFolderView(updated, await this.access.scopeFor(principal));
  }

  async move(principal: Principal, id: string, input: MoveFolderInput): Promise<FolderView> {
    await this.policy.authorize(principal, 'folders.write', { type: 'folder', id });
    const tenantId = principal.tenantId;
    await this.ensureRoot(principal);
    await this.access.requireFolder(principal, id, 'edit', { itself: true });
    await this.access.requireFolder(principal, input.parentId, 'edit', { what: 'Target folder' });
    const token = randomUUID();
    if (!(await this.repository.acquireMoveLease(tenantId, token, FOLDER_MOVE_LEASE_MS))) {
      throw errors.conflict(
        'FOLDER_MOVE_IN_PROGRESS',
        'Another folder is being moved right now; try again in a moment',
      );
    }
    try {
      return await this.moveUnderLease(principal, id, input);
    } finally {
      await this.repository.releaseMoveLease(tenantId, token).catch((error: unknown) => {
        this.logger.warn(
          `Could not release the folder-move lease of tenant ${tenantId}; it expires in ` +
            `${FOLDER_MOVE_LEASE_MS / 1000} s: ${error instanceof Error ? error.name : 'unknown error'}`,
        );
      });
    }
  }

  private async moveUnderLease(
    principal: Principal,
    id: string,
    input: MoveFolderInput,
  ): Promise<FolderView> {
    const tenantId = principal.tenantId;
    const folder = await this.requireLive(tenantId, id);
    this.assertNotRoot(folder, 'moved');
    const target = await this.requireLive(tenantId, input.parentId, 'Target folder');
    const intoItself =
      target._id.equals(folder._id) || target.ancestorIds.some((a) => a.equals(folder._id));
    if (intoItself) {
      throw errors.badRequest(
        'INVALID_MOVE',
        'A folder cannot be moved into itself or one of its subfolders',
      );
    }
    if (folder.parentId && target._id.equals(folder.parentId)) {
      return toFolderView(folder, await this.access.scopeFor(principal));
    }
    await this.assertNameFree(tenantId, target._id, folder.name);

    const newAncestors = [...target.ancestorIds, target._id];
    const oldPlace = { parentId: folder.parentId, ancestorIds: [...folder.ancestorIds] };
    const updated = await this.repository.updateOne(
      tenantId,
      { _id: folder._id, deletedAt: null, ...oldPlace },
      { parentId: target._id, ancestorIds: newAncestors },
    );
    if (!updated) {
      await this.requireLive(tenantId, id);
      throw movedConcurrently();
    }
    if (!(await this.pathUnchanged(tenantId, target))) {
      await this.undoMove(tenantId, folder, target, oldPlace.ancestorIds);
      throw movedConcurrently();
    }
    const moved = (await this.repository.findById(tenantId, id)) ?? updated;
    try {
      await this.rewriteDescendants(tenantId, moved);
    } catch (error) {
      await this.undoMove(tenantId, folder, target, oldPlace.ancestorIds);
      throw error;
    }
    await this.audit.record(tenantId, {
      action: 'FOLDER_MOVED',
      actor: actorOf(principal),
      resource: { type: 'folder', id, label: folder.name },
      context: { fromParentId: folder.parentId?.toHexString() ?? null, toParentId: target.id },
    });
    return toFolderView(moved, await this.access.scopeFor(principal));
  }

  private async undoMove(
    tenantId: string,
    folder: FolderDocument,
    target: FolderDocument,
    oldAncestorIds: Types.ObjectId[],
  ): Promise<void> {
    const oldParent = await this.repository.findById(
      tenantId,
      (folder.parentId as Types.ObjectId).toHexString(),
    );
    const undone = await this.repository.updateOne(
      tenantId,
      { _id: folder._id, parentId: target._id },
      {
        parentId: folder.parentId,
        ancestorIds: oldParent ? [...oldParent.ancestorIds, oldParent._id] : oldAncestorIds,
      },
    );
    if (undone) await this.rewriteDescendants(tenantId, undone);
  }

  private async rewriteDescendants(tenantId: string, folder: FolderDocument): Promise<void> {
    await this.repository.updateMany(tenantId, { ancestorIds: folder._id }, [
      {
        $set: {
          ancestorIds: {
            $concatArrays: [
              [...folder.ancestorIds, folder._id],
              {
                $slice: [
                  '$ancestorIds',
                  { $add: [{ $indexOfArray: ['$ancestorIds', folder._id] }, 1] },
                  { $size: '$ancestorIds' },
                ],
              },
            ],
          },
        },
      },
    ]);
  }

  async requireLive(tenantId: string, id: string, what = 'Folder'): Promise<FolderDocument> {
    const folder = await this.repository.findById(tenantId, id);
    if (!folder || folder.deletedAt) throw errors.notFound(what);
    return folder;
  }

  async liveSubtreeIds(tenantId: string, folderId: string): Promise<Types.ObjectId[]> {
    const folder = await this.requireLive(tenantId, folderId);
    const descendants = await this.repository.find(tenantId, {
      ancestorIds: folder._id,
      deletedAt: null,
    });
    return [folder._id, ...descendants.map((d) => d._id)];
  }

  async breadcrumbs(
    tenantId: string,
    folder: FolderDocument,
    scope: AccessScope,
  ): Promise<FolderCrumb[]> {
    const ancestors =
      folder.ancestorIds.length > 0
        ? await this.repository.find(tenantId, { _id: { $in: folder.ancestorIds } })
        : [];
    const byId = new Map(ancestors.map((a) => [a.id, a]));
    return scope.trimCrumbs(
      folder.ancestorIds
        .flatMap((ancestorId) => {
          const ancestor = byId.get(ancestorId.toHexString());
          return ancestor ? [{ id: ancestor.id as string, name: ancestor.name }] : [];
        })
        .concat([{ id: folder.id as string, name: folder.name }]),
    );
  }

  async pathsOf(
    tenantId: string,
    folderIds: Types.ObjectId[],
    scope: AccessScope,
  ): Promise<Map<string, FolderCrumb[]>> {
    if (folderIds.length === 0) return new Map();
    const folders = await this.repository.find(tenantId, { _id: { $in: folderIds } });
    const ancestorIds = [
      ...new Set(folders.flatMap((f) => f.ancestorIds.map((a) => a.toHexString()))),
    ].map(toObjectId);
    const ancestors =
      ancestorIds.length > 0
        ? await this.repository.find(tenantId, { _id: { $in: ancestorIds } })
        : [];
    const names = new Map([...ancestors, ...folders].map((f) => [f.id as string, f.name]));
    return new Map(
      folders.map((folder) => [
        folder.id as string,
        scope.trimCrumbs(
          [...folder.ancestorIds, folder._id].flatMap((id) => {
            const name = names.get(id.toHexString());
            return name === undefined ? [] : [{ id: id.toHexString(), name }];
          }),
        ),
      ]),
    );
  }

  async assertNameFree(
    tenantId: string,
    parentId: Types.ObjectId | null,
    name: string,
  ): Promise<void> {
    const taken = await this.repository.exists(tenantId, {
      parentId,
      nameKey: folderNameKey(name),
      deletedAt: null,
    });
    if (taken) throw errors.conflict('NAME_TAKEN', 'A folder with this name already exists here');
  }

  private async detail(
    tenantId: string,
    folder: FolderDocument,
    scope: AccessScope,
  ): Promise<FolderDetailView> {
    const children = await this.repository.find(
      tenantId,
      { $and: [{ parentId: folder._id, deletedAt: null }, scope.folderFilter('view')] },
      { sort: { nameKey: 1 } },
    );
    const view = toFolderView(folder, scope);
    return {
      folder: view,
      breadcrumbs: await this.breadcrumbs(tenantId, folder, scope),
      folders: children.map((child) => toFolderView(child, scope)),
      ...(view.access ? { access: view.access } : {}),
      accessItself: view.accessItself ?? null,
    };
  }

  private async pathUnchanged(tenantId: string, folder: FolderDocument): Promise<boolean> {
    const path = [...folder.ancestorIds, folder._id];
    const fresh = await this.repository.find(tenantId, { _id: { $in: path }, deletedAt: null });
    const byId = new Map(fresh.map((f) => [f.id as string, f]));
    const current = byId.get(folder.id as string);
    const sameAncestors =
      current !== undefined &&
      current.ancestorIds.length === folder.ancestorIds.length &&
      current.ancestorIds.every((a, i) => a.equals(folder.ancestorIds[i]));
    return (
      sameAncestors &&
      path.every((id, i) => {
        const parentId = byId.get(id.toHexString())?.parentId;
        return i === 0 ? parentId === null : parentId?.equals(path[i - 1]) === true;
      })
    );
  }

  private assertNotRoot(folder: FolderDocument, verb: string): void {
    if (folder.isRoot) throw errors.badRequest('ROOT_FOLDER', `The root folder cannot be ${verb}`);
  }
}
