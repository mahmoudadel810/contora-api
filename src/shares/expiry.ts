import { errors } from '../common/errors.js';

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

export const MAX_EXPIRY_DAYS = 90;
export const EXPIRY_SLACK_MS = MINUTE_MS;
export const MAX_ACTIVE_LINKS = 20;

export const LOCK_THRESHOLD = 10;
export const LOCK_WINDOW_MS = 15 * MINUTE_MS;
export const LOCK_MS = 15 * MINUTE_MS;
export const PROOF_TTL_MS = 30 * MINUTE_MS;
export const MAX_PROOFS = 20;
export const REFUSED_AUDIT_INTERVAL_MS = 15 * MINUTE_MS;

export function validateExpiry(expiresAt: Date, now: Date): Date {
  const at = expiresAt.getTime();
  const latest = now.getTime() + MAX_EXPIRY_DAYS * DAY_MS + EXPIRY_SLACK_MS;
  if (!Number.isFinite(at) || at <= now.getTime() || at > latest) {
    throw errors.badRequest(
      'SHARE_LINK_EXPIRY_INVALID',
      `A share link must expire in the future and within ${MAX_EXPIRY_DAYS} days`,
    );
  }
  return expiresAt;
}
