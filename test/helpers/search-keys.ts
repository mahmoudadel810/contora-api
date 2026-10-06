import { getConnectionToken } from '@nestjs/mongoose';
import { Types, type Connection } from 'mongoose';
import type { TestApp } from './test-app.js';

export function recordsCollection(ctx: TestApp) {
  return ctx.app.get<Connection>(getConnectionToken()).collection('records');
}

export interface StoredKeys {
  text?: string;
  v?: number;
  meta?: Record<string, string>;
  mv?: number;
  content?: string | null;
  cv?: number;
}

export async function storedKeys(ctx: TestApp, id: string): Promise<StoredKeys | undefined> {
  const doc = await recordsCollection(ctx).findOne({ _id: new Types.ObjectId(id) });
  return (doc?.['search'] as StoredKeys | undefined) ?? undefined;
}

export async function storedRecord(
  ctx: TestApp,
  id: string,
): Promise<Record<string, unknown> | null> {
  return recordsCollection(ctx).findOne({ _id: new Types.ObjectId(id) });
}

export async function makeLegacy(
  ctx: TestApp,
  id: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await recordsCollection(ctx).updateOne(
    { _id: new Types.ObjectId(id) },
    { $unset: { search: '' }, ...(Object.keys(extra).length > 0 ? { $set: extra } : {}) },
  );
}
