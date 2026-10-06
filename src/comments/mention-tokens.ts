const MENTION_TOKEN = /@\{user:([0-9a-f]{24})\}/g;

export const FORMER_USER = 'Former user';

export function mentionIds(body: string): string[] {
  return [...new Set(Array.from(body.matchAll(MENTION_TOKEN), (match) => match[1]))];
}

export function renderPlain(body: string, names: ReadonlyMap<string, string>): string {
  return body.replace(MENTION_TOKEN, (_token, id: string) => `@${names.get(id) ?? FORMER_USER}`);
}

export function plainExcerpt(
  body: string,
  names: ReadonlyMap<string, string>,
  max: number,
): string {
  return renderPlain(body, names).slice(0, max);
}
