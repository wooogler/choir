/**
 * Importing a PDF, a web page or a Google Doc as a new repository document.
 *
 * This barrel is the source-independent half: the shared vocabulary
 * (`./types`), the draft that holds a conversion between preview and commit,
 * the provenance line, the guard that decides what may actually be committed,
 * and the progress steps. The sources under `./sources/*` are deliberately not
 * re-exported — each pulls in its own heavy dependencies (pdfjs, JSDOM), and
 * the route loads only the one it needs.
 *
 * See docs/pdf-web-import.md.
 */

export * from './types';

export { DEFAULT_DRAFT_MAX_PER_USER, DEFAULT_DRAFT_MAX_TOTAL_BYTES, DEFAULT_DRAFT_TTL_MIN } from './config';
export { type ImportDraftConfig, draftConfig } from './config';

export {
  type CreatedDraft,
  type Draft,
  type DraftOwner,
  DraftStore,
  type DraftStoreOptions,
  documentBytes,
  getDraftStore,
} from './draft-store';

export {
  SOURCE_NOTE_MARKER,
  type SourceNoteOptions,
  buildSourceNote,
  pickDocumentLanguage,
  prependSourceNote,
  stripSourceNote,
} from './source-note';

export {
  type PrepareCommitParams,
  type PreparedCommit,
  isAssetReference,
  normalizeAssetPath,
  prepareCommit,
} from './commit-guard';

export { isImportBusy, runExclusiveImport } from './mutex';

export {
  UPLOAD_MAX_PER_USER,
  UPLOAD_MAX_TOTAL_BYTES,
  type CreateUploadParams,
  type CreatedUpload,
  type PendingUpload,
  UploadStore,
  type UploadOwner,
  type UploadStoreOptions,
  getUploadStore,
} from './upload-store';

export {
  COMMIT_STEPS,
  COMMIT_STEP_LABELS,
  CONVERT_STEPS,
  CONVERT_STEP_LABELS,
  type ImportCommitStep,
  type ImportConvertStep,
  type ImportProgressSink,
  type ImportStepProgress,
  makeCommitReporter,
  makeConvertReporter,
} from './progress';
