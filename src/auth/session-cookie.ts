import type { Request, Response } from 'express';
import type { AppConfig } from '../config/env.js';
import type { IssuedRefreshToken } from './tokens.service.js';

export const REFRESH_COOKIE = 'mecm_refresh';
export const REFRESH_COOKIE_PATH = '/api/v1/auth';

export function setRefreshCookie(
  response: Response,
  refresh: IssuedRefreshToken,
  config: AppConfig,
): void {
  response.cookie(REFRESH_COOKIE, refresh.token, {
    httpOnly: true,
    secure: config.COOKIE_SECURE,
    sameSite: 'lax',
    path: REFRESH_COOKIE_PATH,
    expires: refresh.expiresAt,
  });
}

export function clearRefreshCookie(response: Response, config: AppConfig): void {
  response.clearCookie(REFRESH_COOKIE, {
    httpOnly: true,
    secure: config.COOKIE_SECURE,
    sameSite: 'lax',
    path: REFRESH_COOKIE_PATH,
  });
}

export function readRefreshCookie(request: Request): string | undefined {
  const cookies = request.cookies as Record<string, unknown> | undefined;
  const value = cookies?.[REFRESH_COOKIE];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
