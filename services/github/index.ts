// Export types and interfaces
export type { MarkdownFile } from './github-service';

// Export main service
export { default as GithubService } from './github-service';

// Export component services for direct access if needed (deprecated)
export { GitHubFileManager } from './file-manager';

// Re-export applyDocumentUpdatesToGithub function from old service
export { applyDocumentUpdatesToGithub } from './document-updater';
