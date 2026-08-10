// Minimal R2Bucket shim over the filesystem, for running the Worker's Hono app
// as a plain Node process (Railway) with a mounted volume as the object store.
// Implements only the surface src/ uses: put/get/head/delete/list, plus the
// R2Object fields those call sites touch (size, uploaded, httpMetadata,
// writeHttpMetadata, body).
//
// Railway is the active host until the finished product migrates to Cloudflare;
// nothing under src/ knows this adapter exists.

import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const LIST_PAGE_SIZE = 1000;

interface StoredMeta {
  key: string;
  size: number;
  uploaded: string;
  contentType: string;
}

/** Keys contain slashes; encode them into a single flat filename. */
function encodeKey(key: string): string {
  return encodeURIComponent(key);
}

function decodeKey(name: string): string {
  return decodeURIComponent(name);
}

function nodeBodyStream(
  body: ReadableStream | ArrayBuffer | ArrayBufferView | string | null
): Readable {
  if (body === null) return Readable.from([]);
  if (typeof body === 'string') return Readable.from([body]);
  if (body instanceof ArrayBuffer) return Readable.from([new Uint8Array(body)]);
  if (ArrayBuffer.isView(body)) {
    return Readable.from([
      new Uint8Array(body.buffer, body.byteOffset, body.byteLength),
    ]);
  }
  return Readable.fromWeb(body as never);
}

class FsR2Object {
  readonly key: string;
  readonly size: number;
  readonly uploaded: Date;
  readonly httpMetadata: { contentType: string };

  constructor(meta: StoredMeta) {
    this.key = meta.key;
    this.size = meta.size;
    this.uploaded = new Date(meta.uploaded);
    this.httpMetadata = { contentType: meta.contentType };
  }

  writeHttpMetadata(headers: Headers): void {
    headers.set('Content-Type', this.httpMetadata.contentType);
  }
}

class FsR2ObjectBody extends FsR2Object {
  readonly body: ReadableStream;

  constructor(meta: StoredMeta, blobPath: string) {
    super(meta);
    this.body = Readable.toWeb(createReadStream(blobPath)) as unknown as ReadableStream;
  }
}

export class FsR2Bucket {
  private readonly blobDir: string;
  private readonly metaDir: string;
  private ready: Promise<void>;
  private readonly putLocks = new Map<string, Promise<void>>();

  constructor(root: string) {
    const blobDir = join(root, 'blobs');
    const metaDir = join(root, 'meta');
    this.blobDir = blobDir;
    this.metaDir = metaDir;
    this.ready = (async () => {
      await mkdir(blobDir, { recursive: true });
      await mkdir(metaDir, { recursive: true });
    })();
  }

  private blobPath(key: string): string {
    return join(this.blobDir, encodeKey(key));
  }

  private metaPath(key: string): string {
    return join(this.metaDir, `${encodeKey(key)}.json`);
  }

  private async readMeta(key: string): Promise<StoredMeta | null> {
    try {
      return JSON.parse(await readFile(this.metaPath(key), 'utf8')) as StoredMeta;
    } catch {
      return null;
    }
  }

  private async serializePut<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.putLocks.get(key) ?? Promise.resolve();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const current = previous.catch(() => {}).then(() => gate);
    this.putLocks.set(key, current);
    await previous.catch(() => {});
    try {
      return await task();
    } finally {
      release();
      if (this.putLocks.get(key) === current) this.putLocks.delete(key);
    }
  }

  async put(
    key: string,
    body: ReadableStream | ArrayBuffer | ArrayBufferView | string | null,
    options?: {
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
    }
  ): Promise<FsR2Object> {
    await this.ready;
    return this.serializePut(key, async () => {
      // Stream to a unique temporary file. This keeps a 100 MB browser upload
      // or immutable Auto snapshot out of the warmed Node process's heap and
      // leaves the previous complete object visible until the final rename.
      const nonce = crypto.randomUUID();
      const blobTmp = `${this.blobPath(key)}.${nonce}.tmp`;
      const metaTmp = `${this.metaPath(key)}.${nonce}.tmp`;
      try {
        await pipeline(nodeBodyStream(body), createWriteStream(blobTmp, { flags: 'wx' }));
        const blob = await stat(blobTmp);
        const meta: StoredMeta = {
          key,
          size: blob.size,
          uploaded: new Date().toISOString(),
          contentType: options?.httpMetadata?.contentType ?? 'application/octet-stream',
        };
        await writeFile(metaTmp, JSON.stringify(meta), { flag: 'wx' });
        await rename(blobTmp, this.blobPath(key));
        await rename(metaTmp, this.metaPath(key));
        return new FsR2Object(meta);
      } catch (error) {
        await Promise.allSettled([
          rm(blobTmp, { force: true }),
          rm(metaTmp, { force: true }),
        ]);
        throw error;
      }
    });
  }

  async get(key: string): Promise<FsR2ObjectBody | null> {
    await this.ready;
    const meta = await this.readMeta(key);
    if (!meta) return null;
    return new FsR2ObjectBody(meta, this.blobPath(key));
  }

  async head(key: string): Promise<FsR2Object | null> {
    await this.ready;
    const meta = await this.readMeta(key);
    return meta ? new FsR2Object(meta) : null;
  }

  async delete(keys: string | string[]): Promise<void> {
    await this.ready;
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      await rm(this.blobPath(key), { force: true });
      await rm(this.metaPath(key), { force: true });
    }
  }

  async list(options?: { cursor?: string; prefix?: string }): Promise<{
    objects: FsR2Object[];
    truncated: boolean;
    cursor?: string;
  }> {
    await this.ready;
    const names = (await readdir(this.metaDir)).filter((name) => name.endsWith('.json'));
    const keys = names
      .map((name) => decodeKey(name.slice(0, -'.json'.length)))
      .filter((key) => !options?.prefix || key.startsWith(options.prefix))
      .sort();

    const start = options?.cursor ? keys.indexOf(options.cursor) + 1 : 0;
    const page = keys.slice(start, start + LIST_PAGE_SIZE);

    const objects: FsR2Object[] = [];
    for (const key of page) {
      const meta = await this.readMeta(key);
      if (meta) objects.push(new FsR2Object(meta));
    }

    const truncated = start + LIST_PAGE_SIZE < keys.length;
    return {
      objects,
      truncated,
      cursor: truncated ? page[page.length - 1] : undefined,
    };
  }
}
