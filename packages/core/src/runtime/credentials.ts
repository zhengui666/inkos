import { readFile, chmod } from 'node:fs/promises';
import { dirname, basename } from 'node:path';
import type { Credential, CredentialStore } from '@earendil-works/pi-ai';
import { commitAtomicFileSet } from '../utils/atomic-file-set.js';

/** Only the project runtime writes this store; Models serializes provider refreshes through modify. */
export class FileCredentialStore implements CredentialStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(readonly path: string) {}
  private async all(): Promise<Record<string, Credential>> {
    try { return JSON.parse(await readFile(this.path, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error; }
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.catch(() => undefined).then(fn); this.queue = next; return next;
  }
  async read(id: string) { await this.queue; return (await this.all())[id]; }
  async list() { await this.queue; return Object.entries(await this.all()).map(([providerId, c]) => ({ providerId, type: c.type })); }
  modify(id: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>) {
    return this.serial(async () => {
      const data = await this.all(); const candidate = await fn(data[id]);
      if (candidate) { data[id] = candidate; await this.save(data); }
      return data[id];
    });
  }
  delete(id: string) { return this.serial(async () => { const data = await this.all(); delete data[id]; await this.save(data); }); }
  private async save(data: Record<string, Credential>) {
    await commitAtomicFileSet({ rootDir: dirname(this.path), writes: [{ relativePath: basename(this.path), content: JSON.stringify(data, null, 2) }] });
    await chmod(this.path, 0o600);
  }
}
