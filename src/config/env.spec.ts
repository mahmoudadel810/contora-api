import { loadConfig } from './env.js';

const base = {
  MONGODB_URI: 'mongodb://localhost:27017/x',
  JWT_SECRET: 'a-test-secret-that-is-long-enough-000000',
};

describe('loadConfig', () => {
  it('applies defaults', () => {
    const config = loadConfig(base);
    expect(config.PORT).toBe(3000);
    expect(config.NODE_ENV).toBe('development');
    expect(config.JWT_EXPIRES_IN).toBe('15m');
    expect(config.REFRESH_TOKEN_TTL_DAYS).toBe(7);
    expect(config.COOKIE_SECURE).toBe(false);
    expect(config.FRONTEND_URL).toBe('http://localhost:4300');
    expect(config.STORAGE_DIR).toBe('./storage');
    expect(config.MAX_UPLOAD_MB).toBe(100);
    expect(config.INVITATION_TTL_DAYS).toBe(7);
  });

  it('coerces numeric strings', () => {
    const config = loadConfig({ ...base, PORT: '4100', MAX_UPLOAD_MB: '5' });
    expect(config.PORT).toBe(4100);
    expect(config.MAX_UPLOAD_MB).toBe(5);
  });

  it('limits the mention recipients per comment to 1–200, 50 by default', () => {
    expect(loadConfig(base).COMMENT_MENTION_MAX_RECIPIENTS).toBe(50);
    expect(
      loadConfig({ ...base, COMMENT_MENTION_MAX_RECIPIENTS: '3' }).COMMENT_MENTION_MAX_RECIPIENTS,
    ).toBe(3);
    for (const value of ['0', '201', '2.5', 'many']) {
      expect(() => loadConfig({ ...base, COMMENT_MENTION_MAX_RECIPIENTS: value })).toThrow(
        /COMMENT_MENTION_MAX_RECIPIENTS/,
      );
    }
  });

  it('rejects a short JWT secret', () => {
    expect(() => loadConfig({ ...base, JWT_SECRET: 'short' })).toThrow(/JWT_SECRET/);
  });

  it('rejects a missing MONGODB_URI', () => {
    expect(() => loadConfig({ JWT_SECRET: base.JWT_SECRET })).toThrow(/MONGODB_URI/);
  });

  describe('in production', () => {
    const production = {
      ...base,
      NODE_ENV: 'production',
      JWT_SECRET: 'Zk4q-9WmR2vT7xLp_8sN3bYc6HdJ1fGe',
      COOKIE_SECURE: 'true',
    };

    it('accepts a random-looking secret with secure cookies', () => {
      const config = loadConfig(production);
      expect(config.COOKIE_SECURE).toBe(true);
      expect(config.ALLOW_INSECURE_COOKIES).toBe(false);
    });

    it('rejects the example secret and anything built on its placeholder', () => {
      const example = 'replace-with-a-random-string-of-at-least-32-characters';
      expect(() => loadConfig({ ...production, JWT_SECRET: example })).toThrow(/JWT_SECRET/);
      expect(() =>
        loadConfig({ ...production, JWT_SECRET: 'replace-with-Zk4q-9WmR2vT7xLp_8sN3bYc6' }),
      ).toThrow(/JWT_SECRET/);
    });

    it('rejects a long secret with fewer than 10 distinct characters', () => {
      expect(() => loadConfig({ ...production, JWT_SECRET: 'a'.repeat(40) })).toThrow(/JWT_SECRET/);
      expect(() => loadConfig({ ...production, JWT_SECRET: 'abcdefghi'.repeat(4) })).toThrow(
        /JWT_SECRET/,
      );
      expect(loadConfig({ ...production, JWT_SECRET: 'abcdefghij'.repeat(4) }).JWT_SECRET).toBe(
        'abcdefghij'.repeat(4),
      );
    });

    it('refuses insecure cookies unless explicitly allowed', () => {
      expect(() => loadConfig({ ...production, COOKIE_SECURE: 'false' })).toThrow(/COOKIE_SECURE/);
      const { COOKIE_SECURE: _unset, ...defaulted } = production;
      expect(() => loadConfig(defaulted)).toThrow(/COOKIE_SECURE/);
      const allowed = loadConfig({
        ...production,
        COOKIE_SECURE: 'false',
        ALLOW_INSECURE_COOKIES: 'true',
      });
      expect(allowed.COOKIE_SECURE).toBe(false);
      expect(allowed.ALLOW_INSECURE_COOKIES).toBe(true);
    });

    it('leaves development and test unchanged', () => {
      for (const NODE_ENV of ['development', 'test']) {
        const config = loadConfig({
          ...base,
          NODE_ENV,
          JWT_SECRET: 'replace-with-a-random-string-of-at-least-32-characters',
        });
        expect(config.COOKIE_SECURE).toBe(false);
      }
    });
  });
});
