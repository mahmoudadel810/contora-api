import { HttpException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { Principal } from '../../auth/principal.js';
import { can, type Action } from '../../authorization/policy.js';
import { errors } from '../../common/errors.js';
import type { BlockDraft } from '../blocks.js';
import { adminProposeRestore } from './admin.proposals.js';
import { ADMIN_TOOLS, auditRow, MAX_TABLE_ROWS, withoutEmails } from './admin.tools.js';
import type { ExecuteContext } from './proposal.js';
import { runTool, type ToolContext, type ToolDef, type ToolServices } from './tool.js';

const RECORD = 'a'.repeat(24);
const FOLDER = 'b'.repeat(24);
const EMAIL = 'carol.secret@example.test';

const admin: Principal = {
  userId: '9'.repeat(24),
  tenantId: '8'.repeat(24),
  role: 'admin',
  email: 'admin@example.test',
  displayName: 'Admin',
};

function fakeServices() {
  return {
    members: {
      list: vi.fn(async () => [
        {
          id: '1'.repeat(24),
          email: EMAIL,
          displayName: 'Carol',
          role: 'member',
          status: 'active',
          createdAt: 't',
        },
      ]),
    },
    audit: {
      list: vi.fn(async () => ({
        items: [
          {
            id: '2'.repeat(24),
            action: 'MEMBER_ROLE_CHANGED',
            actor: { id: admin.userId, email: 'admin@example.test', displayName: 'Admin' },
            resource: { type: 'user', id: '1'.repeat(24), label: EMAIL },
            context: { email: EMAIL, previousRole: 'admin' },
            createdAt: 't',
          },
        ],
        total: 1,
        page: 1,
        pageSize: 20,
      })),
    },
    trash: {
      list: vi.fn(async () => ({
        folders: [
          {
            id: FOLDER,
            name: 'Old folder',
            deletedAt: 't',
            deletedBy: { id: 'x', displayName: 'Admin' },
            folderCount: 1,
            recordCount: 2,
          },
        ],
        records: [
          {
            id: RECORD,
            name: 'Old record',
            deletedAt: 't',
            deletedBy: null,
            trashedWithFolder: false,
          },
          {
            id: '3'.repeat(24),
            name: 'Inside the folder',
            deletedAt: 't',
            deletedBy: null,
            trashedWithFolder: true,
          },
        ],
      })),
      restoreRecord: vi.fn(async (_p: Principal, id: string) => ({ id, name: 'Old record' })),
      restoreFolder: vi.fn(async () => undefined),
    },
    access: {
      requireRecord: vi.fn(async (_p: Principal, id: string) => ({ id, name: 'Old record' })),
      requireFolder: vi.fn(async (_p: Principal, id: string) => ({ id, name: 'Old folder' })),
    },
    policy: {
      authorize: vi.fn(async (p: Principal, action: Action) => {
        if (!can(p, action)) throw errors.forbidden();
      }),
    },
  };
}

type Fakes = ReturnType<typeof fakeServices>;

function toolCtx(services: Fakes, emitted: BlockDraft[]): ToolContext {
  return {
    principal: admin,
    services: services as unknown as ToolServices,
    signal: new AbortController().signal,
    sessionId: '1'.repeat(24),
    emit: (block) => {
      emitted.push(block);
      return `b${emitted.length}`;
    },
    propose: () => Promise.reject(new Error('not here')),
    planned: () => null,
  };
}

const tool = (name: string) => ADMIN_TOOLS.find((candidate) => candidate.name === name) as ToolDef;

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HttpException) return (error.getResponse() as { code: string }).code;
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('admin tools never give the model an email', () => {
  it('masks email-shaped text', () => {
    expect(withoutEmails(`role of ${EMAIL} changed`)).toBe('role of [email] changed');
    expect(withoutEmails(null)).toBeNull();
  });

  it('lists members by name, role and status; the admin-scoped table may show the address', async () => {
    const emitted: BlockDraft[] = [];
    const value = await runTool(tool('admin_list_members'), toolCtx(fakeServices(), emitted), {});
    expect(JSON.stringify(value)).not.toContain(EMAIL);
    expect(value).toMatchObject({
      ok: true,
      data: { items: [{ name: 'Carol', role: 'member', status: 'active' }] },
    });
    expect(emitted[0]).toMatchObject({ kind: 'table', scope: { domain: 'admin' } });
  });

  it('searches the audit log without context or addresses for the model', async () => {
    const services = fakeServices();
    const value = await runTool(tool('admin_search_audit'), toolCtx(services, []), {
      action: 'MEMBER_ROLE_CHANGED',
      actorId: null,
      resourceType: null,
      resourceId: null,
      from: null,
      to: null,
      page: null,
    });
    expect(services.audit.list).toHaveBeenCalledWith(
      admin,
      expect.objectContaining({ action: 'MEMBER_ROLE_CHANGED', page: 1, pageSize: 20 }),
    );
    expect(JSON.stringify(value)).not.toContain(EMAIL);
    expect(JSON.stringify(value)).not.toContain('previousRole');
    expect(auditRow((await services.audit.list()).items[0] as never)).toMatchObject({
      by: { name: 'Admin' },
      resource: { label: '[email]' },
    });
  });

  it('lists the trash without the records trashed with a folder', async () => {
    const value = await runTool(tool('admin_list_trash'), toolCtx(fakeServices(), []), {});
    expect(value).toMatchObject({
      ok: true,
      data: {
        total: 2,
        items: [
          { kind: 'folder', id: FOLDER },
          { kind: 'record', id: RECORD },
        ],
      },
    });
  });
});

