// Minimal R2Bucket shim over the filesystem, for running the Worker's Hono app
// as a plain Node process (Railway) with a mounted volume as the object store.
// Implements only the surface src/ uses: put/get/head/delete/list, plus the
// R2Object fields those call sites touch (size, uploaded, httpMetadata,
// writeHttpMetadata, body).
//
// Railway is the active host until the finished product migrates to Cloudflare;
// nothing under src/ knows this adapter exists.

import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';

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

  async put(
    key: string,
    body: ReadableStream | ArrayBuffer | ArrayBufferView | string | null,
    options?: { httpMetadata?: { contentType?: string } }
  ): Promise<FsR2Object> {
    await this.ready;
    // 100 MB ceiling is enforced upstream in src/index.ts before we get here.
    const bytes = Buffer.from(await new Response(body as BodyInit).arrayBuffer());

    const meta: StoredMeta = {
      key,
      size: bytes.byteLength,
      uploaded: new Date().toISOString(),
      contentType: options?.httpMetadata?.contentType ?? 'application/octet-stream',
    };

    // Write blob then meta, each via a temp file, so a crash never leaves a
    // meta entry pointing at a half-written blob.
    const blobTmp = `${this.blobPath(key)}.tmp`;
    await writeFile(blobTmp, bytes);
    await rename(blobTmp, this.blobPath(key));

    const metaTmp = `${this.metaPath(key)}.tmp`;
    await writeFile(metaTmp, JSON.stringify(meta));
    await rename(metaTmp, this.metaPath(key));

    return new FsR2Object(meta);
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
