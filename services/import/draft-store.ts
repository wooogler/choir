import crypto from 'node:crypto';
import { Logger } from 'services/common/logger';
import { normalizeAssetPath } from './commit-guard';
import { draftConfig } from './config';
import type { ConvertedDocument, ImportAsset } from './types';
import { ImportRefusal } from './types';

/**
 * Converted documents waiting for the manager to say "import".
 *
 * Import is two calls — convert, then commit — because a PDF or a web page is
 * read, not exported: the result has to be looked at before it becomes a
 * document. Between the two calls the markdown and its images have to live
 * somewhere, and that somewhere is memory rather than disk or the database:
 * a draft is worth exactly one preview dialog, and a process restart losing it
 * costs a re-conversion, not data. Nothing here is durable by design.
 *
 * Every draft is bound to the workspace *and* the user who made it, for the same
 * reason the picker nonce is (`services/google/picker-nonce.ts`): the commit
 * call writes to the repository, so one manager's draft must not be committable
 * as someone else. A draft that is missing, expired, or somebody else's answers
 * the same way — `null` — so the id space cannot be probed for what exists.
 *
 * The cost of holding images in memory is bounded twice: a per-user count, so
 * one person cannot fill the process by converting repeatedly, and a total byte
 * ceiling across every workspace, since this is per PM2 instance.
 */

export interface Draft {
  id: string;
  workspaceId: string;
  userId: string;
  document: ConvertedDocument;
  createdAt: number;
  expiresAt: number;
  /** Markdown plus every asset, which is what this draft costs the process. */
  bytes: number;
}

/** Who is asking. Both halves must match the draft's owner. */
export interface DraftOwner {
  workspaceId: string;
  userId: string;
}

export interface DraftStoreOptions {
  ttlMs?: number;
  maxTotalBytes?: number;
  maxPerUser?: number;
  /** Injectable clock, so expiry is testable without waiting. */
  now?: () => number;
}

export interface CreatedDraft {
  id: string;
  expiresAt: number;
}

export class DraftStore {
  private readonly drafts = new Map<string, Draft>();
  private readonly ttlMs: number;
  private readonly maxTotalBytes: number;
  private readonly maxPerUser: number;
  private readonly now: () => number;
  private timer: NodeJS.Timeout | null = null;

  constructor(options: DraftStoreOptions = {}) {
    const defaults = draftConfig();
    this.ttlMs = options.ttlMs ?? defaults.ttlMs;
    this.maxTotalBytes = options.maxTotalBytes ?? defaults.maxTotalBytes;
    this.maxPerUser = options.maxPerUser ?? defaults.maxPerUser;
    this.now = options.now ?? Date.now;
  }

  create(params: { workspaceId: string; userId: string; document: ConvertedDocument }): CreatedDraft {
    const { workspaceId, userId, document } = params;
    const bytes = documentBytes(document);

    // A document that cannot fit even in an empty store would evict everyone
    // else's work and still not land, so it is refused before anything is lost.
    if (bytes > this.maxTotalBytes) {
      throw new ImportRefusal(413, 'import_too_large', { bytes, limit: this.maxTotalBytes });
    }

    this.sweep();
    this.evictForUser(workspaceId, userId);
    this.evictForBytes(bytes);

    const createdAt = this.now();
    const draft: Draft = {
      id: crypto.randomBytes(24).toString('base64url'),
      workspaceId,
      userId,
      document,
      createdAt,
      expiresAt: createdAt + this.ttlMs,
      bytes,
    };

    this.drafts.set(draft.id, draft);
    this.startSweeping();

    return { id: draft.id, expiresAt: draft.expiresAt };
  }

