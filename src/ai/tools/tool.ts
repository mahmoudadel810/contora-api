import { HttpException } from '@nestjs/common';
import type { z } from 'zod';
import type { Principal } from '../../auth/principal.js';
import type { AccessService } from '../../access/access.service.js';
import type { AdminService } from '../../admin/admin.service.js';
import type { ActivityReportService } from '../../audit/activity-report.service.js';
import type { AuditService } from '../../audit/audit.service.js';
import type { PolicyService } from '../../authorization/policy.service.js';
import type { BulkService } from '../../bulk/bulk.service.js';
import type { CommentsService } from '../../comments/comments.service.js';
import type { ContentTypesService } from '../../content-types/content-types.service.js';
import type { DashboardService } from '../../dashboard/dashboard.service.js';
import type { FoldersService } from '../../folders/folders.service.js';
import type { MembersService } from '../../members/members.service.js';
import type { MyRecordsService } from '../../my-records/my-records.service.js';
import type { RecordsService } from '../../records/records.service.js';
import type { RelationsService } from '../../relations/relations.service.js';
import type { SavedSearchesService } from '../../saved-searches/saved-searches.service.js';
import type { TrashService } from '../../trash/trash.service.js';
import { issuesOf } from '../../common/zod.pipe.js';
import type { BlockDraft } from '../blocks.js';
import type { PlannedAction, ProposalDraft, ProposedAction } from './proposal.js';

export const DOMAIN_NAMES = ['search', 'records', 'folders', 'schema', 'collab', 'admin'] as const;
export type DomainName = (typeof DOMAIN_NAMES)[number];

export interface ToolServices {
  records: RecordsService;
  folders: FoldersService;
  contentTypes: ContentTypesService;
  savedSearches: SavedSearchesService;
  myRecords: MyRecordsService;
  access: AccessService;
  trash: TrashService;
  bulk: BulkService;
  comments: CommentsService;
  relations: RelationsService;
  dashboard: DashboardService;
  admin: AdminService;
  audit: AuditService;
  activityReport: ActivityReportService;
  members: MembersService;
  policy: PolicyService;
}

export interface ToolContext {
  principal: Principal;
  signal: AbortSignal;
  sessionId: string;
  services: ToolServices;
  emit(block: BlockDraft): string | null;
  propose(draft: ProposalDraft): Promise<ProposedAction>;
  planned(actionId: string): PlannedAction | null;
}

export interface ToolOutput {
  data: unknown;
  blocks?: BlockDraft[];
}

export interface ToolDef<S extends z.ZodObject = z.ZodObject> {
  name: string;
  domain: DomainName;
  description: string;
  input: S;
  available?: (principal: Principal) => boolean;
  run(ctx: ToolContext, input: z.output<S>): Promise<ToolOutput>;
}

export function defineTool<S extends z.ZodObject>(def: ToolDef<S>): ToolDef<S> {
  return def;
}

export type ToolValue =
  | { ok: true; blockIds: string[]; data: unknown }
  | {
      ok: false;
      code: string;
      message: string;
      retry: 'no' | 'once';
      data?: { message?: string; details?: unknown };
    };

type Advice = { message: string; retry: 'no' | 'once' };

const ADVICE: Record<string, Advice> = {
  SEARCH_TIMEOUT: {
    message: 'The search took too long — narrow it (add a type, folder or tag)',
    retry: 'no',
  },
  NOT_FOUND: { message: 'Not found, or not visible to this user', retry: 'no' },
  FORBIDDEN: { message: 'This user is not allowed to do this', retry: 'no' },
  VALIDATION_FAILED: {
    message: 'Some values are not valid (see data.details); fix them or ask the user',
    retry: 'once',
  },
  RECORD_CHECKED_OUT: { message: 'Someone else has this record checked out', retry: 'no' },
  NOT_CHECKED_OUT: { message: 'The record is not checked out', retry: 'no' },
  NOTHING_TO_CHANGE: { message: 'This would change nothing', retry: 'no' },
  NOTHING_TO_VERSION: {
    message: 'A new version needs changed metadata or a new file',
    retry: 'no',
  },
  INVALID_REF: {
    message: 'A *Ref must be the actionId of an earlier proposal in this answer that creates it',
    retry: 'once',
  },
  NAME_TAKEN: { message: 'That name is already taken there', retry: 'no' },
  CONTENT_TYPE_ARCHIVED: { message: 'The content type is archived', retry: 'no' },
  ROOT_FOLDER: { message: 'The root folder cannot be changed like that', retry: 'no' },
  INVALID_MOVE: {
    message: 'A folder cannot be moved into itself or one of its subfolders',
    retry: 'no',
  },
  TOO_MANY_TAGS: { message: 'A record can have at most 20 tags', retry: 'no' },
  PLAN_TOO_LONG: { message: 'Too many changes in one answer; propose fewer', retry: 'no' },
  TURN_ABORTED: { message: 'The answer was stopped', retry: 'no' },
};

const REFUSED: Advice = { message: 'The request was refused (see code)', retry: 'no' };

export function failureValue(error: unknown): Extract<ToolValue, { ok: false }> {
  if (error instanceof HttpException) {
    const body = error.getResponse();
    const record =
      typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
    const code = typeof record['code'] === 'string' ? record['code'] : 'REQUEST_FAILED';
    const advice = ADVICE[code] ?? REFUSED;
    const data: { message?: string; details?: unknown } = {};
    if (typeof record['message'] === 'string') data.message = record['message'];
    if (record['details'] !== undefined) data.details = record['details'];
    return { ok: false, code, message: advice.message, retry: advice.retry, data };
  }
  return { ok: false, code: 'TOOL_FAILED', message: 'The tool failed unexpectedly', retry: 'once' };
}

export async function runTool(
  def: ToolDef,
  ctx: ToolContext,
  rawInput: unknown,
): Promise<ToolValue> {
  if (ctx.signal.aborted) {
    return { ok: false, code: 'TURN_ABORTED', ...ADVICE['TURN_ABORTED'] };
  }
  const parsed = def.input.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      code: 'VALIDATION_FAILED',
      message: 'The arguments do not match the tool schema',
      retry: 'once',
      data: { details: issuesOf(parsed.error) },
    };
  }
  try {
    const output = await def.run(ctx, parsed.data);
    const blockIds = (output.blocks ?? [])
      .map((block) => ctx.emit(block))
      .filter((id): id is string => id !== null);
    return { ok: true, blockIds, data: output.data };
  } catch (error) {
    return failureValue(error);
  }
}
