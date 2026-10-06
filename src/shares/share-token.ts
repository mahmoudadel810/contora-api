import { createHash, randomBytes } from 'node:crypto';

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function newSecret(): string {
  return randomBytes(32).toString('base64url');
}

export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

export function parseShareToken(value: unknown): string | null {
  return typeof value === 'string' && TOKEN_PATTERN.test(value) ? value : null;
}

export function shareUrlOf(frontendUrl: string, token: string): string {
  return `${frontendUrl.replace(/\/+$/, '')}/s#${token}`;
}
