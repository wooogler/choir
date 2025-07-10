// Export types and interfaces
export type { MarkdownFile, GithubCommit, CommitInfo, CommitMessage } from './github-service';

// Export main service
export { default as GithubService } from './github-service';

// Export component services for direct access if needed (deprecated)
export { GitHubFileManager } from './file-manager';
export { GitHubCommitManager } from './commit-manager';

// Re-export applyDocumentUpdatesToGithub function from old service
export { applyDocumentUpdatesToGithub } from './document-updater';
