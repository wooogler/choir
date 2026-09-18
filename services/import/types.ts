import type { RejectedAsset } from 'services/google/gdocs-delta';

/**
 * The vocabulary every import source speaks.
 *
 * A source (PDF upload, public URL, Google Doc) turns its input into a
 * `ConvertedDocument`; the rest of the pipeline — draft, preview, commit — never
 * needs to know which source produced it. Kept import-light so both the sources
 * and the route can depend on it without pulling each other in.
 *
 * See docs/pdf-web-import.md for the design this implements.
 */

export type ImportSourceKind = 'pdf' | 'url' | 'google-docs';

/** A binary that travels with the document and lands in the same commit. */
export interface ImportAsset {
  /** Repository-relative, content-addressed: `assets/<sha256 hex, 40 chars>.<ext>`. */
  path: string;
  bytes: Buffer;
  contentType: string;
}

export type ImportWarningCode =
  /** PDF: the LLM output covers too little of the text pdfjs extracted. */
  | 'low_fidelity'
  /** PDF: pages with no text layer were read from their page images. */
  | 'scanned_pages'
  /** Web: Readability found no article; the page body was used instead. */
  | 'readability_fallback'
  /** Some images were dropped; the details are in `rejectedAssets`. */
  | 'images_rejected'
  /** Input was cut to fit a limit (pages, bytes, characters). */
  | 'truncated';

export interface ImportWarning {
  code: ImportWarningCode;
  /** Fills `{name}` holes in the viewer's catalog sentence for this code. */
  detail?: Record<string, string | number>;
}

export interface ImportSourceInfo {
  kind: ImportSourceKind;
  /** What to call it in the commit message and source note: a filename, a page title, a Doc name. */
  name: string;
  url?: string;
  pages?: number;
}

export interface ConvertedDocument {
  /** Markdown body WITHOUT the source note; `source-note.ts` prepends that at commit time. */
  markdown: string;
  /** Best available title, for the suggested filename and the `# ` heading when the body has none. */
  title: string;
  assets: ImportAsset[];
  rejectedAssets: RejectedAsset[];
  warnings: ImportWarning[];
  source: ImportSourceInfo;
}

/**
 * What a source reports while it works. `step` is a stable key the viewer maps
 * to a sentence in the reader's language; `label` is English for logs and for a
 * client that has no word for a step yet.
 */
export interface ImportProgressEvent {
  step: 'checking' | 'fetching' | 'converting' | 'ready';
  label: string;
  /** Optional sub-progress (e.g. PDF chunk 2 of 5). */
  current?: number;
  total?: number;
}

export type ImportProgressListener = (event: ImportProgressEvent) => void;

/**
 * A refusal the route can answer with as-is: the docs API error code plus the
 * HTTP status that fits it. Sources throw this for anything the manager can act
 * on (too large, blocked URL, encrypted PDF …); anything else is a plain Error
 * and becomes `import_conversion_failed`.
 *
 * `code` is typed as string here rather than `DocsApiErrorCode` so the sources
 * can be written before the codes land in `services/docs-editor/api-errors.ts`
 * (another session owns that file at the time of writing). The route narrows it.
 */
export class ImportRefusal extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail?: Record<string, string | number>;

  constructor(status: number, code: string, detail?: Record<string, string | number>) {
    super(code);
    this.name = 'ImportRefusal';
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}
