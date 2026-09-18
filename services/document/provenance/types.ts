export type ProvenanceType = 'update' | 'append' | 'new-file' | 'web-edit' | 'gdocs-edit';

export interface ProvenanceMessage {
  userId?: string;
  username?: string;
  text?: string;
  ts?: string;
}

/**
 * The "why" behind a single document change, committed (encrypted) alongside the
 * change itself under `.choir/context/`. See docs/update-provenance.md.
 */
export interface ProvenanceRecord {
  version: 1;
  type: ProvenanceType;
  file: { path: string; name: string };
  createdAt: string; // ISO
  updatedBy: { userId?: string; name?: string };
  // Where the change came from: a Slack thread, the Google Doc replica it was
  // written in ('gdocs-edit'), or — for a document that was imported — the file,
  // page or Doc it was converted from. `editor` is the person on the Google
  // path and the literal 'web' for anything typed or imported in the viewer.
  source?: {
    channelId?: string;
    threadTs?: string;
    fileId?: string;
    editor?: string;
    /** Which import source produced the document ('new-file' records only). */
    import?: 'pdf' | 'url' | 'google-docs';
    /** What the source called it: a filename, a page title, a Doc name. */
    name?: string;
    url?: string;
    /** Pages read, for a PDF. */
    pages?: number;
  };
  knowledge: string; // extracted knowledge ("" for web-edit and gdocs-edit)
  messages: ProvenanceMessage[]; // conversation as-is ([] for web-edit and gdocs-edit)
  diff: {
    before: string; // whole-file content before the change ("" for new-file)
    after: string; // whole-file content after the change
    sections?: string[]; // touched heading paths (hint)
    nodeIds?: string[]; // touched node ids (hint)
  };
}
