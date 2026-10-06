import { describe, expect, it } from 'vitest';
import {
  contentTypeLink,
  folderLink,
  isAllowedLink,
  recordLink,
  savedSearchLink,
  searchLink,
} from './links.js';

const ID = 'a'.repeat(24);

describe('deep links', () => {
  it('builds app paths that the link allowlist accepts', () => {
    const links = [
      recordLink(ID),
      folderLink(ID),
      folderLink(null),
      contentTypeLink(ID),
      savedSearchLink(ID),
      searchLink({ q: "invoice (2024)! it's *" }),
      searchLink({ q: 'فاتورة', tags: ['finance', 'q 1'] }),
      searchLink({ tags: ['a'] }),
    ];
    expect(links).toEqual([
      `/records/${ID}`,
      `/repository/${ID}`,
      '/repository',
      `/content-types/${ID}`,
      `/search?saved=${ID}`,
      '/search?q=invoice%20%282024%29%21%20it%27s%20%2A',
      '/search?q=%D9%81%D8%A7%D8%AA%D9%88%D8%B1%D8%A9&tag=finance%2Cq%201',
      '/search?tag=a',
    ]);
    for (const link of links) expect(isAllowedLink(link ?? '')).toBe(true);
  });

  it('refuses a search link without a criterion', () => {
    expect(searchLink({})).toBeNull();
    expect(searchLink({ q: '  ', tags: [] })).toBeNull();
  });

  it('refuses anything that is not one of the app paths', () => {
    for (const link of [
      '//evil.example',
      '/\\evil.example',
      'https://evil.example',
      'javascript:alert(1)',
      'www.evil.example',
      '/records/xyz',
      '/records/new?folderId=x',
      '/search?q=<script>',
      `/records/${ID}/../../admin`,
    ]) {
      expect(isAllowedLink(link)).toBe(false);
    }
  });

  it('refuses a malformed id instead of building a path from it', () => {
    expect(() => recordLink('not-an-id')).toThrow();
  });
});
