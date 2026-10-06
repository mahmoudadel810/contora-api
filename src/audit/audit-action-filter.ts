import { z } from 'zod';
import { AUDIT_ACTIONS, type AuditAction } from './audit-action.js';

export const MAX_ACTION_LIST_LENGTH = 1024;
export const MAX_ACTION_LIST_TOTAL_LENGTH = 2048;
export const MAX_ACTION_LIST_VALUES = 50;

const ActionSchema = z.enum(AUDIT_ACTIONS);

export const ActionListSchema = z
  .union([
    z.string().max(MAX_ACTION_LIST_LENGTH),
    z
      .array(z.string().max(MAX_ACTION_LIST_LENGTH))
      .max(MAX_ACTION_LIST_VALUES)
      .refine(
        (values) =>
          values.reduce((total, value) => total + value.length, 0) <= MAX_ACTION_LIST_TOTAL_LENGTH,
        `At most ${MAX_ACTION_LIST_TOTAL_LENGTH} characters in all`,
      ),
  ])
  .transform((raw, ctx): AuditAction[] => {
    const values = (Array.isArray(raw) ? raw : [raw]).flatMap((value) => value.split(','));
    const actions = new Set<AuditAction>();
    for (const value of values) {
      const parsed = ActionSchema.safeParse(value.trim());
      if (!parsed.success) {
        ctx.addIssue({
          code: 'custom',
          message: value.trim() === '' ? 'Empty action' : 'Unknown action',
        });
        return z.NEVER;
      }
      actions.add(parsed.data);
    }
    return [...actions];
  });

export interface ActionFilterInput {
  action?: AuditAction;
  actions?: readonly AuditAction[];
  excludeActions?: readonly AuditAction[];
}

export function resolveActions(input: ActionFilterInput): readonly AuditAction[] | null {
  const hasInclude = input.action !== undefined || input.actions !== undefined;
  const include = hasInclude
    ? new Set<AuditAction>([...(input.action ? [input.action] : []), ...(input.actions ?? [])])
    : null;
  const exclude = new Set(input.excludeActions ?? []);
  if (!include && exclude.size === 0) return null;
  const allowed = AUDIT_ACTIONS.filter(
    (action) => (include ? include.has(action) : true) && !exclude.has(action),
  );
  if (allowed.length === AUDIT_ACTIONS.length) return null;
  return allowed;
}
