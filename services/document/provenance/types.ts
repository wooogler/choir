export type ProvenanceType = 'update' | 'append' | 'new-file' | 'web-edit';

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
  source?: { channelId?: string; threadTs?: string };
  knowledge: string; // extracted knowledge ("" for web-edit)
  messages: ProvenanceMessage[]; // conversation as-is ([] for web-edit)
  diff: {
    before: string; // whole-file content before the change ("" for new-file)
    after: string; // whole-file content after the change
    sections?: string[]; // touched heading paths (hint)
    nodeIds?: string[]; // touched node ids (hint)
  };
}
