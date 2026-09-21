import crypto from 'node:crypto';
import { Logger } from 'services/common/logger';
import { draftConfig } from './config';
import type { PdfImportEstimate } from './sources/pdf/estimate';
import type { PdfInspection } from './sources/pdf/inspect';
import type { PdfImportPlan } from './sources/pdf/plan';
import { ImportRefusal } from './types';

/**
 * Uploaded PDFs waiting for the manager to say "convert".
 *
 * PDF import is three calls, not two, because the conversion costs money: the
 * upload is inspected and priced first, the manager is shown "N pages, about X
 * tokens, about $Y", and only then is the model asked for anything. Between the
 * estimate and that decision the bytes have to live somewhere, and re-uploading
 * them would mean paying for a second inspection and asking the manager to sit
 * through the upload twice.
 *
 * Same rules as the draft store next door (`draft-store.ts`), for the same
 * reasons: memory rather than disk, bound to workspace *and* user so one
 * manager's upload cannot be converted on someone else's key, and one answer —
 * `null` — for missing, expired and not-yours so the id space says nothing.
 *
 * The ceilings are tighter in count and looser in bytes than the draft store's:
 * an upload is a whole PDF (up to `IMPORT_PDF_MAX_BYTES`, 20MB by default) and
 * nobody needs two of them pending, while a draft is markdown and thumbnails.
 */

/** How many uploads one person may hold at once. Two covers a re-upload mid-decision. */
export const UPLOAD_MAX_PER_USER = 2;

/** Ceiling across every workspace in this process; PM2 runs several instances. */
export const UPLOAD_MAX_TOTAL_BYTES = 100 * 1024 * 1024;

/**
 * What every parked upload has in common: an owner, and the bytes that decide
 * what holding it costs the process. Everything else is the source's own —
 * a PDF parks its inspection and plan, a meeting parks its parsed transcript —
 * so the store is generic over the payload rather than knowing about either.
 */
export interface UploadPayload {
  workspaceId: string;
  userId: string;
  /** The upload as it arrived; its length is what the byte ceiling counts. */
  bytes: Buffer;
}

/** A PDF waiting for "convert": the bytes plus what the estimate was built from. */
export interface PdfUploadPayload extends UploadPayload {
  filename: string;
  inspection: PdfInspection;
  plan: PdfImportPlan;
  estimate: PdfImportEstimate;
}

/** A payload once the store owns it. */
export type StoredUpload<P extends UploadPayload> = P & {
  id: string;
  createdAt: number;
  expiresAt: number;
};

export type PendingUpload = StoredUpload<PdfUploadPayload>;

/** Who is asking. Both halves must match the upload's owner. */
export interface UploadOwner {
  workspaceId: string;
  userId: string;
}

export interface UploadStoreOptions {
  ttlMs?: number;
  maxTotalBytes?: number;
  maxPerUser?: number;
  /** Injectable clock, so expiry is testable without waiting. */
  now?: () => number;
}

export interface CreatedUpload {
  id: string;
  expiresAt: number;
}

export type CreateUploadParams = PdfUploadPayload;

export class UploadStore<P extends UploadPayload = PdfUploadPayload> {
  private readonly uploads = new Map<string, StoredUpload<P>>();
  private readonly ttlMs: number;
  private readonly maxTotalBytes: number;
  private readonly maxPerUser: number;
  private readonly now: () => number;
  private timer: NodeJS.Timeout | null = null;

  constructor(options: UploadStoreOptions = {}) {
    // The TTL is the draft's: both are "how long a half-finished import waits
    // for the person who started it", and two knobs for one answer would only
    // let a deploy set them inconsistently.
    this.ttlMs = options.ttlMs ?? draftConfig().ttlMs;
    this.maxTotalBytes = options.maxTotalBytes ?? UPLOAD_MAX_TOTAL_BYTES;
    this.maxPerUser = options.maxPerUser ?? UPLOAD_MAX_PER_USER;
    this.now = options.now ?? Date.now;
  }

