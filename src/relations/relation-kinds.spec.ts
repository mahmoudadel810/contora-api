import { RELATION_KINDS, labelFor, pairKeyOf } from './relation-kinds.js';

describe('relation kinds', () => {
  it('labels each kind forward on the source and inverse on the target', () => {
    expect(RELATION_KINDS.map((k) => [labelFor(k, 'outgoing'), labelFor(k, 'incoming')])).toEqual([
      ['Related to', 'Related to'],
      ['References', 'Referenced by'],
      ['Supersedes', 'Superseded by'],
      ['Part of', 'Has part'],
    ]);
  });

  it('builds the same pair key regardless of order', () => {
    const a = '64b000000000000000000001';
    const b = '64b000000000000000000002';
    expect(pairKeyOf(a, b)).toBe(`${a}:${b}`);
    expect(pairKeyOf(b, a)).toBe(`${a}:${b}`);
    expect(pairKeyOf(a, a)).toBe(`${a}:${a}`);
    expect(pairKeyOf(a, b)).not.toBe(pairKeyOf(a, '64b000000000000000000003'));
  });
});
