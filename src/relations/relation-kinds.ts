export const RELATION_KINDS = ['relatedTo', 'references', 'supersedes', 'partOf'] as const;

export type RelationKind = (typeof RELATION_KINDS)[number];

export type RelationDirection = 'outgoing' | 'incoming';

const LABELS: Record<RelationKind, Record<RelationDirection, string>> = {
  relatedTo: { outgoing: 'Related to', incoming: 'Related to' },
  references: { outgoing: 'References', incoming: 'Referenced by' },
  supersedes: { outgoing: 'Supersedes', incoming: 'Superseded by' },
  partOf: { outgoing: 'Part of', incoming: 'Has part' },
};

export function labelFor(kind: RelationKind, direction: RelationDirection): string {
  return LABELS[kind][direction];
}

export function pairKeyOf(a: string, b: string): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}
