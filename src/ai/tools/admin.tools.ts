import { z } from 'zod';
import { AUDIT_ACTIONS } from '../../audit/audit-action.js';
import { ActivityReportQuerySchema } from '../../audit/activity-report.service.js';
import { AuditListQuerySchema, type AuditEntryView } from '../../audit/audit.service.js';
import { parseWith } from '../../common/zod.pipe.js';
import { notice, type BlockDraft } from '../blocks.js';
import { MODEL_ROWS, objectId } from './search.tools.js';
import { defineTool, type ToolDef } from './tool.js';

const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/g;

export function withoutEmails(text: string | null | undefined): string | null {
  return text === null || text === undefined ? null : text.replace(EMAIL, '[email]');
}

const adminScope = { domain: 'admin' } as const;

export const MAX_TABLE_ROWS = 50;

function table(title: string, columns: string[], rows: string[][], truncated = false): BlockDraft {
  return {
    kind: 'table',
    title,
    columns,
    rows: rows.slice(0, MAX_TABLE_ROWS),
    truncated: truncated || rows.length > MAX_TABLE_ROWS,
    scope: adminScope,
  };
}

export function auditRow(entry: AuditEntryView) {
  return {
    id: entry.id,
    action: entry.action,
    at: entry.createdAt,
    by: entry.actor ? { id: entry.actor.id, name: withoutEmails(entry.actor.displayName) } : null,
    resource: entry.resource
      ? {
          type: entry.resource.type,
          id: entry.resource.id ?? null,
          label: withoutEmails(entry.resource.label),
        }
      : null,
  };
}

const adminGetDashboard = defineTool({
  name: 'admin_get_dashboard',
  domain: 'admin',
  description:
    'The workspace dashboard counts: records, versions, folders, types, members, trash, storage.',
  input: z.object({}).strict(),
  async run(ctx) {
    const summary = await ctx.services.dashboard.summary(ctx.principal);
    const rows = Object.entries(summary.counts).map(([name, count]) => [name, String(count)]);
    if (summary.storage) {
      rows.push(['storedBytes', String(summary.storage.storedBytes)]);
      rows.push(['storedFiles', String(summary.storage.storedFiles)]);
    }
    return {
      data: { counts: summary.counts, storage: summary.storage },
      blocks: [table('Workspace', ['Item', 'Count'], rows)],
    };
  },
});

const adminGetOverview = defineTool({
  name: 'admin_get_overview',
  domain: 'admin',
  description:
    'The admin overview: members by status, pending invitations, records, folders, content types, storage and security counts of the last 7 days.',
  input: z.object({}).strict(),
  async run(ctx) {
    const overview = await ctx.services.admin.overview(ctx.principal);
    const { recent: _recent, ...security } = overview.security;
    const data = {
      generatedAt: overview.generatedAt,
      members: overview.members,
      invitations: overview.invitations,
      records: overview.records,
      folders: overview.folders,
      contentTypes: overview.contentTypes,
      storage: overview.storage,
      security,
    };
    const rows: string[][] = [
      ['Active members', String(overview.members.active)],
      ['Suspended members', String(overview.members.suspended)],
      ['Active admins', String(overview.members.activeAdmins)],
      ['Pending invitations', String(overview.invitations.pending)],
      ['Live records', String(overview.records.live)],
      ['Trashed records', String(overview.records.trashed)],
      ['Records created (7 days)', String(overview.records.createdLast7Days)],
      ['Failed sign-ins (7 days)', String(overview.security.last7Days.signInFailed)],
      ['Access denied (7 days)', String(overview.security.last7Days.accessDenied)],
    ];
    return { data, blocks: [table('Admin overview', ['Item', 'Count'], rows)] };
  },
});

const adminSearchAudit = defineTool({
  name: 'admin_search_audit',
  domain: 'admin',
  description:
    'Search the audit log by action, actor id, resource type or id and a date range (ISO dates); 20 rows per page, newest first.',
  input: z
    .object({
      action: z.enum(AUDIT_ACTIONS).nullable(),
      actorId: objectId.nullable(),
      resourceType: z.string().max(40).nullable(),
      resourceId: objectId.nullable(),
      from: z.string().max(40).nullable(),
      to: z.string().max(40).nullable(),
      page: z.number().int().min(1).max(500).nullable(),
    })
    .strict(),
  async run(ctx, input) {
    const query = parseWith(AuditListQuerySchema, {
      ...(input.action ? { action: input.action } : {}),
      ...(input.actorId ? { actorId: input.actorId } : {}),
      ...(input.resourceType ? { resourceType: input.resourceType } : {}),
      ...(input.resourceId ? { resourceId: input.resourceId } : {}),
      ...(input.from ? { from: input.from } : {}),
      ...(input.to ? { to: input.to } : {}),
      page: String(input.page ?? 1),
      pageSize: String(MODEL_ROWS),
    });
    const page = await ctx.services.audit.list(ctx.principal, query);
    const rows = page.items.map(auditRow);
    return {
      data: {
        total: page.total,
        page: page.page,
        truncated: page.total > page.page * MODEL_ROWS,
        items: rows,
      },
      blocks:
        rows.length === 0
          ? [notice('No audit entries matched.')]
          : [
              table(
                'Audit log',
                ['When', 'Action', 'By', 'Resource'],
                page.items.map((entry) => [
                  entry.createdAt,
                  entry.action,
                  entry.actor?.displayName ?? '',
                  entry.resource?.label ?? entry.resource?.type ?? '',
                ]),
                page.total > page.page * MODEL_ROWS,
              ),
            ],
    };
  },
});

