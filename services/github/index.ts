// Export types and interfaces
export type { MarkdownFile } from './file-manager';
export type { GithubCommit, CommitInfo, CommitMessage } from './commit-manager';

// Export main service
export { default as GithubService } from './refactored-service';

// Export component services for direct access if needed
export { GitHubFileManager } from './file-manager';
export { GitHubCommitManager } from './commit-manager';

// Re-export applyDocumentUpdatesToGithub function from old service
export { applyDocumentUpdatesToGithub } from './document-updater';
