import { HttpException } from '@nestjs/common';
import { EXPIRY_SLACK_MS, MAX_EXPIRY_DAYS, validateExpiry } from './expiry.js';

const NOW = new Date('2026-09-30T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (error) {
    if (!(error instanceof HttpException)) throw error;
    return (error.getResponse() as { code: string }).code;
  }
}

describe('validateExpiry', () => {
  it('accepts the presets and a custom date up to 90 days', () => {
    for (const days of [1, 7, 30, 90]) {
      const at = new Date(NOW.getTime() + days * DAY);
      expect(validateExpiry(at, NOW)).toEqual(at);
    }
    expect(MAX_EXPIRY_DAYS).toBe(90);
  });

  it('allows a client clock up to 60 s ahead at the 90-day ceiling', () => {
    expect(EXPIRY_SLACK_MS).toBe(60_000);
    const edge = new Date(NOW.getTime() + 90 * DAY + 60_000);
    expect(validateExpiry(edge, NOW)).toEqual(edge);
    expect(codeOf(() => validateExpiry(new Date(edge.getTime() + 1), NOW))).toBe(
      'SHARE_LINK_EXPIRY_INVALID',
    );
    expect(codeOf(() => validateExpiry(new Date(NOW.getTime() + 91 * DAY), NOW))).toBe(
      'SHARE_LINK_EXPIRY_INVALID',
    );
  });

  it('refuses an expiry that is not in the future', () => {
    expect(codeOf(() => validateExpiry(NOW, NOW))).toBe('SHARE_LINK_EXPIRY_INVALID');
    expect(codeOf(() => validateExpiry(new Date(NOW.getTime() - DAY), NOW))).toBe(
      'SHARE_LINK_EXPIRY_INVALID',
    );
    const soon = new Date(NOW.getTime() + 1);
    expect(validateExpiry(soon, NOW)).toEqual(soon);
  });

  it('answers 400', () => {
    try {
      validateExpiry(NOW, NOW);
    } catch (error) {
      expect((error as HttpException).getStatus()).toBe(400);
    }
    expect.assertions(1);
  });
});
