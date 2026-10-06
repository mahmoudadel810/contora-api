import type { Principal } from '../auth/principal.js';

export const ACTIONS = [
  'tenant.update',
  'members.read',
  'members.manage',
  'invitations.manage',
  'contentTypes.read',
  'contentTypes.manage',
  'folders.read',
  'folders.write',
  'folders.trash',
  'records.read',
  'records.write',
  'records.trash',
  'records.checkout',
  'records.forceRelease',
  'trash.read',
  'trash.purge',
  'audit.read',
  'audit.readAll',
  'comments.moderate',
  'admin.overview',
  'sessions.manage',
  'access.manage',
  'shareLinks.create',
  'shareLinks.revokeOwn',
  'shareLinks.manageAll',
] as const;

export type Action = (typeof ACTIONS)[number];

const MEMBER_ACTIONS: ReadonlySet<Action> = new Set<Action>([
  'contentTypes.read',
  'folders.read',
  'folders.write',
  'folders.trash',
  'records.read',
  'records.write',
  'records.trash',
  'records.checkout',
  'trash.read',
  'shareLinks.create',
  'shareLinks.revokeOwn',
]);

export function can(principal: Pick<Principal, 'role'>, action: Action): boolean {
  return principal.role === 'admin' || MEMBER_ACTIONS.has(action);
}

export function activityScope(principal: Pick<Principal, 'role'>): 'tenant' | 'own' {
  return can(principal, 'audit.readAll') ? 'tenant' : 'own';
}
