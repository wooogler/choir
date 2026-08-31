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
  // Where the change came from: a Slack thread, or the Google Doc replica it
  // was written in ('gdocs-edit').
  source?: { channelId?: string; threadTs?: string; fileId?: string; editor?: string };
  knowledge: string; // extracted knowledge ("" for web-edit and gdocs-edit)
  messages: ProvenanceMessage[]; // conversation as-is ([] for web-edit and gdocs-edit)
  diff: {
    before: string; // whole-file content before the change ("" for new-file)
    after: string; // whole-file content after the change
    sections?: string[]; // touched heading paths (hint)
    nodeIds?: string[]; // touched node ids (hint)
  };
}
