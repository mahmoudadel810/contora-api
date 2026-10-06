import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalFileStorage } from './local-file-storage.js';

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString();
}

describe('LocalFileStorage', () => {
  let root: string;
  let storage: LocalFileStorage;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'contora-fs-'));
    storage = new LocalFileStorage(join(root, 'store'));
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('moves a file into place, opens it and removes it', async () => {
    const source = join(root, 'upload.tmp');
    await writeFile(source, 'hello');
    await storage.putFromPath('t1/ab/abcdef', source);
    expect(await readdir(root)).not.toContain('upload.tmp');
    expect(await storage.exists('t1/ab/abcdef')).toBe(true);
    expect(await readAll(await storage.open('t1/ab/abcdef'))).toBe('hello');
    await storage.remove('t1/ab/abcdef');
    expect(await storage.exists('t1/ab/abcdef')).toBe(false);
    await expect(storage.remove('t1/ab/abcdef')).resolves.toBeUndefined();
  });

  it('refuses keys that escape the root', async () => {
    await expect(storage.open('../escape.txt')).rejects.toThrow(/outside/);
    await expect(storage.open('t1/../../escape.txt')).rejects.toThrow(/outside/);
    await expect(storage.remove('/etc/passwd')).rejects.toThrow(/outside/);
  });
});
