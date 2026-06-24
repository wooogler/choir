import fs from 'node:fs';
import path from 'node:path';
import { getDataPath } from 'services/common/data-path';
import { Logger } from 'services/common/logger';

export type CaptionStatus = 'ok' | 'unavailable' | 'failed';

export interface CaptionEntry {
  /** Caption text injected into the search index (description + transcribed text). */
  caption: string;
  /** Concise one-line caption for the visible figure caption / image alt text. */
  shortCaption?: string;
  status: CaptionStatus;
  model?: string;
  bytes?: number;
  updatedAt: string;
}

interface CacheData {
  version: 1;
  /** Caption keyed by content hash (dedups the same image across docs). */
  byHash: Record<string, CaptionEntry>;
  /** Reference key (`local:<path>` / `url:<url>`) → content hash, for byte-free lookup. */
  refToHash: Record<string, string>;
}

const caches = new Map<string, ImageCaptionCache>();

/**
 * Per-workspace persistent cache of image captions. Captions are keyed by the
 * content hash of the image bytes so the same image is only described once;
 * reference keys (resolved local path or remote URL) map to that hash so the
 * section builder can look up captions synchronously without reading bytes.
 */
export class ImageCaptionCache {
  private data: CacheData = { version: 1, byHash: {}, refToHash: {} };
  private loaded = false;
  private readonly filePath: string;

  private constructor(workspaceId: string) {
    this.filePath = getDataPath('workspaces', workspaceId, 'state', 'image-captions.json');
  }

  static get(workspaceId: string): ImageCaptionCache {
    let cache = caches.get(workspaceId);
    if (!cache) {
      cache = new ImageCaptionCache(workspaceId);
      caches.set(workspaceId, cache);
    }
    return cache;
  }

  ensureLoaded(): void {
    if (this.loaded) return;
    try {
      if (fs.existsSync(this.filePath)) {
        const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) as CacheData;
        if (parsed?.version === 1 && parsed.byHash && parsed.refToHash) {
          this.data = parsed;
        }
      }
    } catch (error) {
      Logger.warn('ImageCaptionCache: failed to load cache, starting fresh', error as Error);
    }
    this.loaded = true;
  }

  /** Look up a caption by reference key (no image bytes required). */
  lookupByRef(refKey: string): CaptionEntry | null {
    this.ensureLoaded();
    const hash = this.data.refToHash[refKey];
    return hash ? (this.data.byHash[hash] ?? null) : null;
  }

  getByHash(hash: string): CaptionEntry | null {
    this.ensureLoaded();
    return this.data.byHash[hash] ?? null;
  }

  hasRef(refKey: string): boolean {
    this.ensureLoaded();
    return refKey in this.data.refToHash;
  }

  /** Store a caption under its content hash and point the reference key at it. */
  put(refKey: string | null, hash: string, entry: CaptionEntry): void {
    this.ensureLoaded();
    this.data.byHash[hash] = entry;
    if (refKey) this.data.refToHash[refKey] = hash;
  }

  async save(): Promise<void> {
    this.ensureLoaded();
    await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.promises.writeFile(this.filePath, JSON.stringify(this.data, null, 2), 'utf-8');
  }
}
