export type DocFile = {
  path: string;
  name: string;
};

export type RepoInfo = {
  owner: string;
  name: string;
  branch?: string;
  url: string;
};

export type FolderNode = {
  name: string;
  path: string;
  folders: FolderNode[];
  files: DocFile[];
};

export type TocItem = {
  id: string;
  label: string;
  level: number;
  slug: string;
};

export type ProvenanceType = 'update' | 'append' | 'new-file' | 'web-edit';

export type ProvenanceMessage = {
  userId?: string;
  username?: string;
  text?: string;
  ts?: string;
};

export type ProvenanceRecord = {
  version: number;
  type: ProvenanceType;
  file: { path: string; name: string };
  createdAt: string;
  updatedBy: { userId?: string; name?: string };
  source?: { channelId?: string; threadTs?: string };
  knowledge: string;
  messages: ProvenanceMessage[];
  diff: { before: string; after: string; sections?: string[]; nodeIds?: string[] };
};

export type ProvenanceListItem = ProvenanceRecord & { id: string };