const adminGetActivityReport = defineTool({
  name: 'admin_get_activity_report',
  domain: 'admin',
  description:
    'Tenant activity over whole UTC days (YYYY-MM-DD, default the last 30 days): totals, per day, per action and the most active users.',
  input: z
    .object({
      from: z.string().max(10).nullable(),
      to: z.string().max(10).nullable(),
    })
    .strict(),
  async run(ctx, input) {
    const report = await ctx.services.activityReport.report(
      ctx.principal,
      parseWith(ActivityReportQuerySchema, {
        ...(input.from ? { from: input.from } : {}),
        ...(input.to ? { to: input.to } : {}),
      }),
    );
    return {
      data: {
        from: report.from,
        to: report.to,
        total: report.total,
        denied: report.denied,
        byAction: report.byAction.slice(0, MODEL_ROWS),
        topUsers: report.topUsers.slice(0, MODEL_ROWS).map((user) => ({
          id: user.id,
          name: withoutEmails(user.displayName),
          count: user.count,
        })),
      },
      blocks: [
        table(
          `Activity ${report.from} – ${report.to}`,
          ['Action', 'Count'],
          report.byAction.slice(0, MODEL_ROWS).map((row) => [row.action, String(row.count)]),
          report.byAction.length > MODEL_ROWS,
        ),
      ],
    };
  },
});

const adminListMembers = defineTool({
  name: 'admin_list_members',
  domain: 'admin',
  description: 'The members of the workspace: name, role and status (no email addresses).',
  input: z.object({}).strict(),
  async run(ctx) {
    const members = await ctx.services.members.list(ctx.principal);
    return {
      data: {
        total: members.length,
        truncated: members.length > MODEL_ROWS,
        items: members.slice(0, MODEL_ROWS).map((member) => ({
          id: member.id,
          name: withoutEmails(member.displayName),
          role: member.role,
          status: member.status,
        })),
      },
      blocks: [
        table(
          'Members',
          ['Name', 'Email', 'Role', 'Status'],
          members.map((member) => [member.displayName, member.email, member.role, member.status]),
        ),
      ],
    };
  },
});

const adminListTrash = defineTool({
  name: 'admin_list_trash',
  domain: 'admin',
  description: 'What is in the trash: folders (with their counts) and records, newest first.',
  input: z.object({}).strict(),
  async run(ctx) {
    const trash = await ctx.services.trash.list(ctx.principal);
    const folders = trash.folders.map((folder) => ({
      kind: 'folder',
      id: folder.id,
      name: folder.name,
      deletedAt: folder.deletedAt,
      deletedBy: withoutEmails(folder.deletedBy?.displayName),
      contains: { folders: folder.folderCount, records: folder.recordCount },
    }));
    const records = trash.records
      .filter((record) => !record.trashedWithFolder)
      .map((record) => ({
        kind: 'record',
        id: record.id,
        name: record.name,
        deletedAt: record.deletedAt,
        deletedBy: withoutEmails(record.deletedBy?.displayName),
      }));
    const items = [...folders, ...records];
    return {
      data: {
        total: items.length,
        truncated: items.length > MODEL_ROWS,
        items: items.slice(0, MODEL_ROWS),
      },
      blocks:
        items.length === 0
          ? [notice('The trash is empty.')]
          : [
              table(
                'Trash',
                ['Kind', 'Name', 'Deleted', 'By'],
                items.map((item) => [item.kind, item.name, item.deletedAt, item.deletedBy ?? '']),
              ),
            ],
    };
  },
});

export const ADMIN_TOOLS: ToolDef[] = [
  adminGetDashboard,
  adminGetOverview,
  adminSearchAudit,
  adminGetActivityReport,
  adminListMembers,
  adminListTrash,
] as ToolDef[];