describe('admin_propose_restore', () => {
  const executeCtx = (services: Fakes, principal = admin): ExecuteContext => ({
    principal,
    services: services as unknown as ToolServices,
    file: null,
    resolved: () => {
      throw new Error('no refs');
    },
  });
  const checkCtx = (services: Fakes, principal = admin) => ({
    principal,
    services: services as unknown as ToolServices,
    planned: () => null,
  });

  it('is for admins only and checks the item is in the trash', async () => {
    expect(adminProposeRestore.available?.({ ...admin, role: 'member' })).toBe(false);
    const services = fakeServices();
    const preview = await adminProposeRestore.check(checkCtx(services), {
      kind: 'record',
      id: RECORD,
    });
    expect(services.policy.authorize).toHaveBeenCalledWith(admin, 'admin.overview', {
      type: 'record',
      id: RECORD,
    });
    expect(services.access.requireRecord).toHaveBeenCalledWith(admin, RECORD, 'edit', {
      trashed: true,
    });
    expect(preview).toMatchObject({
      title: 'Restore record “Old record”',
      destructive: false,
      targets: { records: [], folders: [] },
      originIds: [RECORD],
    });
    expect(
      await codeOf(
        adminProposeRestore.check(checkCtx(services), { kind: 'record', id: '3'.repeat(24) }),
      ),
    ).toBe('RESTORE_WITH_FOLDER');
    expect(
      await codeOf(
        adminProposeRestore.check(checkCtx(services, { ...admin, role: 'member' }), {
          kind: 'record',
          id: RECORD,
        }),
      ),
    ).toBe('FORBIDDEN');
  });

  it('restores through TrashService', async () => {
    const services = fakeServices();
    const record = await adminProposeRestore.execute(
      executeCtx(services),
      { kind: 'record', id: RECORD },
      null,
    );
    expect(services.trash.restoreRecord).toHaveBeenCalledWith(admin, RECORD);
    expect(record.result).toMatchObject({ link: `/records/${RECORD}` });
    await adminProposeRestore.execute(executeCtx(services), { kind: 'folder', id: FOLDER }, null);
    expect(services.trash.restoreFolder).toHaveBeenCalledWith(admin, FOLDER);
  });

  it('re-gates the confirm: admin.overview first, Edit in the trash, not trashed with a folder', async () => {
    const services = fakeServices();
    const member: Principal = { ...admin, role: 'member' };
    expect(
      await codeOf(
        adminProposeRestore.execute(
          executeCtx(services, member),
          { kind: 'record', id: RECORD },
          null,
        ),
      ),
    ).toBe('FORBIDDEN');
    expect(services.policy.authorize).toHaveBeenCalledWith(member, 'admin.overview', {
      type: 'record',
      id: RECORD,
    });
    expect(services.access.requireRecord).not.toHaveBeenCalled();
    expect(services.trash.restoreRecord).not.toHaveBeenCalled();

    expect(
      await codeOf(
        adminProposeRestore.execute(
          executeCtx(services),
          { kind: 'record', id: '3'.repeat(24) },
          null,
        ),
      ),
    ).toBe('RESTORE_WITH_FOLDER');
    expect(services.access.requireRecord).toHaveBeenCalledWith(admin, '3'.repeat(24), 'edit', {
      trashed: true,
    });
    expect(services.trash.restoreRecord).not.toHaveBeenCalled();
  });
});

