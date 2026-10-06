import type { Request } from 'express';

export const MAX_USER_AGENT_LENGTH = 200;

export function cleanUserAgent(raw: unknown): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return null;
  const cleaned = value
    .replace(/\p{Cf}/gu, '')
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_USER_AGENT_LENGTH)
    .trim();
  return cleaned.length > 0 ? cleaned : null;
}

export function userAgentOf(request: Pick<Request, 'headers'>): string | null {
  return cleanUserAgent(request.headers['user-agent']);
}
