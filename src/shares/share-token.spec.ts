import { hashSecret, newSecret, parseShareToken, shareUrlOf } from './share-token.js';

describe('share tokens', () => {
  it('makes a fresh 43-character base64url secret every time', () => {
    const a = newSecret();
    const b = newSecret();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(b).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
  });

  it('hashes a secret to its sha256 hex digest', () => {
    expect(hashSecret('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('accepts only a well-formed token and never throws', () => {
    const token = 'A'.repeat(21) + '_-' + 'z9'.repeat(10);
    expect(token).toHaveLength(43);
    expect(parseShareToken(token)).toBe(token);
    for (const bad of [
      undefined,
      null,
      '',
      'A'.repeat(42),
      'A'.repeat(44),
      'A'.repeat(42) + '=',
      'A'.repeat(42) + '/',
      ['A'.repeat(43)],
      43,
    ]) {
      expect(parseShareToken(bad)).toBeNull();
    }
  });

  it('puts the token in the fragment of the frontend /s page', () => {
    const token = 'T'.repeat(43);
    expect(shareUrlOf('https://ecm.example.test', token)).toBe(
      `https://ecm.example.test/s#${token}`,
    );
    expect(shareUrlOf('https://ecm.example.test/app//', token)).toBe(
      `https://ecm.example.test/app/s#${token}`,
    );
  });
});
