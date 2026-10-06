import type { ConfirmLabel, ReducedConfirmBlock } from '../blocks.js';
import type { AiPendingActionDocument } from '../data/ai-pending-action.schema.js';

export interface ActionView {
  id: string;
  tool: string;
  domain: string;
  status: string;
  preview: Record<string, unknown>;
  planId: string | null;
  step: number | null;
  dependsOn: string | null;
  needsFile: boolean;
  destructive: boolean;
  reviewEach: boolean;
  origin: 'user' | 'derived';
  confirmLabel: ConfirmLabel;
  result: Record<string, unknown> | null;
  errorCode: string | null;
  expiresAt: string;
  executingSince: string | null;
}

export function toActionView(action: AiPendingActionDocument, now: Date = new Date()): ActionView {
  const expired = action.status === 'pending' && action.expiresAt.getTime() <= now.getTime();
  return {
    id: action._id.toHexString(),
    tool: action.tool,
    domain: action.domain,
    status: expired ? 'expired' : action.status,
    preview: action.preview,
    planId: action.planId,
    step: action.step,
    dependsOn: action.dependsOn ? action.dependsOn.toHexString() : null,
    needsFile: action.needsFile,
    destructive: action.destructive,
    reviewEach: action.reviewEach,
    origin: action.origin,
    confirmLabel: action.confirmLabel,
    result: action.result,
    errorCode: action.errorCode,
    expiresAt: action.expiresAt.toISOString(),
    executingSince: action.executingSince ? action.executingSince.toISOString() : null,
  };
}

export function reducedPreview(
  preview: Record<string, unknown>,
  status: string,
): ReducedConfirmBlock {
  const flag = (key: string) => preview[key] !== false;
  return {
    kind: 'confirm',
    id: typeof preview['id'] === 'string' ? preview['id'] : '',
    actionId: typeof preview['actionId'] === 'string' ? preview['actionId'] : '',
    unavailable: true,
    status,
    confirmLabel: (preview['confirmLabel'] as ConfirmLabel | undefined) ?? 'confirm',
    destructive: flag('destructive'),
    needsFile: flag('needsFile'),
    reviewEach: flag('reviewEach'),
    origin: preview['origin'] === 'user' ? 'user' : 'derived',
  };
}

export function reducedActionView(view: ActionView): ActionView {
  const result = view.result ? { ...view.result } : null;
  if (result) delete result['name'];
  return {
    ...view,
    preview: reducedPreview(view.preview, view.status) as unknown as Record<string, unknown>,
    result,
  };
}

export function targetsVisible(
  targets: { records: string[]; folders: string[] } | undefined,
  visible: { records: ReadonlySet<string>; folders: ReadonlySet<string> },
): boolean {
  if (!targets) return true;
  return (
    targets.records.every((id) => visible.records.has(id)) &&
    targets.folders.every((id) => visible.folders.has(id))
  );
}
