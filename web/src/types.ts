import type { Locale } from './i18n/supported-locales';
import type { ParamValue } from './i18n/types';
import type { InlineSegment } from './utils/inline-markdown';

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
  segments: InlineSegment[];
  slug: string;
};

export type ProvenanceType = 'update' | 'append' | 'new-file' | 'web-edit' | 'gdocs-edit';

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
  source?: { channelId?: string; threadTs?: string; fileId?: string; editor?: string };
  knowledge: string;
  messages: ProvenanceMessage[];
  diff: { before: string; after: string; sections?: string[]; nodeIds?: string[] };
};

export type ProvenanceListItem = ProvenanceRecord & { id: string };

/**
 * Whether the manager's linked GitHub account can commit to the workspace repo.
 * Present only for managers; absent on older servers, which the viewer treats as
 * "unknown" and lets the save endpoint decide.
 */
export type GithubWriteAccess = {
  connected: boolean;
  canPush: boolean;
  repo?: string;
  /** A `DocsApiErrorCode`, or an English sentence from a server that had none. */
  reason?: string;
  /** What that code's sentence names — the repository slug, in practice. */
  detail?: Record<string, ParamValue>;
};

/**
 * `language` is the reader's own CHOIR language setting, resolved server-side
 * (personal setting → Slack locale → Accept-Language → workspace default). It
 * is optional because the SPA also builds this object locally when the session
 * request fails, and because an older server may not send it.
 */
/**
 * What is actually stored behind the language a reader is served. `mine` is
 * null when they have made no choice, which the dialog shows as Automatic —
 * the resolved `language` alone cannot tell that apart from picking English.
 */
export type LanguageSettings = {
  mine: Locale | null;
  workspace: Locale;
  content: 'follow-conversation' | Locale;
};

export type SessionInfo =
  | { authenticated: false; language?: Locale }
  | {
      authenticated: true;
      workspaceId: string;
      userId: string;
      isManager: boolean;
      isChoirUser: boolean;
      github?: GithubWriteAccess;
      language?: Locale;
      languageSettings?: LanguageSettings;
    };

// ── Awareness dashboard API response shapes (mirror services/dashboard/dashboard-api.ts) ──

export type WeekPoint = { isoWeek: string; total: number; answered: number; answeredRatio: number };

export type DashboardSummary = {
  weeks: WeekPoint[];
  totals: { questions: number; answered: number; answeredRatio: number; activeTopics: number };
};

/**
 * `labelLocale` is the language `label`/`representative` actually came back in.
 * Topic labels are generated in English and translated for display, so a topic
 * with no translation for the reader's locale falls back to `en`. Optional
 * because an older server does not send it.
 */
export type TopicView = {
  topicId: number;
  label: string;
  representative: string;
  labelLocale?: Locale;
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
  /** See `TopicView.labelLocale`. */
  labelLocale?: Locale;
  total: number;
  unanswered: number;
  answeredRatio: number;
  relatedDocs: Array<{ fileName: string; headingPath: string | null; count: number }>;
};

export type GapsResponse = { gaps: GapView[]; other: { unanswered: number } };

export type DocUsageFile = { fileName: string; retrievals: number; unanswered: number; lastWeek: string };
export type DocUsageResponse = { files: DocUsageFile[] };

export type DocSectionUsage = {
  sectionId: string | null;
  headingPath: string | null;
  retrievals: number;
  unanswered: number;
};
export type DocSectionUsageResponse = { file: string; sections: DocSectionUsage[] };