  /** The draft, or `null` — missing, expired and not-yours are one answer on purpose. */
  get(id: string, owner: DraftOwner): Draft | null {
    const draft = this.drafts.get(id);
    if (!draft) return null;

    // Lazy expiry: the sweep is a memory measure, not the rule. Whether a draft
    // is still usable is decided when someone asks for it.
    if (draft.expiresAt <= this.now()) {
      this.drafts.delete(id);
      return null;
    }

    if (draft.workspaceId !== owner.workspaceId || draft.userId !== owner.userId) return null;
    return draft;
  }

  /** True when a draft of the caller's was removed; false is also "there was nothing of yours". */
  delete(id: string, owner: DraftOwner): boolean {
    if (!this.get(id, owner)) return false;
    return this.drafts.delete(id);
  }

  /**
   * One image out of a draft, for the preview's temporary URLs.
   *
   * The lookup is by normalized path so the route can pass what the markdown
   * says (`./assets/x.png`, `/assets/x.png`) rather than having to know how the
   * source spelled it.
   */
  getAsset(id: string, owner: DraftOwner, assetPath: string): ImportAsset | null {
    const draft = this.get(id, owner);
    if (!draft) return null;

    const wanted = normalizeAssetPath(assetPath);
    return draft.document.assets.find((asset) => normalizeAssetPath(asset.path) === wanted) ?? null;
  }

  /** Drops everything already expired. Called on every create and on a timer. */
  sweep(): number {
    const now = this.now();
    let removed = 0;

    for (const [id, draft] of this.drafts) {
      if (draft.expiresAt <= now) {
        this.drafts.delete(id);
        removed += 1;
      }
    }

    return removed;
  }

  size(): number {
    return this.drafts.size;
  }

  totalBytes(): number {
    let total = 0;
    for (const draft of this.drafts.values()) total += draft.bytes;
    return total;
  }

  /** Stops the sweep timer. For tests and for a clean shutdown. */
  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Makes room for one more draft from this person. Their oldest goes first:
   * the one they are most likely to have abandoned.
   */
  private evictForUser(workspaceId: string, userId: string): void {
    for (;;) {
      const owned = [...this.drafts.values()].filter(
        (draft) => draft.workspaceId === workspaceId && draft.userId === userId,
      );
      if (owned.length < this.maxPerUser) return;

      const oldest = owned.reduce((a, b) => (a.createdAt <= b.createdAt ? a : b));
      this.drafts.delete(oldest.id);
      Logger.info('Import draft evicted: per-user limit', {
        workspaceId,
        userId,
        operation: 'import-draft-evict',
        limit: this.maxPerUser,
      });
    }
  }

  /**
   * Makes room in bytes, oldest first regardless of owner. Memory is a property
   * of the process, so fairness cannot be per user here — the alternative is
   * refusing a conversion because someone else converted first.
   */
  private evictForBytes(incoming: number): void {
    while (this.drafts.size > 0 && this.totalBytes() + incoming > this.maxTotalBytes) {
      const oldest = [...this.drafts.values()].reduce((a, b) => (a.createdAt <= b.createdAt ? a : b));
      this.drafts.delete(oldest.id);
      Logger.info('Import draft evicted: memory ceiling', {
        workspaceId: oldest.workspaceId,
        userId: oldest.userId,
        operation: 'import-draft-evict',
        bytes: oldest.bytes,
      });
    }
  }

  /**
   * The timer exists so a draft nobody comes back for is not held for the whole
   * process lifetime. It starts on the first create rather than in the
   * constructor so importing this module never keeps a process alive, and it is
   * unref'd for the same reason.
   */
  private startSweeping(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.sweep(), Math.max(Math.floor(this.ttlMs / 3), 1000));
    this.timer.unref();
  }
}

export function documentBytes(document: ConvertedDocument): number {
  const assets = document.assets.reduce((total, asset) => total + asset.bytes.length, 0);
  return Buffer.byteLength(document.markdown, 'utf8') + assets;
}

let singleton: DraftStore | null = null;

/** The process-wide store. Created on first use so config is read after env is set. */
export function getDraftStore(): DraftStore {
  if (!singleton) singleton = new DraftStore();
  return singleton;
}
