import { stripSecrets } from './strip-secrets.js';

describe('stripSecrets', () => {
  it('removes keys that look like secrets at any depth', () => {
    const input = {
      email: 'a@b.c',
      password: 'p',
      newPassword: 'q',
      nested: { token: 't', refreshToken: 'u', jwtSecret: 'v', keep: 1 },
      list: [{ apiKey: 'k', fine: true }],
    };
    expect(stripSecrets(input)).toEqual({
      email: 'a@b.c',
      nested: { keep: 1 },
      list: [{ fine: true }],
    });
  });

  it('keeps the AI token usage counters, which are numbers and not secrets', () => {
    expect(stripSecrets({ inputTokens: 120, outputTokens: 30, accessTokens: 'x' })).toEqual({
      inputTokens: 120,
      outputTokens: 30,
    });
  });

  it('leaves primitives and dates alone', () => {
    const when = new Date('2026-01-01T00:00:00.000Z');
    expect(stripSecrets({ when, count: 2, flag: false, none: null })).toEqual({
      when,
      count: 2,
      flag: false,
      none: null,
    });
  });
});
