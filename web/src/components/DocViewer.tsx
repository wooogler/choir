import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DocFile, RepoInfo, TocItem } from '../types';
import { encodePath, extractToc, parseDocsUrl, scrollToAnchor, slugifyHeading } from '../utils/docs';
import { CommitDialog } from './CommitDialog';
import { CrepeEditor, type CrepeEditorHandle } from './CrepeEditor';
import { DocHeader } from './DocHeader';
import { FilesSidebar } from './FilesSidebar';
import { FloatingToc } from './FloatingToc';

type DocViewerProps = {
  workspaceId: string;
  initialFilePath: string;
};

type SessionInfo =
  | { authenticated: false }
  | { authenticated: true; workspaceId: string; userId: string; isManager: boolean };

const MOBILE_BREAKPOINT = 820;
const HIGHLIGHT_BLOCK_SELECTOR = 'li, p, h1, h2, h3, h4, h5, h6, pre, td, th, hr';

function isMobileViewport(): boolean {
  return typeof window !== 'undefined' && window.innerWidth <= MOBILE_BREAKPOINT;
}

function normalizeBlockText(el: HTMLElement): string {
  const clone = el.cloneNode(true);
  if (clone instanceof HTMLElement && clone.tagName === 'LI') {
    for (const nestedList of clone.querySelectorAll('ul, ol')) {
      nestedList.remove();
    }
  }
  return clone.textContent?.replace(/\s+/g, ' ').trim() ?? '';
}

