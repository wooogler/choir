import type { DocFile, FolderNode, RepoInfo } from '../types';
import { buildFolderTree, dashboardPath, encodePath, folderContainsPath, formatTitle, navigate } from '../utils/docs';

type FilesSidebarProps = {
  files: DocFile[];
  currentPath: string;
  repo: RepoInfo | null;
  workspaceId: string;
  canSeeInsights: boolean;
};

export function FilesSidebar({ files, currentPath, repo, workspaceId, canSeeInsights }: FilesSidebarProps) {
  const tree = buildFolderTree(files);
  const repoLabel = repo ? `${repo.owner}/${repo.name}` : 'Repository';
  const repoInitial = repo?.name?.[0]?.toUpperCase() || 'R';

  const renderFile = (file: DocFile) => {
    const active = file.path === currentPath;
    return (
      <a
        aria-current={active ? 'page' : undefined}
        className={`file-link${active ? ' active' : ''}`}
        href={`/docs/${encodeURIComponent(workspaceId)}/${encodePath(file.path)}`}
        key={file.path}
      >
        <span className="file-icon" aria-hidden="true">
          #
        </span>
        <span className="file-label">{formatTitle(file.path)}</span>
      </a>
    );
  };

  const renderFolder = (folder: FolderNode) => (
    <details className="folder-node" key={folder.path} open={folderContainsPath(folder, currentPath)}>
      <summary className="folder-summary">
        <span className="folder-caret" aria-hidden="true">
          &gt;
        </span>
        <span className="folder-label">{folder.name}</span>
      </summary>
      <div className="folder-children">
        {folder.folders.map(renderFolder)}
        {folder.files.map(renderFile)}
      </div>
    </details>
  );

  return (
    <aside className="docs-sidebar" aria-label="Documents">
      <div className="sidebar-header">
        <div className="workspace-mark">{repoInitial}</div>
        <div>
          {repo ? (
            <a className="sidebar-title repo-link" href={repo.url} rel="noreferrer" target="_blank">
              {repoLabel}
            </a>
          ) : (
            <div className="sidebar-title">{repoLabel}</div>
          )}
          <div className="sidebar-subtitle">
            {files.length} files{repo?.branch ? ` on ${repo.branch}` : ''}
          </div>
        </div>
      </div>
      <nav className="file-list">
        {tree.folders.map(renderFolder)}
        {tree.files.map(renderFile)}
        {canSeeInsights && (
          // A button (not an <a href="/docs/…/dashboard">) so DocViewer's link
          // interceptor doesn't mistake it for a document navigation.
          <button
            type="button"
            className="file-link insights-link"
            onClick={() => navigate(dashboardPath(workspaceId, currentPath))}
          >
            <span className="file-icon" aria-hidden="true">
              <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
                <path
                  fill="currentColor"
                  d="M2 2a.75.75 0 0 1 .75.75v9.5h10.5a.75.75 0 0 1 0 1.5H2.75A1.75 1.75 0 0 1 1 12V2.75A.75.75 0 0 1 2 2Zm3.75 6a.75.75 0 0 1 .75.75v2a.75.75 0 0 1-1.5 0v-2A.75.75 0 0 1 5.75 8Zm3-3a.75.75 0 0 1 .75.75v5a.75.75 0 0 1-1.5 0v-5A.75.75 0 0 1 8.75 5Zm3 1.5a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0v-3.5a.75.75 0 0 1 .75-.75Z"
                />
              </svg>
            </span>
            <span className="file-label">Insights</span>
          </button>
        )}
      </nav>
    </aside>
  );
}
