import { Types } from 'mongoose';
import {
  AccessScope,
  atLeast,
  maxLevel,
  type IdLike,
  type ScopeFolder,
  type ScopeGrant,
} from './access-scope.js';

const id = () => new Types.ObjectId();
const rootId = id();
const financeId = id();
const invoicesId = id();
const q1Id = id();
const hrId = id();

const root: ScopeFolder = { _id: rootId, parentId: null, ancestorIds: [] };
const finance: ScopeFolder = { _id: financeId, parentId: rootId, ancestorIds: [rootId] };
const invoices: ScopeFolder = {
  _id: invoicesId,
  parentId: financeId,
  ancestorIds: [rootId, financeId],
};
const q1: ScopeFolder = {
  _id: q1Id,
  parentId: invoicesId,
  ancestorIds: [rootId, financeId, invoicesId],
};
const hr: ScopeFolder = { _id: hrId, parentId: rootId, ancestorIds: [rootId] };
const ALL = [root, finance, invoices, q1, hr];

const folderGrant = (f: ScopeFolder, level: 'view' | 'edit'): ScopeGrant => ({
  targetType: 'folder',
  targetId: f._id,
  level,
});
const recordGrant = (recordId: Types.ObjectId, level: 'view' | 'edit'): ScopeGrant => ({
  targetType: 'record',
  targetId: recordId,
  level,
});
const key = (value: IdLike) => (typeof value === 'string' ? value : value.toHexString());

function covered(...grants: ScopeGrant[]): ScopeFolder[] {
  const granted = new Set(
    grants.filter((g) => g.targetType === 'folder').map((g) => key(g.targetId)),
  );
  return ALL.filter(
    (f) => granted.has(key(f._id)) || f.ancestorIds.some((a) => granted.has(key(a))),
  );
}

function memberScope(...grants: ScopeGrant[]): AccessScope {
  return AccessScope.fromGrants(grants, covered(...grants));
}

const hex = (value: Types.ObjectId) => value.toHexString();

describe('levels', () => {
  it('orders view below edit, and nothing below both', () => {
    expect(atLeast('edit', 'view')).toBe(true);
    expect(atLeast('view', 'view')).toBe(true);
    expect(atLeast('view', 'edit')).toBe(false);
    expect(atLeast(null, 'view')).toBe(false);
    expect(maxLevel('view', 'edit')).toBe('edit');
    expect(maxLevel(null, 'view')).toBe('view');
    expect(maxLevel(null, null)).toBeNull();
  });
});

