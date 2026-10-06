import type { Readable } from 'node:stream';

export const FILE_STORAGE = 'FILE_STORAGE';

export interface FileStorage {
  putFromPath(key: string, sourcePath: string): Promise<void>;
  open(key: string): Promise<Readable>;
  remove(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}
