export const LINK_ALLOWLIST =
  /^\/(records\/[a-f0-9]{24}|records\/new\?folderId=[a-f0-9]{24}|repository(\/[a-f0-9]{24})?|content-types\/[a-f0-9]{24}|search\?[A-Za-z0-9=&%._~-]*)$/;

const ID = /^[a-f0-9]{24}$/;

function idOf(id: string): string {
  if (!ID.test(id)) throw new Error('A deep link needs a 24-hex id');
  return id;
}

function encode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export const recordLink = (id: string): string => `/records/${idOf(id)}`;

export const folderLink = (id: string | null): string =>
  id === null ? '/repository' : `/repository/${idOf(id)}`;

export const contentTypeLink = (id: string): string => `/content-types/${idOf(id)}`;

export const savedSearchLink = (id: string): string => `/search?saved=${idOf(id)}`;

export function searchLink(criteria: { q?: string | null; tags?: string[] }): string | null {
  const params: string[] = [];
  const q = criteria.q?.trim();
  if (q) params.push(`q=${encode(q)}`);
  if (criteria.tags && criteria.tags.length > 0)
    params.push(`tag=${encode(criteria.tags.join(','))}`);
  return params.length > 0 ? `/search?${params.join('&')}` : null;
}

export function isAllowedLink(link: string): boolean {
  return LINK_ALLOWLIST.test(link);
}