  create(params: P): CreatedUpload {
    const bytes = params.bytes.length;

    // A file that cannot fit even in an empty store would evict everyone else's
    // upload and still not land, so it is refused before anything is lost.
    if (bytes > this.maxTotalBytes) {
      throw new ImportRefusal(413, 'import_too_large', { maxMb: Math.round(this.maxTotalBytes / (1024 * 1024)) });
    }

    this.sweep();
    this.evictForUser(params.workspaceId, params.userId);
    this.evictForBytes(bytes);

    const createdAt = this.now();
    const upload: StoredUpload<P> = {
      ...params,
      id: crypto.randomBytes(24).toString('base64url'),
      createdAt,
      expiresAt: createdAt + this.ttlMs,
    };

    this.uploads.set(upload.id, upload);
    this.startSweeping();

    return { id: upload.id, expiresAt: upload.expiresAt };
  }

  /** The upload, or `null` — missing, expired and not-yours are one answer on purpose. */
  get(id: string, owner: UploadOwner): StoredUpload<P> | null {
    const upload = this.uploads.get(id);
    if (!upload) return null;

    // Lazy expiry: the sweep is a memory measure, not the rule. Whether an
    // upload is still usable is decided when someone asks for it.
    if (upload.expiresAt <= this.now()) {
      this.uploads.delete(id);
      return null;
    }

    if (upload.workspaceId !== owner.workspaceId || upload.userId !== owner.userId) return null;
    return upload;
  }

  /** True when an upload of the caller's was removed; false is also "there was nothing of yours". */
  delete(id: string, owner: UploadOwner): boolean {
    if (!this.get(id, owner)) return false;
    return this.uploads.delete(id);
  }

  /** Drops everything already expired. Called on every create and on a timer. */
  sweep(): number {
    const now = this.now();
    let removed = 0;

    for (const [id, upload] of this.uploads) {
      if (upload.expiresAt <= now) {
        this.uploads.delete(id);
        removed += 1;
      }
    }

    return removed;
  }

  size(): number {
    return this.uploads.size;
  }

  totalBytes(): number {
    let total = 0;
    for (const upload of this.uploads.values()) total += upload.bytes.length;
    return total;
  }

  /** Stops the sweep timer. For tests and for a clean shutdown. */
  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Makes room for one more from this person; their oldest goes first. */
  private evictForUser(workspaceId: string, userId: string): void {
    for (;;) {
      const owned = [...this.uploads.values()].filter(
        (upload) => upload.workspaceId === workspaceId && upload.userId === userId,
      );
      if (owned.length < this.maxPerUser) return;

      const oldest = owned.reduce((a, b) => (a.createdAt <= b.createdAt ? a : b));
      this.uploads.delete(oldest.id);
      Logger.info('Import upload evicted: per-user limit', {
        workspaceId,
        userId,
        operation: 'import-upload-evict',
        limit: this.maxPerUser,
      });
    }
  }

  /**
   * Makes room in bytes, oldest first regardless of owner. Memory is a property
   * of the process, so fairness cannot be per user here — the alternative is
   * refusing an upload because someone else uploaded first.
   */
  private evictForBytes(incoming: number): void {
    while (this.uploads.size > 0 && this.totalBytes() + incoming > this.maxTotalBytes) {
      const oldest = [...this.uploads.values()].reduce((a, b) => (a.createdAt <= b.createdAt ? a : b));
      this.uploads.delete(oldest.id);
      Logger.info('Import upload evicted: memory ceiling', {
        workspaceId: oldest.workspaceId,
        userId: oldest.userId,
        operation: 'import-upload-evict',
        bytes: oldest.bytes.length,
      });
    }
  }

  /**
   * Starts on the first create rather than in the constructor, and unref'd, so
   * importing this module never keeps a process alive.
   */
  private startSweeping(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.sweep(), Math.max(Math.floor(this.ttlMs / 3), 1000));
    this.timer.unref();
  }
}

let singleton: UploadStore | null = null;

/** The process-wide store. Created on first use so config is read after env is set. */
export function getUploadStore(): UploadStore {
  if (!singleton) singleton = new UploadStore();
  return singleton;
}
