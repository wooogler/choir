// Common types used across the application
export interface GitHubRepo {
  owner: string;
  repo: string;
  branch?: string;
  path?: string;
  ref?: string;
}

export interface WorkspaceConfig {
  workspaceId: string;
  githubRepo?: GitHubRepo;
  qaChannelId?: string;
  managers: string[];
  allowedChannels?: string[];
  isPublic?: boolean;
}

export interface MarkdownFile {
  path: string;
  content: string;
  sha?: string;
  url?: string;
}

export interface EmbeddingDocument {
  content: string;
  metadata: {
    source: string;
    title?: string;
    section?: string;
    lineNumber?: number;
  };
}

export interface SearchResult {
  content: string;
  score: number;
  metadata: {
    source: string;
    title?: string;
    section?: string;
  };
}

export interface UserInteraction {
  timestamp: string;
  userId: string;
  workspaceId: string;
  action: string;
  details: Record<string, any>;
}