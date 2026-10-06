import { HttpStatus } from '@nestjs/common';
import { z } from 'zod';
import type { AuditResource } from '../../audit/audit.service.js';
import type { Principal } from '../../auth/principal.js';
import { AppError, errors } from '../../common/errors.js';
import type { FieldDefinition } from '../../content-types/field-types.js';
import type { UploadedFile } from '../../storage/blobs.service.js';
import type { ActionOrigin, Change, ConfirmLabel } from '../blocks.js';
import { defineTool, type DomainName, type ToolContext, type ToolDef } from './tool.js';

export const ActionBaseSchema = z
  .object({
    versionNumber: z.number().int().positive().optional(),
    schemaVersion: z.number().int().positive().optional(),
    name: z.string().optional(),
    folderId: z.string().optional(),
    parentId: z.string().nullable().optional(),
  })
  .strict();
export type ActionBase = z.infer<typeof ActionBaseSchema>;

export interface Targets {
  records: string[];
  folders: string[];
}

export interface Preview<A> {
  args: A;
  base: ActionBase | null;
  title: string;
  summary: string;
  changes: Change[];
  targets: Targets;
  originIds?: string[];
  refs: string[];
  destructive: boolean;
  reviewEach: boolean;
  needsFile: boolean;
  creates?: string;
}

export interface ProposalDraft {
  tool: string;
  domain: DomainName;
  confirmLabel: ConfirmLabel;
  preview: Preview<unknown>;
}

export interface ProposedAction {
  actionId: string;
  origin: ActionOrigin;
  expiresAt: string;
}

export interface PlannedAction {
  id: string;
  tool: string;
  step: number;
  args: unknown;
  creates: string | null;
}

export type CheckContext = Pick<ToolContext, 'principal' | 'services' | 'planned'>;

export interface ExecuteContext {
  principal: Principal;
  services: ToolContext['services'];
  file: UploadedFile | null;
  resolved(actionId: string): string;
}

export interface ResourceResult {
  resourceType: string;
  id: string;
  name: string;
  link: string | null;
}

export interface BulkResult {
  resourceType: 'records';
  count: number;
  failed: Array<{ id: string; code: string }>;
}

export interface Executed {
  status: 'done' | 'partial';
  result: ResourceResult | BulkResult;
  resource: AuditResource | null;
  note: string;
  auditContext?: Record<string, unknown>;
}

export interface Proposal<S extends z.ZodObject = z.ZodObject, A = unknown> {
  tool: string;
  domain: DomainName;
  confirmLabel: ConfirmLabel;
  description: string;
  input: S;
  stored: z.ZodType<A>;
  available?: (principal: Principal) => boolean;
  check(ctx: CheckContext, input: z.output<S>): Promise<Preview<A>>;
  execute(ctx: ExecuteContext, args: A, base: ActionBase | null): Promise<Executed>;
}

export function defineProposal<S extends z.ZodObject, A>(proposal: Proposal<S, A>): Proposal {
  return proposal as unknown as Proposal;
}

export function proposalTool(proposal: Proposal): ToolDef {
  return defineTool({
    name: proposal.tool,
    domain: proposal.domain,
    description: proposal.description,
    input: proposal.input,
    ...(proposal.available ? { available: proposal.available } : {}),
    async run(ctx, input) {
      const preview = await proposal.check(ctx, input);
      if (ctx.signal.aborted) throw turnAborted();
      const action = await ctx.propose({
        tool: proposal.tool,
        domain: proposal.domain,
        confirmLabel: proposal.confirmLabel,
        preview,
      });
      return {
        data: {
          actionId: action.actionId,
          status: 'pending',
          title: preview.title,
          needsFile: preview.needsFile,
          destructive: preview.destructive,
          expiresAt: action.expiresAt,
          next: 'Nothing has changed yet. The user sees a card and confirms or cancels it. Tell them what you prepared; use actionId as a *Ref in a later proposal of this answer.',
        },
      };
    },
  }) as ToolDef;
}

export function turnAborted(): AppError {
  return errors.conflict('TURN_ABORTED', 'The answer was stopped');
}

export const StoredNameSchema = z.string().trim().min(1).max(200);
export const StoredCommentSchema = z.string().max(500);
export const StoredMetadataSchema = z
  .record(z.string().max(40), z.unknown())
  .refine((metadata) => Object.keys(metadata).length <= 50, 'At most 50 metadata keys')
  .default({});