describe('admin table blocks', () => {
  it(`show at most ${MAX_TABLE_ROWS} rows and say truncated beyond`, async () => {
    const services = fakeServices();
    const many = Array.from({ length: MAX_TABLE_ROWS + 10 }, (_, index) => ({
      id: index.toString(16).padStart(24, '0'),
      email: `person${index}@example.test`,
      displayName: `Person ${index}`,
      role: 'member',
      status: 'active',
      createdAt: 't',
    }));
    services.members.list.mockResolvedValueOnce(many);
    const emitted: BlockDraft[] = [];
    await runTool(tool('admin_list_members'), toolCtx(services, emitted), {});
    expect(emitted[0]).toMatchObject({ kind: 'table', truncated: true });
    expect((emitted[0] as { rows: string[][] }).rows).toHaveLength(MAX_TABLE_ROWS);

    const few: BlockDraft[] = [];
    await runTool(tool('admin_list_members'), toolCtx(fakeServices(), few), {});
    expect(few[0]).toMatchObject({ kind: 'table', truncated: false });
  });
});

describe('admin summaries', () => {
  const entry = {
    id: '4'.repeat(24),
    action: 'SIGN_IN_FAILED',
    actor: { id: 'x', email: EMAIL, displayName: 'Carol' },
    resource: null,
    context: { email: EMAIL },
    createdAt: 't',
  };
  const summaries = {
    dashboard: {
      summary: vi.fn(async () => ({
        counts: { records: 3, versions: 4, folders: 2, contentTypes: 1, members: 2, trashed: 0 },
        storage: { storedBytes: 10, storedFiles: 1, versionBytes: 10 },
        myCheckouts: [],
        recentRecords: [],
        recentActivity: [entry],
        activityScope: 'tenant',
      })),
    },
    admin: {
      overview: vi.fn(async () => ({
        generatedAt: 't',
        members: { active: 2, suspended: 0, removed: 0, activeAdmins: 1 },
        invitations: { pending: 0 },
        records: { live: 3, trashed: 0, createdLast7Days: 3, createdLast30Days: 3 },
        folders: { live: 2, trashed: 0 },
        contentTypes: { active: 1, archived: 0 },
        storage: { bytes: 10, files: 1 },
        security: {
          last7Days: { signInFailed: 1, accessDenied: 0, tokenReuse: 0 },
          recent: [entry],
        },
      })),
    },
    activityReport: {
      report: vi.fn(async () => ({
        from: '2026-09-01',
        to: '2026-09-30',
        total: 5,
        denied: 1,
        perDay: [],
        byAction: [{ action: 'RECORD_CREATED', count: 5 }],
        topUsers: [{ id: 'x', displayName: `Carol <${EMAIL}>`, count: 5 }],
      })),
    },
  };

  const ctxWith = (emitted: BlockDraft[]) =>
    ({
      ...toolCtx(fakeServices(), emitted),
      services: summaries as unknown as ToolServices,
    }) as ToolContext;

  it('sends counts only: no recent activity, no security entries, no addresses', async () => {
    for (const name of ['admin_get_dashboard', 'admin_get_overview']) {
      const emitted: BlockDraft[] = [];
      const value = await runTool(tool(name), ctxWith(emitted), {});
      expect(value.ok, name).toBe(true);
      expect(JSON.stringify(value), name).not.toContain(EMAIL);
      expect(JSON.stringify(value), name).not.toContain('SIGN_IN_FAILED');
      expect(emitted[0], name).toMatchObject({ kind: 'table', scope: { domain: 'admin' } });
      expect(JSON.stringify(emitted), name).not.toContain(EMAIL);
    }
  });

  it('reports activity with top users by masked name', async () => {
    const emitted: BlockDraft[] = [];
    const value = await runTool(tool('admin_get_activity_report'), ctxWith(emitted), {
      from: '2026-09-01',
      to: null,
    });
    expect(summaries.activityReport.report).toHaveBeenCalledWith(admin, { from: '2026-09-01' });
    expect(value).toMatchObject({
      ok: true,
      data: { total: 5, topUsers: [{ id: 'x', name: 'Carol [email]', count: 5 }] },
    });
    expect(JSON.stringify(value)).not.toContain(EMAIL);
    expect(emitted[0]).toMatchObject({ kind: 'table', scope: { domain: 'admin' } });
  });
});