function findChangedBlockIndexes(previousTexts: string[], currentTexts: string[]): Set<number> {
  const dp = Array.from({ length: previousTexts.length + 1 }, () => Array(currentTexts.length + 1).fill(0));

  for (let i = previousTexts.length - 1; i >= 0; i -= 1) {
    for (let j = currentTexts.length - 1; j >= 0; j -= 1) {
      dp[i][j] = previousTexts[i] === currentTexts[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const unchangedCurrentIndexes = new Set<number>();
  let previousIndex = 0;
  let currentIndex = 0;
  while (previousIndex < previousTexts.length && currentIndex < currentTexts.length) {
    if (previousTexts[previousIndex] === currentTexts[currentIndex]) {
      unchangedCurrentIndexes.add(currentIndex);
      previousIndex += 1;
      currentIndex += 1;
    } else if (dp[previousIndex + 1][currentIndex] >= dp[previousIndex][currentIndex + 1]) {
      previousIndex += 1;
    } else {
      currentIndex += 1;
    }
  }

  const changedIndexes = new Set<number>();
  currentTexts.forEach((_text, index) => {
    if (!unchangedCurrentIndexes.has(index)) {
      changedIndexes.add(index);
    }
  });
  return changedIndexes;
}

export function DocViewer({ workspaceId, initialFilePath }: DocViewerProps) {
  const [error, setError] = useState('');
  const [filePath, setFilePath] = useState(initialFilePath);
  const [files, setFiles] = useState<DocFile[]>([]);
  const [repo, setRepo] = useState<RepoInfo | null>(null);
  const [loadedMarkdown, setLoadedMarkdown] = useState<string | null>(null);
  const [currentMarkdown, setCurrentMarkdown] = useState<string>('');
  const [toc, setToc] = useState<TocItem[]>([]);
  const [activeSlug, setActiveSlug] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  const [showCommitDialog, setShowCommitDialog] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(() => !isMobileViewport());
  const [editorKey, setEditorKey] = useState(0);
  const [changedBlockCount, setChangedBlockCount] = useState(0);

  const editorHandleRef = useRef<CrepeEditorHandle | null>(null);
  const editorContainerRef = useRef<HTMLDivElement | null>(null);
  const editStartMarkdownRef = useRef<string | null>(null);
  const documentEditStartBlockTextsRef = useRef<string[]>([]);
  const changedBlockElsRef = useRef<Set<HTMLElement>>(new Set());

  const dirty = changedBlockCount > 0;
  const canEdit = session?.authenticated === true && session.isManager;
  const sessionLoaded = session !== null;
  const editorReady = loadedMarkdown !== null;

  const breadcrumb = useMemo(() => filePath, [filePath]);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/docs/session', { credentials: 'same-origin' })
      .then((r) => (r.ok ? (r.json() as Promise<SessionInfo>) : Promise.reject(new Error(`${r.status}`))))
      .then((data) => {
        if (!cancelled) setSession(data);
      })
      .catch(() => {
        if (!cancelled) setSession({ authenticated: false });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const handlePopState = () => {
      const parsed = parseDocsUrl();
      if (parsed) setFilePath(parsed.filePath);
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  useEffect(() => {
    fetch(`/api/docs/${encodeURIComponent(workspaceId)}`)
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
        return r.json() as Promise<{ files: DocFile[]; repo: RepoInfo | null }>;
      })
      .then(({ files, repo }) => {
        setFiles(files);
        setRepo(repo);
      })
      .catch(() => {
        setFiles([]);
        setRepo(null);
      });
  }, [workspaceId]);

  useEffect(() => {
    const handleClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      const link = target?.closest<HTMLAnchorElement>('a[href^="/docs/"]');
      if (!link || link.origin !== window.location.origin) return;

      const parsedPath = link.pathname.match(/^\/docs\/([^/]+)\/(.+)$/);
      if (!parsedPath) return;

      if (dirty) {
        const proceed = window.confirm('Unsaved changes will be lost. Continue?');
        if (!proceed) {
          event.preventDefault();
          return;
        }
      }

      event.preventDefault();
      window.history.pushState(null, '', link.href);
      setFilePath(decodeURIComponent(parsedPath[2]));
      setIsEditing(false);
      if (isMobileViewport()) {
        setSidebarOpen(false);
      }
      window.scrollTo({ top: 0, behavior: 'smooth' });
    };

    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, [dirty]);

  const clearChangedBlockMarks = useCallback(() => {
    for (const el of changedBlockElsRef.current) {
      el.classList.remove('block-changed');
    }
    changedBlockElsRef.current.clear();
    setChangedBlockCount(0);
  }, []);

  const markChangedBlock = useCallback((el: HTMLElement) => {
    el.classList.add('block-changed');
    changedBlockElsRef.current.add(el);
    setChangedBlockCount(changedBlockElsRef.current.size);
  }, []);

  const clearEditSession = useCallback(() => {
    editStartMarkdownRef.current = null;
  }, []);

  useEffect(() => {
    setLoadedMarkdown(null);
    setCurrentMarkdown('');
    setError('');
    setSaveError(null);
    setIsEditing(false);
    clearChangedBlockMarks();
    clearEditSession();

    fetch(`/api/docs/${encodeURIComponent(workspaceId)}/${encodePath(filePath)}`)
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
        return r.json() as Promise<{ content: string; filePath: string }>;
      })
      .then(({ content }) => {
        setToc(extractToc(content));
        setLoadedMarkdown(content);
        setCurrentMarkdown(content);
        setEditorKey((k) => k + 1);
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : 'Failed to load document');
      });
  }, [workspaceId, filePath, clearChangedBlockMarks, clearEditSession]);

  useEffect(() => {
    if (loadedMarkdown === null) return;
    const id = setTimeout(() => scrollToAnchor(window.location.hash), 100);
    return () => clearTimeout(id);
  }, [loadedMarkdown]);

  useEffect(() => {
    if (loadedMarkdown === null || toc.length === 0) return;

    const updateActiveHeading = () => {
      const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6'));
      let currentSlug = toc[0]?.slug ?? '';

      for (const heading of headings) {
        const rect = heading.getBoundingClientRect();
        if (rect.top > 150) break;

        const slug = slugifyHeading(heading.textContent ?? '');
        if (toc.some((item) => item.slug === slug)) {
          currentSlug = slug;
        }
      }

      setActiveSlug(currentSlug);
    };

    updateActiveHeading();
    window.addEventListener('scroll', updateActiveHeading, { passive: true });
    window.addEventListener('resize', updateActiveHeading);
    return () => {
      window.removeEventListener('scroll', updateActiveHeading);
      window.removeEventListener('resize', updateActiveHeading);
    };
  }, [loadedMarkdown, toc]);

  useEffect(() => {
    if (!dirty) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  const handleMarkdownChange = useCallback((next: string) => {
    setCurrentMarkdown(next);
  }, []);

  const getHighlightBlocks = useCallback((): HTMLElement[] => {
    const proseEl = editorContainerRef.current?.querySelector('.ProseMirror');
    if (!proseEl) return [];
    return Array.from(proseEl.querySelectorAll<HTMLElement>(HIGHLIGHT_BLOCK_SELECTOR)).filter((el) => {
      if (el.tagName !== 'LI' && el.closest('li')) return false;
      if (el.tagName !== 'TD' && el.tagName !== 'TH' && el.closest('td, th')) return false;
      return true;
    });
  }, []);

  const markDocumentChangedBlocks = useCallback(
    (forceFallback: boolean) => {
      const previousTexts = documentEditStartBlockTextsRef.current;
      const blocks = getHighlightBlocks();
      const currentTexts = blocks.map(normalizeBlockText);
      const beforeCount = changedBlockElsRef.current.size;
      const changedIndexes = findChangedBlockIndexes(previousTexts, currentTexts);

      blocks.forEach((block, index) => {
        if (changedIndexes.has(index)) {
          markChangedBlock(block);
        }
      });

      if (forceFallback && changedBlockElsRef.current.size === beforeCount && blocks[0]) {
        markChangedBlock(blocks[0]);
      }
    },
    [getHighlightBlocks, markChangedBlock],
  );

  const handleStartDocumentEdit = useCallback(() => {
    setNotice(null);
    setSaveError(null);
    clearEditSession();
    editStartMarkdownRef.current = editorHandleRef.current?.getMarkdown() || currentMarkdown;
    documentEditStartBlockTextsRef.current = getHighlightBlocks().map(normalizeBlockText);
    setIsEditing(true);
    editorHandleRef.current?.setReadonly(false);
  }, [clearEditSession, currentMarkdown, getHighlightBlocks]);

  const handleFinishDocumentEdit = useCallback(() => {
    const latest = editorHandleRef.current?.getMarkdown();
    const previous = editStartMarkdownRef.current;
    if (latest !== undefined) {
      setCurrentMarkdown(latest);
      setToc(extractToc(latest));
    }
    if (latest !== undefined && latest === loadedMarkdown) {
      clearChangedBlockMarks();
    } else if (previous !== null && latest !== undefined && latest !== previous) {
      markDocumentChangedBlocks(true);
    }
    setIsEditing(false);
    setSaveError(null);
    clearEditSession();
  }, [clearChangedBlockMarks, clearEditSession, loadedMarkdown, markDocumentChangedBlocks]);

  const handleCancelDocumentEdit = useCallback(() => {
    const previous = editStartMarkdownRef.current;
    if (previous !== null) {
      editorHandleRef.current?.replaceMarkdown(previous);
      setCurrentMarkdown(previous);
      setToc(extractToc(previous));
    }
    setIsEditing(false);
    setSaveError(null);
    clearEditSession();
  }, [clearEditSession]);

  const handleDiscard = useCallback(() => {
    if (dirty && !window.confirm('Discard all unsaved changes?')) return;
    if (loadedMarkdown !== null) {
      setCurrentMarkdown(loadedMarkdown);
      setToc(extractToc(loadedMarkdown));
      setEditorKey((k) => k + 1);
    }
    setIsEditing(false);
    clearChangedBlockMarks();
    clearEditSession();
    setSaveError(null);
  }, [clearChangedBlockMarks, clearEditSession, dirty, loadedMarkdown]);

  const handleSignIn = useCallback(() => {
    const next = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    const url = `/docs/auth/slack/start?workspaceId=${encodeURIComponent(workspaceId)}&next=${encodeURIComponent(next)}`;
    window.location.href = url;
  }, [workspaceId]);

  const handleSignOut = useCallback(async () => {
    try {
      await fetch('/api/docs/logout', { method: 'POST', credentials: 'same-origin' });
    } catch {
      // ignore — we still clear UI state below
    }
    setSession({ authenticated: false });
    setIsEditing(false);
    clearEditSession();
  }, [clearEditSession]);

  const handleSubmitCommit = useCallback(
    async (commitMessage: string) => {
      setSaving(true);
      setSaveError(null);

      try {
        const response = await fetch(`/api/docs/${encodeURIComponent(workspaceId)}/${encodePath(filePath)}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ content: currentMarkdown, commitMessage }),
        });

        if (!response.ok) {
          const data = (await response.json().catch(() => ({}))) as { error?: string };
          throw new Error(data.error || `${response.status} ${response.statusText}`);
        }

        const data = (await response.json()) as { commitSha?: string };
        setLoadedMarkdown(currentMarkdown);
        setToc(extractToc(currentMarkdown));
        setIsEditing(false);
        clearChangedBlockMarks();
        clearEditSession();
        setShowCommitDialog(false);
        // Force editor remount so dirty-blocks baseline is reset to the new content
        setEditorKey((k) => k + 1);
        setNotice(data.commitSha ? `Committed ${data.commitSha.slice(0, 7)} and refreshed the index.` : 'Saved.');
      } catch (error) {
        setSaveError(error instanceof Error ? error.message : 'Failed to save');
      } finally {
        setSaving(false);
      }
    },
    [clearChangedBlockMarks, clearEditSession, currentMarkdown, filePath, workspaceId],
  );

  const headerRight = (
    <>
      {canEdit && dirty && (
        <span className="doc-change-count">
          {changedBlockCount} changed {changedBlockCount === 1 ? 'block' : 'blocks'}
        </span>
      )}
      {canEdit && isEditing && (
        <>
          <button type="button" className="doc-button doc-button-primary" onClick={handleFinishDocumentEdit}>
            Done editing
          </button>
          <button type="button" className="doc-button doc-button-ghost" onClick={handleCancelDocumentEdit}>
            Cancel
          </button>
        </>
      )}
      {canEdit && !isEditing && (
        <button type="button" className="doc-button doc-button-ghost" onClick={handleStartDocumentEdit}>
          Edit document
        </button>
      )}
      {canEdit && dirty && (
        <>
          <button type="button" className="doc-button doc-button-ghost" onClick={handleDiscard} disabled={saving}>
            Discard
          </button>
          <button
            type="button"
            className="doc-button doc-button-primary"
            onClick={() => setShowCommitDialog(true)}
            disabled={!dirty || saving}
          >
            {dirty ? 'Save…' : 'No changes'}
          </button>
        </>
      )}
      {!isEditing && !dirty && sessionLoaded && canEdit && (
        <button type="button" className="doc-button doc-button-ghost" onClick={handleSignOut}>
          Sign out
        </button>
      )}
      {!isEditing && sessionLoaded && !canEdit && (
        <button type="button" className="doc-button doc-button-primary" onClick={handleSignIn}>
          Edit as manager
        </button>
      )}
    </>
  );

  const closeSidebarFromBackdrop = () => {
    if (isMobileViewport()) setSidebarOpen(false);
  };

  return (
    <div className={`docs-shell${sidebarOpen ? ' sidebar-open' : ' sidebar-closed'}`}>
      <button
        type="button"
        className={`sidebar-backdrop${sidebarOpen ? ' visible' : ''}`}
        onClick={closeSidebarFromBackdrop}
        aria-label="Close sidebar"
      />
      <FilesSidebar files={files} currentPath={filePath} repo={repo} workspaceId={workspaceId} />
      <div className="doc-main">
        <DocHeader
          breadcrumb={breadcrumb}
          onToggleSidebar={() => setSidebarOpen((v) => !v)}
          sidebarOpen={sidebarOpen}
          rightSlot={headerRight}
          dirty={dirty}
        />
        {error ? (
          <main className="doc-page error-page">
            <strong>Error:</strong> {error}
          </main>
        ) : (
          <main className="doc-page">
            {notice && <output className="doc-notice">{notice}</output>}
            {saveError && (
              <div className="doc-notice doc-notice-error" role="alert">
                {saveError}
              </div>
            )}
            {!editorReady && <div className="doc-loading">Loading document…</div>}
            <div className="doc-editor-wrap" ref={editorContainerRef}>
              {editorReady && (
                <CrepeEditor
                  key={editorKey}
                  ref={editorHandleRef}
                  markdown={loadedMarkdown}
                  editable={canEdit && isEditing}
                  onMarkdownChange={handleMarkdownChange}
                />
              )}
            </div>
          </main>
        )}
        <FloatingToc activeSlug={activeSlug} items={toc} />
      </div>
      {showCommitDialog && (
        <CommitDialog
          defaultMessage={`Update ${filePath}`}
          submitting={saving}
          onCancel={() => setShowCommitDialog(false)}
          onSubmit={handleSubmitCommit}
        />
      )}
    </div>
  );
}
