/**
 * Bookkeeping for the GitHub → Google Docs replica sync (docs/google-drive-sync.md).
 *
 * This lives on the filesystem next to the workspace mirror rather than in the
 * encrypted workspace config: none of it is secret, it changes on every poll, and
 * `lastPushedVersion`-style data already lives beside `sync-state.json`.
 */

/**
 * Per-document lifecycle. `synced` is the only state in which a GitHub change is
 * allowed to overwrite the Doc; every other state means a human's work is sitting
 * in Google Docs and must not be clobbered.
 */
export type GdocsDocStatus =
  /** Replica matches GitHub. GitHub changes publish straight through. */
  | 'synced'
  /** A human edited the Doc. Publishing is held back until a manager decides. */
  | 'drifted'
  /** Delta extracted and a manager is reviewing it. */
  | 'pending-review'
  /**
   * A decision is being carried out. Claimed under the document lock so a second
   * manager clicking approve moments later is refused rather than committing the
   * same edit twice.
   */
  | 'applying'
  /** The baseline file is missing or unreadable, so drift cannot be measured. */
  | 'baseline-lost'
  /** The GitHub document behind this replica was deleted or moved. */
  | 'orphaned'
  /** Drive rejected an operation (trashed file, revoked access, quota). */
  | 'error';

/** A manager's outstanding notification card, so it can be updated or invalidated. */
export interface GdocsReviewCard {
  managerId: string;
  channel: string;
  ts: string;
}

export interface GdocsDocState {
  status: GdocsDocStatus;
  /**
   * The Drive `version` observed atomically with the content we baselined. The
   * poller treats anything higher as "something happened" — a trigger only, since
   * metadata changes bump it too (measured: a rename alone bumps version).
   */
  lastPushedVersion?: string;
  /** Hash of the GitHub markdown last pushed, so unchanged content skips the API. */
  lastPushedContentHash?: string;
  lastPushedAt?: string;
  driftDetectedAt?: string;
  /**
   * Best-effort attribution from Drive. Not a reliable app-vs-human signal: our
   * own writes use the workspace account's token, so its manual edits and ours
   * are indistinguishable here. Display only.
   */
  lastModifyingUser?: string;
  /**
   * The Doc version the manager's review was rendered against — the fence both
   * decisions are checked against. Written only by buildReview: if the poller
   * moved it, a sweep landing between the render and the click would advance the
   * fence past an edit the manager never saw and wave the decision through.
   */
  reviewedVersion?: string;
  /**
   * The newest version the poller has seen. Separate from `reviewedVersion` so
   * repeat sweeps stay cheap and cards can be refreshed without disarming the
   * fence.
   */
  latestVersion?: string;
  /** GitHub blob SHA the delta was merged against — the approve fence. */
  oursBlobSha?: string;
  reviewCards?: GdocsReviewCard[];
  error?: string;
  updatedAt: string;
}

export interface GdocsSyncFile {
  version: 1;
  docs: Record<string, GdocsDocState>;
  updatedAt: string;
}
