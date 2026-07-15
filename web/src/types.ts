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

export type SessionInfo =
  | { authenticated: false }
  | { authenticated: true; workspaceId: string; userId: string; isManager: boolean; isChoirUser: boolean };

// ── Awareness dashboard API response shapes (mirror services/dashboard/dashboard-api.ts) ──

export type WeekPoint = { isoWeek: string; total: number; answered: number; answeredRatio: number };

export type DashboardSummary = {
  weeks: WeekPoint[];
  totals: { questions: number; answered: number; answeredRatio: number; activeTopics: number };
};

export type TopicView = {
  topicId: number;
  label: string;
  representative: string;
  total: number;
  answered: number;
  answeredRatio: number;
  weeklyCounts: Record<string, number>;
};

export type TopicsResponse = { topics: TopicView[]; other: { count: number } };

export type GapView = {
  topicId: number;
  label: string;
  representative: string;
  total: number;
  unanswered: number;
  answeredRatio: number;
  relatedDocs: Array<{ fileName: string; headingPath: string | null; count: number }>;
};

export type GapsResponse = { gaps: GapView[]; other: { unanswered: number } };

export type DocUsageFile = { fileName: string; retrievals: number; unanswered: number; lastWeek: string };
export type DocUsageResponse = { files: DocUsageFile[] };
