import { isDuplicateKey } from './duplicate-key.js';

describe('isDuplicateKey', () => {
  it('recognises a unique-index violation', () => {
    expect(isDuplicateKey({ code: 11000 })).toBe(true);
    expect(isDuplicateKey(Object.assign(new Error('E11000 duplicate key'), { code: 11000 }))).toBe(
      true,
    );
  });

  it('rejects other errors and any non-object without throwing', () => {
    for (const value of [
      { code: 11001 },
      { code: '11000' },
      new Error('x'),
      null,
      undefined,
      11000,
      'E11000',
    ]) {
      expect(isDuplicateKey(value), JSON.stringify(value) ?? 'undefined').toBe(false);
    }
  });
});
