import { useT } from '../i18n';
import type { DocFile, FolderNode, RepoInfo } from '../types';
import { buildFolderTree, dashboardPath, encodePath, folderContainsPath, formatTitle, navigate } from '../utils/docs';
import { ImportMenu } from './ImportMenu';

type FilesSidebarProps = {
  files: DocFile[];
  currentPath: string;
  repo: RepoInfo | null;
  workspaceId: string;
  canSeeInsights: boolean;
  /** Only a manager who can push is offered a way to add a document. */
  canCreate: boolean;
  onNewDocument: () => void;
  /** "회의록 만들기" — a transcript becomes a meeting note. Same right as `canCreate`. */
  onMeetingNote: () => void;
  /** "용어집 만들기" — seed documents become a `GLOSSARY.md`. Same right. */
  onGlossary: () => void;
  /** Folders that already carry a `.choir/project.json`, so they can be marked. */
  projectFolders: Set<string>;
  /** Opens the project settings dialog for a folder. Same right as `canCreate`. */
  onProjectSettings?: (folder: string) => void;
};

export function FilesSidebar({
  files,
  currentPath,
  repo,
  workspaceId,
  canSeeInsights,
  canCreate,
  onNewDocument,
  onMeetingNote,
  onGlossary,
  projectFolders,
  onProjectSettings,
}: FilesSidebarProps) {
  const t = useT();
  const tree = buildFolderTree(files);
  const repoLabel = repo ? `${repo.owner}/${repo.name}` : t('sidebar.repo.fallback');
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
        <span className="folder-actions">
          {/* A project is worth recognising at a glance — which folder a
              channel's questions land in is otherwise invisible here. */}
          {projectFolders.has(folder.path) && (
            <span className="folder-project-badge" title={t('project.badge.title')}>
              {t('project.badge.label')}
            </span>
          )}
          {onProjectSettings && (
            // Inside a <summary>, so the default action (toggling the folder)
            // has to be stopped as well as the bubbling.
            <button
              type="button"
              className="folder-project-gear"
              aria-label={t('project.aria.settings')}
              title={t('project.aria.settings')}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onProjectSettings(folder.path);
              }}
            >
              <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
                <path
                  fill="currentColor"
                  d="M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Zm0 1.5a1 1 0 1 1 0 2 1 1 0 0 1 0-2Z"
                />
                <path
                  fill="currentColor"
                  d="M6.94 1.5a.75.75 0 0 0-.73.58l-.2.87a5.5 5.5 0 0 0-.94.55l-.85-.28a.75.75 0 0 0-.88.33l-1.06 1.84a.75.75 0 0 0 .15.93l.66.59a5.6 5.6 0 0 0 0 1.08l-.66.59a.75.75 0 0 0-.15.93l1.06 1.84c.18.31.55.45.88.33l.85-.28c.29.22.6.4.94.55l.2.87c.08.34.38.58.73.58h2.12c.35 0 .65-.24.73-.58l.2-.87c.34-.15.65-.33.94-.55l.85.28c.33.12.7-.02.88-.33l1.06-1.84a.75.75 0 0 0-.15-.93l-.66-.59a5.6 5.6 0 0 0 0-1.08l.66-.59a.75.75 0 0 0 .15-.93l-1.06-1.84a.75.75 0 0 0-.88-.33l-.85.28a5.5 5.5 0 0 0-.94-.55l-.2-.87a.75.75 0 0 0-.73-.58H6.94Zm.6 1.5h.92l.16.68c.06.27.26.48.52.56.34.1.66.29.94.53.21.18.5.24.76.15l.66-.22.46.8-.51.46c-.2.18-.3.46-.25.73.03.18.05.37.05.56s-.02.38-.05.56c-.05.27.04.55.25.73l.51.46-.46.8-.66-.22a.75.75 0 0 0-.76.15c-.28.24-.6.42-.94.53a.75.75 0 0 0-.52.56l-.16.68h-.92l-.16-.68a.75.75 0 0 0-.52-.56 4 4 0 0 1-.94-.53.75.75 0 0 0-.76-.15l-.66.22-.46-.8.51-.46c.2-.18.3-.46.25-.73A3.6 3.6 0 0 1 4.5 8c0-.19.02-.38.05-.56a.75.75 0 0 0-.25-.73l-.51-.46.46-.8.66.22c.26.09.55.03.76-.15.28-.24.6-.43.94-.53a.75.75 0 0 0 .52-.56l.16-.68Z"
                />
              </svg>
            </button>
          )}
        </span>
      </summary>
      <div className="folder-children">
        {folder.folders.map(renderFolder)}
        {folder.files.map(renderFile)}
      </div>
    </details>
  );

  return (
    <aside className="docs-sidebar" aria-label={t('sidebar.aria.documents')}>
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
            {repo?.branch
              ? t('sidebar.filesOnBranch', { count: files.length, branch: repo.branch })
              : t('sidebar.files', { count: files.length })}
          </div>
        </div>
      </div>
      <nav className="file-list">
        {tree.folders.map(renderFolder)}
        {tree.files.map(renderFile)}
        {canCreate && (
          // A button rather than a link, same as Insights below: DocViewer's
          // link interceptor treats every <a> in here as a document navigation.
          <button type="button" className="file-link insights-link" onClick={onNewDocument}>
            <span className="file-icon" aria-hidden="true">
              <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
                <path
                  fill="currentColor"
                  d="M8 2a.75.75 0 0 1 .75.75v4.5h4.5a.75.75 0 0 1 0 1.5h-4.5v4.5a.75.75 0 0 1-1.5 0v-4.5h-4.5a.75.75 0 0 1 0-1.5h4.5v-4.5A.75.75 0 0 1 8 2Z"
                />
              </svg>
            </span>
            <span className="file-label">{t('sidebar.newDocument')}</span>
          </button>
        )}
        {canCreate && (
          // Its own entry rather than a row in the import menu: a meeting note
          // is a feature with its own dialog, not a fourth source
          // (docs/meeting-notes-and-glossary.md, 결정 1).
          <button type="button" className="file-link insights-link" onClick={onMeetingNote}>
            <span className="file-icon" aria-hidden="true">
              <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
                <path
                  fill="currentColor"
                  d="M5.5 1.75a.75.75 0 0 1 1.5 0V3h2V1.75a.75.75 0 0 1 1.5 0V3h1.75c.97 0 1.75.78 1.75 1.75v7.5c0 .97-.78 1.75-1.75 1.75H3.75C2.78 14 2 13.22 2 12.25v-7.5C2 3.78 2.78 3 3.75 3H5.5V1.75ZM3.5 6.5v5.75c0 .14.11.25.25.25h8.5a.25.25 0 0 0 .25-.25V6.5h-9Zm1.75 2h5.5a.75.75 0 0 1 0 1.5h-5.5a.75.75 0 0 1 0-1.5Z"
                />
              </svg>
            </span>
            <span className="file-label">{t('sidebar.meetingNote')}</span>
          </button>
        )}
        {canCreate && (
          <button type="button" className="file-link insights-link" onClick={onGlossary}>
            <span className="file-icon" aria-hidden="true">
              <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
                <path
                  fill="currentColor"
                  d="M3.75 2h8.5c.97 0 1.75.78 1.75 1.75v8.5c0 .97-.78 1.75-1.75 1.75h-8.5C2.78 14 2 13.22 2 12.25v-8.5C2 2.78 2.78 2 3.75 2Zm0 1.5a.25.25 0 0 0-.25.25v8.5c0 .14.11.25.25.25H6v-9H3.75Zm3.75 0v9h4.75a.25.25 0 0 0 .25-.25v-8.5a.25.25 0 0 0-.25-.25H7.5Zm1.25 2h2.5a.75.75 0 0 1 0 1.5h-2.5a.75.75 0 0 1 0-1.5Z"
                />
              </svg>
            </span>
            <span className="file-label">{t('sidebar.glossary')}</span>
          </button>
        )}
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
            <span className="file-label">{t('sidebar.insights')}</span>
          </button>
        )}
        {/* One entry for all three sources; it hides itself when this reader
            may not import. The Google Docs button lives inside it. */}
        <ImportMenu workspaceId={workspaceId} />
      </nav>
    </aside>
  );
}
