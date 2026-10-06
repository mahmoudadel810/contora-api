export const ROLES = ['admin', 'member'] as const;
export type Role = (typeof ROLES)[number];
