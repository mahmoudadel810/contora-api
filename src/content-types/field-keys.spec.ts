import { FIELD_KEY_CASES } from './field-keys.cases.js';
import { generateFieldKey } from './field-keys.js';

const KEY = /^[a-z][a-zA-Z0-9]{0,39}$/;

describe('generateFieldKey', () => {
  it.each(FIELD_KEY_CASES)('"$label" with taken $taken gives $expected', (c) => {
    expect(generateFieldKey(c.label, new Set(c.taken))).toBe(c.expected);
  });

  it('always gives a valid key that is not taken', () => {
    for (const c of FIELD_KEY_CASES) {
      const key = generateFieldKey(c.label, new Set(c.taken));
      expect(key).toMatch(KEY);
      expect(c.taken).not.toContain(key);
      expect(key in Object.prototype).toBe(false);
    }
  });

  it('keeps a suffixed 60-character key within 40 characters', () => {
    const label = 'x'.repeat(60);
    const taken = new Set(['x'.repeat(40)]);
    for (let n = 2; n <= 11; n++) {
      const key = generateFieldKey(label, taken);
      expect(key.length).toBeLessThanOrEqual(40);
      expect(key).toMatch(KEY);
      taken.add(key);
    }
    expect(taken.has(`${'x'.repeat(38)}10`)).toBe(true);
  });
});
