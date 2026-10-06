import type { NextFunction, Request, Response } from 'express';
import {
  currentRequestId,
  isValidRequestId,
  requestIdFor,
  requestIdMiddleware,
  requestIdOf,
} from './request-context.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('request ids', () => {
  it('accepts 1 to 64 letters, digits, underscores and dashes', () => {
    for (const id of ['a', 'A-1_b', '0123456789', 'x'.repeat(64), crypto.randomUUID()]) {
      expect(isValidRequestId(id), id).toBe(true);
    }
  });

  it('rejects empty, too long, punctuation, whitespace, non-ASCII and non-strings', () => {
    const bad: unknown[] = [
      '',
      'x'.repeat(65),
      'a b',
      'a.b',
      'a/b',
      'a,b',
      'line\nbreak',
      'ünïcode',
      '<script>',
      undefined,
      null,
      42,
      ['abc'],
    ];
    for (const id of bad) expect(isValidRequestId(id), JSON.stringify(id)).toBe(false);
  });

  it('keeps a valid id and replaces anything else with a fresh UUID', () => {
    expect(requestIdFor('keep-me')).toBe('keep-me');
    expect(requestIdFor('no way')).toMatch(UUID);
    expect(requestIdFor(['a', 'b'])).toMatch(UUID);
    expect(requestIdFor(undefined)).not.toBe(requestIdFor(undefined));
  });

  it('echoes the id, stores it on the request and in the async context of what follows', async () => {
    const headers: Record<string, string> = {};
    const req = { headers: { 'x-request-id': 'abc-123' } } as unknown as Request;
    const res = {
      setHeader: (name: string, value: string) => {
        headers[name] = value;
      },
    } as unknown as Response;
    const seen = await new Promise<Array<string | undefined>>((resolve) => {
      const next: NextFunction = () => {
        const inside = currentRequestId();
        setTimeout(() => resolve([inside, currentRequestId()]), 0);
      };
      requestIdMiddleware(req, res, next);
    });
    expect(headers['X-Request-Id']).toBe('abc-123');
    expect(requestIdOf(req)).toBe('abc-123');
    expect(seen).toEqual(['abc-123', 'abc-123']);
    expect(currentRequestId()).toBeUndefined();
  });
});
