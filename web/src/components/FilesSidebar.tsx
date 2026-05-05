import type { DocFile, FolderNode, RepoInfo } from '../types';
import { buildFolderTree, encodePath, folderContainsPath, formatTitle } from '../utils/docs';

type FilesSidebarProps = {
  files: DocFile[];
  currentPath: string;
  repo: RepoInfo | null;
  workspaceId: string;
};

export function FilesSidebar({ files, currentPath, repo, workspaceId }: FilesSidebarProps) {
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
      </nav>
    </aside>
  );
}