export function staleError(): AppError {
  return new AppError(
    HttpStatus.CONFLICT,
    'ACTION_STALE',
    'It changed since I prepared this — ask again',
  );
}

export function nothingToChange(message: string): AppError {
  return errors.badRequest('NOTHING_TO_CHANGE', message);
}

export function assertBase<K extends keyof ActionBase>(
  base: ActionBase | null,
  key: K,
  current: ActionBase[K],
): void {
  if (base && base[key] !== undefined && base[key] !== current) throw staleError();
}

export function idOrRef(
  idKey: string,
  refKey: string,
  id: string | null,
  ref: string | null,
): { id: string; ref: null } | { id: null; ref: string } {
  if (id !== null && ref === null) return { id, ref: null };
  if (id === null && ref !== null) return { id: null, ref };
  throw errors.validation([{ path: idKey, message: `Give exactly one of ${idKey} and ${refKey}` }]);
}

export function plannedRef(
  ctx: Pick<CheckContext, 'planned'>,
  ref: string,
  tools: readonly string[],
): PlannedAction {
  const planned = ctx.planned(ref);
  if (!planned || !tools.includes(planned.tool)) {
    throw errors.badRequest(
      'INVALID_REF',
      `A *Ref must be the actionId of an earlier proposal in this answer made by ${tools.join(' or ')}`,
    );
  }
  return planned;
}

export function assertNotHeldByOther(
  principal: Principal,
  record: { checkedOutBy: { equals(id: string): boolean } | null; checkedOutByName: string | null },
): void {
  if (record.checkedOutBy && !record.checkedOutBy.equals(principal.userId)) {
    throw errors.conflict(
      'RECORD_CHECKED_OUT',
      `This record is checked out by ${record.checkedOutByName ?? 'another user'}`,
    );
  }
}

export const MetadataPairsSchema = z
  .array(
    z
      .object({
        key: z.string().min(1).max(40),
        value: z.string().max(20000).nullable(),
      })
      .strict(),
  )
  .max(50)
  .nullable();
export type MetadataPairs = z.output<typeof MetadataPairsSchema>;

const TRUE = new Set(['true', 'yes', '1']);
const FALSE = new Set(['false', 'no', '0']);

function coerceValue(field: FieldDefinition | undefined, raw: string): unknown {
  const text = raw.trim();
  switch (field?.type) {
    case 'number':
    case 'currency':
    case 'percentage': {
      const number = Number(text);
      return text !== '' && Number.isFinite(number) ? number : raw;
    }
    case 'boolean': {
      const lower = text.toLowerCase();
      if (TRUE.has(lower)) return true;
      if (FALSE.has(lower)) return false;
      return raw;
    }
    case 'multiselect':
    case 'checkboxes': {
      if (text.startsWith('[')) {
        try {
          const parsed = JSON.parse(text) as unknown;
          if (Array.isArray(parsed)) return parsed;
        } catch {}
      }
      return text
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part !== '');
    }
    default:
      return raw;
  }
}

export function metadataDelta(
  fields: readonly FieldDefinition[],
  pairs: MetadataPairs,
): Record<string, unknown> {
  const byKey = new Map(fields.map((field) => [field.key, field]));
  const delta: Record<string, unknown> = {};
  for (const { key, value } of pairs ?? []) {
    delta[key] = value === null || value.trim() === '' ? null : coerceValue(byKey.get(key), value);
  }
  return delta;
}

export function mergeMetadata(
  current: Record<string, unknown>,
  delta: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(delta)) {
    if (value === null) delete merged[key];
    else merged[key] = value;
  }
  return merged;
}

export function changesMetadata(
  current: Record<string, unknown>,
  delta: Record<string, unknown>,
): boolean {
  return Object.entries(delta).some(([key, value]) =>
    value === null
      ? Object.hasOwn(current, key)
      : JSON.stringify(current[key]) !== JSON.stringify(value),
  );
}

export function pathOf(crumbs: ReadonlyArray<{ name: string }>): string {
  return crumbs.map((crumb) => crumb.name).join(' / ');
}

export function shown(value: string | null | undefined): string | null {
  return value === undefined || value === null || value === '' ? null : value;
}
