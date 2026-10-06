import { createReadStream } from 'node:fs';
import { access, copyFile, mkdir, rename, rm } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import type { FileStorage } from './file-storage.js';

export class LocalFileStorage implements FileStorage {
  private readonly root: string;

  constructor(rootDir: string) {
    this.root = resolve(rootDir);
  }

  async putFromPath(key: string, sourcePath: string): Promise<void> {
    const target = this.pathFor(key);
    await mkdir(dirname(target), { recursive: true });
    try {
      await rename(sourcePath, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
      await copyFile(sourcePath, target);
      await rm(sourcePath, { force: true });
    }
  }

  async open(key: string): Promise<Readable> {
    const path = this.pathFor(key);
    await access(path);
    return createReadStream(path);
  }

  async remove(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }

  async exists(key: string): Promise<boolean> {
    try {
      await access(this.pathFor(key));
      return true;
    } catch {
      return false;
    }
  }

  private pathFor(key: string): string {
    const path = resolve(this.root, key);
    if (!path.startsWith(this.root + sep)) {
      throw new Error(`Storage key resolves outside the storage root: ${key}`);
    }
    return path;
  }
}
