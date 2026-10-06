export function isMaxTimeExpired(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 50;
}
