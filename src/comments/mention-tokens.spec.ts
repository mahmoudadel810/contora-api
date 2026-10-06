import { FORMER_USER, mentionIds, plainExcerpt, renderPlain } from './mention-tokens.js';

const ALICE = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const BOB = '0123456789abcdef01234567';
const GONE = 'ffffffffffffffffffffffff';

describe('mentionIds', () => {
  it('returns the distinct user ids of the tokens, in first-seen order', () => {
    expect(mentionIds(`@{user:${BOB}} and @{user:${ALICE}}, again @{user:${BOB}}`)).toEqual([
      BOB,
      ALICE,
    ]);
  });

  it('treats anything that is not an exact user token as plain text', () => {
    for (const body of [
      'plain @alice and an email a@b.test',
      `@{user:${ALICE.toUpperCase()}}`,
      `@{user:${ALICE.slice(1)}}`,
      `@{user:${ALICE}0}`,
      `@{department:${ALICE}}`,
      `@{ user:${ALICE}}`,
      `@user:${ALICE}`,
    ]) {
      expect(mentionIds(body), body).toEqual([]);
    }
  });

  it('is not confused by a previous call (the global regex keeps no state between calls)', () => {
    const body = `@{user:${ALICE}}`;
    expect(mentionIds(body)).toEqual([ALICE]);
    expect(mentionIds(body)).toEqual([ALICE]);
  });
});

describe('renderPlain', () => {
  const names = new Map([
    [ALICE, 'Alice Admin'],
    [BOB, 'Bob Member'],
  ]);

  it('turns every token into @Name, and unknown or removed users into @Former user', () => {
    expect(renderPlain(`Hi @{user:${ALICE}} and @{user:${GONE}}, see @{user:${BOB}}.`, names)).toBe(
      'Hi @Alice Admin and @Former user, see @Bob Member.',
    );
    expect(FORMER_USER).toBe('Former user');
  });

  it('leaves text without tokens unchanged', () => {
    expect(renderPlain('No mentions, just @text and @{department:x}', names)).toBe(
      'No mentions, just @text and @{department:x}',
    );
  });

  it('does not expand a name that itself looks like a token', () => {
    const tricky = new Map([[ALICE, `@{user:${BOB}}`]]);
    expect(renderPlain(`@{user:${ALICE}}`, tricky)).toBe(`@@{user:${BOB}}`);
  });
});

describe('plainExcerpt', () => {
  it('cuts after rendering, so a token straddling the limit never leaves half a token', () => {
    const body = `${'x'.repeat(75)}@{user:${ALICE}} tail`;
    const excerpt = plainExcerpt(body, new Map([[ALICE, 'Alice Admin']]), 80);
    expect(excerpt).toBe(`${'x'.repeat(75)}@Alic`);
    expect(excerpt).not.toContain('@{');
  });

  it('renders a removed user near the limit as a (cut) plain name, never as a raw id', () => {
    const body = `${'y'.repeat(78)}@{user:${GONE}}`;
    const excerpt = plainExcerpt(body, new Map(), 80);
    expect(excerpt).toBe(`${'y'.repeat(78)}@F`);
    expect(excerpt).not.toContain(GONE.slice(0, 4));
  });

  it('keeps short bodies whole', () => {
    expect(plainExcerpt(`ok @{user:${BOB}}`, new Map([[BOB, 'Bob']]), 120)).toBe('ok @Bob');
  });
});