describe('AccessScope', () => {
  describe('unrestricted (admins)', () => {
    const scope = AccessScope.unrestricted();

    it('edits everything and filters nothing', () => {
      expect(scope.unrestricted).toBe(true);
      expect(scope.levelOfFolder(q1)).toBe('edit');
      expect(scope.levelOfFolder(root)).toBe('edit');
      expect(scope.levelOfFolderItself(root)).toBe('edit');
      expect(scope.levelOfFolderId(hex(id()))).toBe('edit');
      expect(scope.levelOfRecord({ _id: id(), folderId: id() })).toBe('edit');
      expect(scope.recordFilter('edit')).toEqual({});
      expect(scope.folderFilter('edit')).toEqual({});
      expect(scope.pinFor({ _id: id(), folderId: financeId }, 'edit')).toBeNull();
      expect(scope.visibleParentId(invoices)).toBe(hex(financeId));
      const crumbs = [
        { id: hex(rootId), name: 'Repository' },
        { id: hex(financeId), name: 'F' },
      ];
      expect(scope.trimCrumbs(crumbs)).toEqual(crumbs);
      expect(scope.entryPoints()).toEqual([]);
    });
  });

  describe('no grants', () => {
    const scope = AccessScope.none();

    it('hands out a new match-nothing filter every time', () => {
      const first = scope.recordFilter('view');
      expect(scope.recordFilter('view')).not.toBe(first);
      expect(scope.folderFilter('view')).not.toBe(scope.folderFilter('view'));
    });

    it('sees nothing, and its filters match nothing', () => {
      expect(scope.unrestricted).toBe(false);
      expect(scope.levelOfFolder(root)).toBeNull();
      expect(scope.levelOfFolderId(hex(financeId))).toBeNull();
      expect(scope.levelOfRecord({ _id: id(), folderId: financeId })).toBeNull();
      expect(scope.recordFilter('view')).toEqual({ _id: { $in: [] } });
      expect(scope.folderFilter('view')).toEqual({ _id: { $in: [] } });
      expect(scope.trimCrumbs([{ id: hex(rootId), name: 'Repository' }])).toEqual([]);
      expect(scope.visibleParentId(finance)).toBeNull();
      expect(scope.entryPoints()).toEqual([]);
    });
  });

  describe('folder grants', () => {
    it('inherit to every folder beneath, but not above or beside', () => {
      const scope = memberScope(folderGrant(finance, 'view'));
      expect(scope.levelOfFolder(finance)).toBe('view');
      expect(scope.levelOfFolder(invoices)).toBe('view');
      expect(scope.levelOfFolder(q1)).toBe('view');
      expect(scope.levelOfFolder(root)).toBeNull();
      expect(scope.levelOfFolder(hr)).toBeNull();
    });

    it('use the folder’s own ancestorIds, so a folder moved or created later inherits', () => {
      const scope = memberScope(folderGrant(finance, 'view'));
      const movedIn: ScopeFolder = {
        _id: hrId,
        parentId: financeId,
        ancestorIds: [rootId, financeId],
      };
      expect(scope.levelOfFolder(movedIn)).toBe('view');
      const brandNew: ScopeFolder = {
        _id: id(),
        parentId: q1Id,
        ancestorIds: [rootId, financeId, invoicesId, q1Id],
      };
      expect(scope.levelOfFolder(brandNew)).toBe('view');
    });

    it('take the highest level on the path', () => {
      const scope = memberScope(folderGrant(finance, 'view'), folderGrant(invoices, 'edit'));
      expect(scope.levelOfFolder(finance)).toBe('view');
      expect(scope.levelOfFolder(invoices)).toBe('edit');
      expect(scope.levelOfFolder(q1)).toBe('edit');
      const lower = memberScope(folderGrant(finance, 'edit'), folderGrant(q1, 'view'));
      expect(lower.levelOfFolder(q1)).toBe('edit');
    });

    it('look folders up by id among those loaded', () => {
      const scope = memberScope(folderGrant(finance, 'edit'));
      expect(scope.levelOfFolderId(hex(q1Id))).toBe('edit');
      expect(scope.levelOfFolderId(q1Id)).toBe('edit');
      expect(scope.levelOfFolderId(hex(hrId))).toBeNull();
      expect(scope.levelOfFolderId(hex(rootId))).toBeNull();
    });
  });

  describe('the level of a folder itself (rename, move, trash)', () => {
    it('comes from its parent, so an entry-point folder cannot be changed', () => {
      const scope = memberScope(folderGrant(finance, 'edit'));
      expect(scope.levelOfFolderItself(finance)).toBeNull();
      expect(scope.levelOfFolderItself(invoices)).toBe('edit');
      expect(scope.levelOfFolderItself(q1)).toBe('edit');
    });

    it('is the parent’s level when the folder has a higher grant of its own', () => {
      const scope = memberScope(folderGrant(finance, 'view'), folderGrant(invoices, 'edit'));
      expect(scope.levelOfFolder(invoices)).toBe('edit');
      expect(scope.levelOfFolderItself(invoices)).toBe('view');
      expect(scope.levelOfFolderItself(q1)).toBe('edit');
    });

    it('is nothing for the root, even with root Edit', () => {
      const scope = AccessScope.fromGrants([folderGrant(root, 'edit')], [root], rootId);
      expect(scope.levelOfFolder(root)).toBe('edit');
      expect(scope.levelOfFolderItself(root)).toBeNull();
      expect(scope.levelOfFolderItself(finance)).toBe('edit');
    });
  });

  describe('a root grant', () => {
    it('covers every folder and record without loading the tree', () => {
      const scope = AccessScope.fromGrants([folderGrant(root, 'view')], [root], rootId);
      expect(scope.levelOfFolderId(hex(hrId))).toBe('view');
      expect(scope.levelOfFolderId(hex(id()))).toBe('view');
      expect(scope.levelOfRecord({ _id: id(), folderId: q1Id })).toBe('view');
      expect(scope.recordFilter('view')).toEqual({});
      expect(scope.folderFilter('view')).toEqual({});
    });

    it('still filters for a level above it', () => {
      const scope = AccessScope.fromGrants(
        [folderGrant(root, 'view'), folderGrant(invoices, 'edit')],
        [root, invoices, q1],
        rootId,
      );
      expect(scope.levelOfFolderId(hex(q1Id))).toBe('edit');
      expect(scope.levelOfFolderId(hex(hrId))).toBe('view');
      expect(scope.folderFilter('edit')).toEqual({ _id: { $in: [invoicesId, q1Id] } });
      expect(scope.recordFilter('edit')).toEqual({
        $or: [{ folderId: { $in: [invoicesId, q1Id] } }, { _id: { $in: [] } }],
      });
    });
  });

  describe('records', () => {
    const recordId = id();

    it('take the higher of the record grant and the folder level', () => {
      const folderOnly = memberScope(folderGrant(finance, 'edit'));
      expect(folderOnly.levelOfRecord({ _id: recordId, folderId: invoicesId })).toBe('edit');
      const both = memberScope(folderGrant(finance, 'view'), recordGrant(recordId, 'edit'));
      expect(both.levelOfRecord({ _id: recordId, folderId: invoicesId })).toBe('edit');
      const recordLower = memberScope(folderGrant(finance, 'edit'), recordGrant(recordId, 'view'));
      expect(recordLower.levelOfRecord({ _id: recordId, folderId: invoicesId })).toBe('edit');
    });

    it('travel with a record grant wherever the record is', () => {
      const scope = memberScope(recordGrant(recordId, 'view'));
      expect(scope.levelOfRecord({ _id: recordId, folderId: hrId })).toBe('view');
      expect(scope.levelOfRecord({ _id: hex(recordId), folderId: hex(q1Id) })).toBe('view');
      expect(scope.levelOfRecord({ _id: id(), folderId: hrId })).toBeNull();
      expect(scope.levelOfFolder(hr)).toBeNull();
    });
  });

  describe('filters', () => {
    const viewRecord = id();
    const editRecord = id();

    it('select records by visible folder or by record grant, per level', () => {
      const scope = memberScope(
        folderGrant(finance, 'view'),
        folderGrant(invoices, 'edit'),
        recordGrant(viewRecord, 'view'),
        recordGrant(editRecord, 'edit'),
      );
      expect(scope.recordFilter('view')).toEqual({
        $or: [
          { folderId: { $in: [financeId, invoicesId, q1Id] } },
          { _id: { $in: [viewRecord, editRecord] } },
        ],
      });
      expect(scope.recordFilter('edit')).toEqual({
        $or: [{ folderId: { $in: [invoicesId, q1Id] } }, { _id: { $in: [editRecord] } }],
      });
    });

    it('select folders by level, never an ancestor of a grant', () => {
      const scope = memberScope(folderGrant(finance, 'view'), folderGrant(q1, 'edit'));
      expect(scope.folderFilter('view')).toEqual({ _id: { $in: [financeId, invoicesId, q1Id] } });
      expect(scope.folderFilter('edit')).toEqual({ _id: { $in: [q1Id] } });
    });

    it('match nothing when only record grants exist', () => {
      const scope = memberScope(recordGrant(viewRecord, 'view'));
      expect(scope.folderFilter('view')).toEqual({ _id: { $in: [] } });
      expect(scope.recordFilter('view')).toEqual({
        $or: [{ folderId: { $in: [] } }, { _id: { $in: [viewRecord] } }],
      });
      expect(scope.recordFilter('edit')).toEqual({ _id: { $in: [] } });
    });
  });

  describe('pinFor', () => {
    const recordId = id();

    it('pins the folder whenever the record grant alone is below the level asked', () => {
      const viaFolder = memberScope(folderGrant(finance, 'edit'));
      expect(viaFolder.pinFor({ _id: recordId, folderId: invoicesId }, 'edit')).toEqual({
        folderId: invoicesId,
      });
      const viewGrant = memberScope(folderGrant(finance, 'edit'), recordGrant(recordId, 'view'));
      expect(viewGrant.pinFor({ _id: recordId, folderId: hex(invoicesId) }, 'edit')).toEqual({
        folderId: invoicesId,
      });
      const rootEdit = AccessScope.fromGrants([folderGrant(root, 'edit')], [root], rootId);
      expect(rootEdit.pinFor({ _id: recordId, folderId: q1Id }, 'edit')).toEqual({
        folderId: q1Id,
      });
    });

    it('does not pin when the record grant is enough', () => {
      const scope = memberScope(folderGrant(finance, 'view'), recordGrant(recordId, 'edit'));
      expect(scope.pinFor({ _id: recordId, folderId: invoicesId }, 'edit')).toBeNull();
      expect(scope.pinFor({ _id: recordId, folderId: invoicesId }, 'view')).toBeNull();
    });
  });

  describe('shapes shown to members', () => {
    const crumbs = [
      { id: hex(rootId), name: 'Repository' },
      { id: hex(financeId), name: 'Finance' },
      { id: hex(invoicesId), name: 'Invoices' },
      { id: hex(q1Id), name: 'Q1' },
    ];

    it('trims breadcrumbs to the visible folders', () => {
      const scope = memberScope(folderGrant(invoices, 'view'));
      expect(scope.trimCrumbs(crumbs)).toEqual(crumbs.slice(2));
      expect(memberScope(folderGrant(q1, 'view')).trimCrumbs(crumbs)).toEqual(crumbs.slice(3));
      expect(memberScope(recordGrant(id(), 'edit')).trimCrumbs(crumbs)).toEqual([]);
      const rootView = AccessScope.fromGrants([folderGrant(root, 'view')], [root], rootId);
      expect(rootView.trimCrumbs(crumbs)).toEqual(crumbs);
    });

    it('names a parent only when it is visible', () => {
      const scope = memberScope(folderGrant(finance, 'view'));
      expect(scope.visibleParentId(finance)).toBeNull();
      expect(scope.visibleParentId(invoices)).toBe(hex(financeId));
      expect(scope.visibleParentId(root)).toBeNull();
    });

    it('lists entry points: top-most granted folders and records outside visible folders', () => {
      const inside = id();
      const outside = id();
      const scope = memberScope(
        folderGrant(finance, 'view'),
        folderGrant(invoices, 'edit'),
        folderGrant(hr, 'edit'),
        recordGrant(inside, 'edit'),
        recordGrant(outside, 'view'),
        recordGrant(id(), 'view'),
      );
      const points = scope.entryPoints([
        { _id: inside, folderId: q1Id },
        { _id: outside, folderId: rootId },
      ]);
      expect(points).toEqual([
        { type: 'folder', id: hex(financeId), level: 'view' },
        { type: 'folder', id: hex(hrId), level: 'edit' },
        { type: 'record', id: hex(outside), level: 'view' },
      ]);
    });

    it('lists the root as the one entry point of a root grant', () => {
      const scope = AccessScope.fromGrants(
        [folderGrant(root, 'view'), folderGrant(hr, 'edit')],
        [root, hr],
        rootId,
      );
      expect(scope.entryPoints()).toEqual([{ type: 'folder', id: hex(rootId), level: 'view' }]);
    });
  });
});
