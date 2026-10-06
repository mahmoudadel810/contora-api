import { getConnectionToken } from '@nestjs/mongoose';
import { Types, type Connection } from 'mongoose';
import { AccessService } from '../src/access/access.service.js';
import { FoldersRepository } from '../src/folders/folders.repository.js';
import { FoldersService } from '../src/folders/folders.service.js';
import { addMember, as, signUp, type Actor } from './helpers/actors.js';
import { grantAccess, grantRootEdit } from './helpers/fixtures.js';
import { createTestApp, type TestApp } from './helpers/test-app.js';

async function rootId(ctx: TestApp, actor: Actor): Promise<string> {
  const res = await as(ctx, actor).get('/api/v1/folders/root').expect(200);
  return res.body.folder.id as string;
}

async function mkdir(ctx: TestApp, actor: Actor, name: string, parentId: string): Promise<string> {
  const res = await as(ctx, actor).post('/api/v1/folders').send({ name, parentId }).expect(201);
  return res.body.id as string;
}

describe('folders (e2e)', () => {
  let ctx: TestApp;
  let admin: Actor;
  let member: Actor;
  let other: Actor;

  const roots = () =>
    ctx.app.get<Connection>(getConnectionToken()).collection('folders') as unknown as {
      updateOne: (filter: object, update: object) => Promise<unknown>;
      findOne: (filter: object) => Promise<Record<string, unknown> | null>;
    };
  const rootFilter = (actor: Actor) => ({
    tenantId: new Types.ObjectId(actor.tenantId),
    isRoot: true,
  });
  const leaseOf = async (actor: Actor) => {
    const root = await roots().findOne(rootFilter(actor));
    return { token: root?.moveLeaseToken ?? null, until: root?.moveLeaseUntil ?? null };
  };
  const setLease = (actor: Actor, token: string, until: Date) =>
    roots().updateOne(rootFilter(actor), {
      $set: { moveLeaseToken: token, moveLeaseUntil: until },
    });
  const expireMoveLease = (actor: Actor) =>
    roots().updateOne(rootFilter(actor), { $set: { moveLeaseUntil: new Date(0) } });

  beforeAll(async () => {
    ctx = await createTestApp();
    admin = await signUp(ctx, { tenantName: 'Folders Co' });
    member = await addMember(ctx, admin);
    await grantRootEdit(ctx, admin, member);
    other = await signUp(ctx, { tenantName: 'Other Co' });
  });

  afterAll(async () => {
    await ctx.stop();
  });

  it('gives every tenant exactly one root folder', async () => {
    const first = await as(ctx, admin).get('/api/v1/folders/root').expect(200);
    const second = await as(ctx, member).get('/api/v1/folders/root').expect(200);
    expect(first.body.folder).toMatchObject({ name: 'Repository', parentId: null, isRoot: true });
    expect(second.body.folder.id).toBe(first.body.folder.id);
    expect(first.body.breadcrumbs).toEqual([{ id: first.body.folder.id, name: 'Repository' }]);
    const otherRoot = await as(ctx, other).get('/api/v1/folders/root').expect(200);
    expect(otherRoot.body.folder.id).not.toBe(first.body.folder.id);
  });

  it("creates a new tenant's root once when its first requests arrive together", async () => {
    const fresh = await signUp(ctx, { tenantName: 'Fresh Co' });
    const repository = ctx.app.get(FoldersRepository);
    const roots = await Promise.all(
      Array.from({ length: 8 }, () => repository.ensureRoot(fresh.tenantId, fresh.userId)),
    );
    expect(new Set(roots.map((root) => root.id)).size).toBe(1);
    const another = await signUp(ctx, { tenantName: 'Fresh Two' });
    const pages = await Promise.all([
      as(ctx, another).get('/api/v1/folders/root'),
      as(ctx, another).get('/api/v1/folders/tree'),
      as(ctx, another).get('/api/v1/folders/root'),
    ]);
    expect(pages.map((res) => res.status)).toEqual([200, 200, 200]);
  });

  it('creates nested folders, navigates them and lists the tree', async () => {
    const root = await rootId(ctx, admin);
    const finance = await mkdir(ctx, admin, 'Finance', root);
    const invoices = await mkdir(ctx, member, 'Invoices', finance);
    const detail = await as(ctx, member).get(`/api/v1/folders/${invoices}`).expect(200);
    expect(detail.body.breadcrumbs.map((c: { name: string }) => c.name)).toEqual([
      'Repository',
      'Finance',
      'Invoices',
    ]);
    const parent = await as(ctx, admin).get(`/api/v1/folders/${finance}`).expect(200);
    expect(parent.body.folders.map((f: { name: string }) => f.name)).toEqual(['Invoices']);
    const tree = await as(ctx, admin).get('/api/v1/folders/tree').expect(200);
    expect(tree.body.map((f: { name: string }) => f.name)).toEqual(
      expect.arrayContaining(['Repository', 'Finance', 'Invoices']),
    );
  });

  it('rejects duplicate sibling names case-insensitively, slashes, and unknown parents', async () => {
    const root = await rootId(ctx, admin);
    await mkdir(ctx, admin, 'Legal', root);
    const dup = await as(ctx, admin)
      .post('/api/v1/folders')
      .send({ name: ' legal ', parentId: root })
      .expect(409);
    expect(dup.body.code).toBe('NAME_TAKEN');
    await as(ctx, admin).post('/api/v1/folders').send({ name: 'a/b', parentId: root }).expect(400);
    await as(ctx, admin)
      .post('/api/v1/folders')
      .send({ name: 'Orphan', parentId: 'not-an-id' })
      .expect(404);
  });

  it('renames folders but never the root', async () => {
    const root = await rootId(ctx, admin);
    const hr = await mkdir(ctx, admin, 'HR', root);
    const renamed = await as(ctx, member)
      .patch(`/api/v1/folders/${hr}`)
      .send({ name: 'People' })
      .expect(200);
    expect(renamed.body.name).toBe('People');
    const rootRename = await as(ctx, admin)
      .patch(`/api/v1/folders/${root}`)
      .send({ name: 'Nope' })
      .expect(400);
    expect(rootRename.body.code).toBe('ROOT_FOLDER');
  });

  it('moves a folder, refuses cycles, and updates descendant breadcrumbs', async () => {
    const root = await rootId(ctx, admin);
    const a = await mkdir(ctx, admin, 'A', root);
    const b = await mkdir(ctx, admin, 'B', a);
    const c = await mkdir(ctx, admin, 'C', b);
    const archive = await mkdir(ctx, admin, 'Archive', root);
    const invalid = await as(ctx, admin)
      .post(`/api/v1/folders/${a}/move`)
      .send({ parentId: c })
      .expect(400);
    expect(invalid.body.code).toBe('INVALID_MOVE');
    await as(ctx, admin).post(`/api/v1/folders/${a}/move`).send({ parentId: a }).expect(400);
    await as(ctx, admin)
      .post(`/api/v1/folders/${root}/move`)
      .send({ parentId: archive })
      .expect(400);
    const moved = await as(ctx, member)
      .post(`/api/v1/folders/${a}/move`)
      .send({ parentId: archive })
      .expect(200);
    expect(moved.body.parentId).toBe(archive);
    const deep = await as(ctx, admin).get(`/api/v1/folders/${c}`).expect(200);
    expect(deep.body.breadcrumbs.map((x: { name: string }) => x.name)).toEqual([
      'Repository',
      'Archive',
      'A',
      'B',
      'C',
    ]);
  });

  it('never lets two concurrent moves put folders inside each other, even past the lease', async () => {
    const root = await rootId(ctx, admin);
    const x = await mkdir(ctx, admin, 'Race X', root);
    const y = await mkdir(ctx, admin, 'Race Y', root);
    const yChild = await mkdir(ctx, admin, 'Race Y child', y);

    const service = ctx.app.get(FoldersService, { strict: false });
    const assertNameFree = service.assertNameFree.bind(service);
    let inner = 0;
    const spy = vi.spyOn(service, 'assertNameFree').mockImplementationOnce(async (...args) => {
      await expireMoveLease(admin);
      inner = (await as(ctx, member).post(`/api/v1/folders/${y}/move`).send({ parentId: x }))
        .status;
      return assertNameFree(...args);
    });
    let outer: { status: number; body: { code?: string } };
    try {
      outer = await as(ctx, admin).post(`/api/v1/folders/${x}/move`).send({ parentId: y });
    } finally {
      spy.mockRestore();
    }
    expect([inner, outer.status].filter((s) => s === 200).length).toBeLessThanOrEqual(1);
    expect(inner).toBe(200);
    expect(outer.status).toBe(409);
    expect(outer.body.code).toBe('FOLDER_MOVED_CONCURRENTLY');

    const tree = (await as(ctx, admin).get('/api/v1/folders/tree').expect(200)).body as {
      id: string;
      parentId: string | null;
    }[];
    const parentOf = new Map(tree.map((f) => [f.id, f.parentId]));
    for (const folder of tree) {
      const path: string[] = [];
      let at: string | null = folder.id;
      while (at !== null && path.length <= tree.length) {
        path.unshift(at);
        at = parentOf.get(at) ?? null;
      }
      expect(path[0]).toBe(root);
      if ([x, y, yChild].includes(folder.id)) {
        const detail = await as(ctx, admin).get(`/api/v1/folders/${folder.id}`).expect(200);
        expect(detail.body.breadcrumbs.map((c: { id: string }) => c.id)).toEqual(path);
      }
    }
    expect(parentOf.get(y)).toBe(x);
    expect(parentOf.get(x)).toBe(root);
  });

  it('refuses a move whose target path was changed by a concurrent move further up, past the lease', async () => {
    const root = await rootId(ctx, admin);
    const a = await mkdir(ctx, admin, 'Deep A', root);
    const d = await mkdir(ctx, admin, 'Deep D', a);
    const b = await mkdir(ctx, admin, 'Deep B', root);
    const c = await mkdir(ctx, admin, 'Deep C', b);
    const service = ctx.app.get(FoldersService, { strict: false });
    const repository = ctx.app.get(FoldersRepository, { strict: false });
    let innerMoved = () => {};
    const moved = new Promise<void>((resolve) => (innerMoved = resolve));
    let release = () => {};
    const released = new Promise<void>((resolve) => (release = resolve));
    const updateMany = repository.updateMany.bind(repository);
    const holdDescendants = vi
      .spyOn(repository, 'updateMany')
      .mockImplementationOnce(async (...args) => {
        innerMoved();
        await released;
        return updateMany(...args);
      });
    const assertNameFree = service.assertNameFree.bind(service);
    let inner: Promise<number> = Promise.resolve(0);
    const nameSpy = vi.spyOn(service, 'assertNameFree').mockImplementationOnce(async (...args) => {
      await expireMoveLease(admin);
      inner = as(ctx, member)
        .post(`/api/v1/folders/${b}/move`)
        .send({ parentId: d })
        .then((res) => res.status);
      await moved;
      return assertNameFree(...args);
    });
    let outer: { status: number; body: { code?: string } };
    try {
      outer = await as(ctx, admin).post(`/api/v1/folders/${a}/move`).send({ parentId: c });
    } finally {
      release();
      nameSpy.mockRestore();
    }
    const innerStatus = await inner;
    holdDescendants.mockRestore();
    expect(outer.status).toBe(409);
    expect(outer.body.code).toBe('FOLDER_MOVED_CONCURRENTLY');
    expect(innerStatus).toBe(200);
    const deep = await as(ctx, admin).get(`/api/v1/folders/${c}`).expect(200);
    expect(deep.body.breadcrumbs.map((x: { id: string }) => x.id)).toEqual([root, a, d, b, c]);
    const moverA = await as(ctx, admin).get(`/api/v1/folders/${a}`).expect(200);
    expect(moverA.body.breadcrumbs.map((x: { id: string }) => x.id)).toEqual([root, a]);
  });

  it('still undoes a refused move when a concurrent move rewrote its ancestors, past the lease', async () => {
    const root = await rootId(ctx, admin);
    const a = await mkdir(ctx, admin, 'Undo A', root);
    const d = await mkdir(ctx, admin, 'Undo D', a);
    const b = await mkdir(ctx, admin, 'Undo B', root);
    const c = await mkdir(ctx, admin, 'Undo C', b);
    const service = ctx.app.get(FoldersService, { strict: false });
    const repository = ctx.app.get(FoldersRepository, { strict: false });
    let innerHeld = () => {};
    const held = new Promise<void>((resolve) => (innerHeld = resolve));
    let release = () => {};
    const released = new Promise<void>((resolve) => (release = resolve));
    let rewritten = () => {};
    const rewriteDone = new Promise<void>((resolve) => (rewritten = resolve));
    const updateMany = repository.updateMany.bind(repository);
    const holdRewrite = vi
      .spyOn(repository, 'updateMany')
      .mockImplementationOnce(async (...args) => {
        innerHeld();
        await released;
        const result = await updateMany(...args);
        rewritten();
        return result;
      });
    const updateOne = repository.updateOne.bind(repository);
    let undoSeen = false;
    const beforeUndo = vi.spyOn(repository, 'updateOne').mockImplementation(async (...args) => {
      const filter = args[1] as Record<string, unknown>;
      if (!undoSeen && !('deletedAt' in filter) && String(filter._id) === a) {
        undoSeen = true;
        release();
        await rewriteDone;
      }
      return updateOne(...args);
    });
    const assertNameFree = service.assertNameFree.bind(service);
    let inner: Promise<number> = Promise.resolve(0);
    const nameSpy = vi.spyOn(service, 'assertNameFree').mockImplementationOnce(async (...args) => {
      await expireMoveLease(admin);
      inner = as(ctx, member)
        .post(`/api/v1/folders/${b}/move`)
        .send({ parentId: d })
        .then((res) => res.status);
      await held;
      return assertNameFree(...args);
    });
    let outer: { status: number; body: { code?: string } };
    try {
      outer = await as(ctx, admin).post(`/api/v1/folders/${a}/move`).send({ parentId: c });
    } finally {
      release();
      nameSpy.mockRestore();
    }
    const innerStatus = await inner;
    holdRewrite.mockRestore();
    beforeUndo.mockRestore();
    expect(undoSeen).toBe(true);
    expect(innerStatus).toBe(200);
    expect(outer.status).toBe(409);
    expect(outer.body.code).toBe('FOLDER_MOVED_CONCURRENTLY');
    const crumbs = async (id: string) =>
      (await as(ctx, admin).get(`/api/v1/folders/${id}`).expect(200)).body.breadcrumbs.map(
        (x: { id: string }) => x.id,
      );
    expect(await crumbs(a)).toEqual([root, a]);
    expect(await crumbs(d)).toEqual([root, a, d]);
    expect(await crumbs(b)).toEqual([root, a, d, b]);
    expect(await crumbs(c)).toEqual([root, a, d, b, c]);
    const tree = (await as(ctx, admin).get('/api/v1/folders/tree').expect(200)).body as {
      id: string;
      parentId: string | null;
    }[];
    const parentOf = new Map(tree.map((f) => [f.id, f.parentId]));
    expect(parentOf.get(a)).toBe(root);
  });

  describe('per-tenant move lease', () => {
    it('refuses a second move in the same tenant while one runs, but not in another tenant', async () => {
      const root = await rootId(ctx, admin);
      const a = await mkdir(ctx, admin, 'Lease A', root);
      const b = await mkdir(ctx, admin, 'Lease B', root);
      const c = await mkdir(ctx, admin, 'Lease C', root);
      const third = await signUp(ctx, { tenantName: 'Third Co' });
      const otherRoot = await rootId(ctx, third);
      const otherFolder = await mkdir(ctx, third, 'Other lease', otherRoot);
      const otherTarget = await mkdir(ctx, third, 'Other target', otherRoot);
      const service = ctx.app.get(FoldersService, { strict: false });
      const assertNameFree = service.assertNameFree.bind(service);
      let inner: { status: number; body: { code?: string } } = { status: 0, body: {} };
      let otherTenant = 0;
      const spy = vi.spyOn(service, 'assertNameFree').mockImplementationOnce(async (...args) => {
        inner = await as(ctx, member).post(`/api/v1/folders/${c}/move`).send({ parentId: b });
        otherTenant = (
          await as(ctx, third)
            .post(`/api/v1/folders/${otherFolder}/move`)
            .send({ parentId: otherTarget })
        ).status;
        return assertNameFree(...args);
      });
      try {
        await as(ctx, admin).post(`/api/v1/folders/${a}/move`).send({ parentId: b }).expect(200);
      } finally {
        spy.mockRestore();
      }
      expect(inner.status).toBe(409);
      expect(inner.body.code).toBe('FOLDER_MOVE_IN_PROGRESS');
      expect(otherTenant).toBe(200);
      const crumbs = await as(ctx, admin).get(`/api/v1/folders/${c}`).expect(200);
      expect(crumbs.body.breadcrumbs.map((x: { id: string }) => x.id)).toEqual([root, c]);
      expect((await leaseOf(admin)).token).toBeNull();
      await as(ctx, member).post(`/api/v1/folders/${c}/move`).send({ parentId: b }).expect(200);
    });

    it('waits for a live lease but takes over one past its expiry', async () => {
      const root = await rootId(ctx, admin);
      const a = await mkdir(ctx, admin, 'Stale A', root);
      const b = await mkdir(ctx, admin, 'Stale B', root);
      await setLease(admin, 'live-lease', new Date(Date.now() + 20_000));
      const busy = await as(ctx, admin)
        .post(`/api/v1/folders/${a}/move`)
        .send({ parentId: b })
        .expect(409);
      expect(busy.body.code).toBe('FOLDER_MOVE_IN_PROGRESS');
      expect((await leaseOf(admin)).token).toBe('live-lease');
      await setLease(admin, 'stale-lease', new Date(Date.now() - 1_000));
      await as(ctx, admin).post(`/api/v1/folders/${a}/move`).send({ parentId: b }).expect(200);
      expect(await leaseOf(admin)).toEqual({ token: null, until: null });
    });

    it('does not release a lease another move has taken over', async () => {
      const root = await rootId(ctx, admin);
      const a = await mkdir(ctx, admin, 'Taken A', root);
      const b = await mkdir(ctx, admin, 'Taken B', root);
      const service = ctx.app.get(FoldersService, { strict: false });
      const assertNameFree = service.assertNameFree.bind(service);
      const spy = vi.spyOn(service, 'assertNameFree').mockImplementationOnce(async (...args) => {
        await setLease(admin, 'newer-move', new Date(Date.now() + 20_000));
        return assertNameFree(...args);
      });
      try {
        await as(ctx, admin).post(`/api/v1/folders/${a}/move`).send({ parentId: b }).expect(200);
      } finally {
        spy.mockRestore();
      }
      expect((await leaseOf(admin)).token).toBe('newer-move');
      await setLease(admin, 'released', new Date(0));
    });

    it('releases the lease after a refused or failed move', async () => {
      const root = await rootId(ctx, admin);
      const a = await mkdir(ctx, admin, 'Failing A', root);
      const b = await mkdir(ctx, admin, 'Failing B', root);
      const otherRoot = await rootId(ctx, other);
      await as(ctx, admin).post(`/api/v1/folders/${a}/move`).send({ parentId: a }).expect(400);
      await as(ctx, admin)
        .post(`/api/v1/folders/${a}/move`)
        .send({ parentId: otherRoot })
        .expect(404);
      expect((await leaseOf(admin)).token).toBeNull();
      const repository = ctx.app.get(FoldersRepository, { strict: false });
      const spy = vi
        .spyOn(repository, 'updateMany')
        .mockRejectedValueOnce(new Error('database went away'));
      try {
        await as(ctx, admin).post(`/api/v1/folders/${a}/move`).send({ parentId: b }).expect(500);
      } finally {
        spy.mockRestore();
      }
      expect((await leaseOf(admin)).token).toBeNull();
      await as(ctx, admin).post(`/api/v1/folders/${a}/move`).send({ parentId: root }).expect(200);
    });

    it('puts the folder back when rewriting its descendants fails, so their paths stay true', async () => {
      const root = await rootId(ctx, admin);
      const parent = await mkdir(ctx, admin, 'Rewrite parent', root);
      const moving = await mkdir(ctx, admin, 'Rewrite moving', parent);
      const child = await mkdir(ctx, admin, 'Rewrite child', moving);
      const target = await mkdir(ctx, admin, 'Rewrite target', root);
      const grantee = await addMember(ctx, admin);
      await grantAccess(ctx, admin, {
        userId: grantee.userId,
        targetType: 'folder',
        targetId: parent,
        level: 'view',
      });
      const repository = ctx.app.get(FoldersRepository, { strict: false });
      const spy = vi
        .spyOn(repository, 'updateMany')
        .mockRejectedValueOnce(new Error('database went away'));
      try {
        await as(ctx, admin)
          .post(`/api/v1/folders/${moving}/move`)
          .send({ parentId: target })
          .expect(500);
        expect(spy).toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
      const stored = async (id: string) => {
        const folder = await repository.findById(admin.tenantId, id);
        return {
          parentId: folder?.parentId?.toHexString() ?? null,
          ancestorIds: folder?.ancestorIds.map((a) => a.toHexString()),
        };
      };
      expect(await stored(moving)).toEqual({ parentId: parent, ancestorIds: [root, parent] });
      expect(await stored(child)).toEqual({
        parentId: moving,
        ancestorIds: [root, parent, moving],
      });
      const scope = await ctx.app.get(AccessService).scopeForUser(admin.tenantId, grantee.userId);
      const childDoc = await repository.findById(admin.tenantId, child);
      expect(childDoc && scope.levelOfFolder(childDoc)).toBe('view');
    });

    it('returns the move’s own result when releasing the lease fails', async () => {
      const root = await rootId(ctx, admin);
      const a = await mkdir(ctx, admin, 'Release A', root);
      const b = await mkdir(ctx, admin, 'Release B', root);
      const repository = ctx.app.get(FoldersRepository, { strict: false });
      const spy = vi
        .spyOn(repository, 'releaseMoveLease')
        .mockRejectedValueOnce(new Error('database went away'));
      try {
        const moved = await as(ctx, admin)
          .post(`/api/v1/folders/${a}/move`)
          .send({ parentId: b })
          .expect(200);
        expect(moved.body.parentId).toBe(b);
        const blocked = await as(ctx, admin)
          .post(`/api/v1/folders/${a}/move`)
          .send({ parentId: root })
          .expect(409);
        expect(blocked.body.code).toBe('FOLDER_MOVE_IN_PROGRESS');
      } finally {
        spy.mockRestore();
      }
      expect((await leaseOf(admin)).token).not.toBeNull();
      await expireMoveLease(admin);
      await as(ctx, admin).post(`/api/v1/folders/${a}/move`).send({ parentId: root }).expect(200);
    });

    it('still refuses a move whose target was trashed meanwhile, and puts the folder back', async () => {
      const root = await rootId(ctx, admin);
      const a = await mkdir(ctx, admin, 'Trash race A', root);
      const target = await mkdir(ctx, admin, 'Trash race target', root);
      const service = ctx.app.get(FoldersService, { strict: false });
      const assertNameFree = service.assertNameFree.bind(service);
      const spy = vi.spyOn(service, 'assertNameFree').mockImplementationOnce(async (...args) => {
        await as(ctx, member).delete(`/api/v1/folders/${target}`).expect(204);
        return assertNameFree(...args);
      });
      let res: { status: number; body: { code?: string } };
      try {
        res = await as(ctx, admin).post(`/api/v1/folders/${a}/move`).send({ parentId: target });
      } finally {
        spy.mockRestore();
      }
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('FOLDER_MOVED_CONCURRENTLY');
      const moved = await as(ctx, admin).get(`/api/v1/folders/${a}`).expect(200);
      expect(moved.body.breadcrumbs.map((x: { id: string }) => x.id)).toEqual([root, a]);
    });
  });

  it('isolates folders between tenants', async () => {
    const root = await rootId(ctx, admin);
    const secret = await mkdir(ctx, admin, 'Secret', root);
    await as(ctx, other).get(`/api/v1/folders/${secret}`).expect(404);
    await as(ctx, other)
      .post('/api/v1/folders')
      .send({ name: 'Intruder', parentId: secret })
      .expect(404);
    await as(ctx, other).patch(`/api/v1/folders/${secret}`).send({ name: 'Renamed' }).expect(404);
    await as(ctx, other)
      .post(`/api/v1/folders/${secret}/move`)
      .send({ parentId: secret })
      .expect(404);
    const otherTree = await as(ctx, other).get('/api/v1/folders/tree').expect(200);
    expect(otherTree.body.map((f: { name: string }) => f.name)).toEqual(['Repository']);
  });
});
