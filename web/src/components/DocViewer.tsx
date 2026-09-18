import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type Locale, type ServerErrorPayload, describeServerError, useLocale, useT } from '../i18n';
import type { DocFile, DocSectionUsage, LanguageSettings, RepoInfo, SessionInfo, TocItem } from '../types';
import {
  docsPath,
  encodePath,
  extractToc,
  parseDocsUrl,
  pickLandingFile,
  scrollToAnchor,
  slugifyHeading,
} from '../utils/docs';
import { inlineMarkdownToText } from '../utils/inline-markdown';
import { CommitDialog } from './CommitDialog';
import { CrepeEditor, type CrepeEditorHandle } from './CrepeEditor';
import { DeleteDocumentDialog } from './DeleteDocumentDialog';
import { DocHeader } from './DocHeader';
import { FilesSidebar } from './FilesSidebar';
import { FloatingToc } from './FloatingToc';
import { GoogleDocsReview } from './GoogleDocsReview';
import { GoogleDocsSync } from './GoogleDocsSync';
import { HistoryPanel } from './HistoryPanel';
import { SettingsDialog } from './SettingsDialog';

type DocViewerProps = {
  workspaceId: string;
  initialFilePath: string;
};

const MOBILE_BREAKPOINT = 820;
const HIGHLIGHT_BLOCK_SELECTOR = 'li, p, h1, h2, h3, h4, h5, h6, pre, td, th, hr';

function isMobileViewport(): boolean {
  return typeof window !== 'undefined' && window.innerWidth <= MOBILE_BREAKPOINT;
}

/**
 * The docs APIs require a workspace session; when a request returns 401 the
 * visitor is not signed in, so send them through the Slack OIDC flow and back
 * to the current page. (Sign-in sets the cookie, so this never loops.)
 */
function redirectToSignIn(workspaceId: string): void {
  const next = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  window.location.href = `/docs/auth/slack/start?workspaceId=${encodeURIComponent(
    workspaceId,
  )}&next=${encodeURIComponent(next)}`;
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

// Normalize a rendered block or a markdown source line to compare them: strip
// markdown syntax, collapse whitespace, lowercase. Used to map a rendered block
// back to its source line so the git-blame line→record map can place a marker.
//
// A rendered block only carries the *visible* text, so a source line's markdown
// links and images must collapse to their label/alt (dropping the URL) — otherwise
// e.g. `[SDK](https://x)` (source) never equals `SDK` (rendered) and the line
// silently loses its history marker.
function normalizeForLineMatch(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // ![alt](url) → alt
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // [label](url) → label
    .replace(/[#>*_`~[\]()!-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function DocViewer({ workspaceId, initialFilePath }: DocViewerProps) {
  const t = useT();
  const { applySessionLanguage, setLocale } = useLocale();
  const [error, setError] = useState('');
  const [filePath, setFilePath] = useState(initialFilePath);
  const [files, setFiles] = useState<DocFile[]>([]);
  const [filesLoaded, setFilesLoaded] = useState(false);
  const [repo, setRepo] = useState<RepoInfo | null>(null);
  const [loadedMarkdown, setLoadedMarkdown] = useState<string | null>(null);
  const [currentMarkdown, setCurrentMarkdown] = useState<string>('');
  const [toc, setToc] = useState<TocItem[]>([]);
  const [activeSlug, setActiveSlug] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  const [showCommitDialog, setShowCommitDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [showSettingsDialog, setShowSettingsDialog] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [writeNoticeDismissed, setWriteNoticeDismissed] = useState(false);
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(() => !isMobileViewport());
  const [editorKey, setEditorKey] = useState(0);
  const [changedBlockCount, setChangedBlockCount] = useState(0);
  const [historyOpen, setHistoryOpen] = useState(false);
  // Slack's "Review changes" card links straight here.
  const [gdocsReviewOpen, setGdocsReviewOpen] = useState(
    () => new URLSearchParams(window.location.search).get('gdocsReview') === '1',
  );
  const [lineProvenance, setLineProvenance] = useState<Record<number, string> | null>(null);
  // The document content from the SAME git-clone snapshot blame ran against; the
  // line→record map is keyed to THIS content, so markers must be matched against
  // it (not the possibly-divergent API-mirror content the editor renders).
  const [provenanceContent, setProvenanceContent] = useState<string | null>(null);
  const [historyFocus, setHistoryFocus] = useState<{ id: string; key: number } | null>(null);
  // Q&A usage highlight: shade sections that were retrieved to answer questions.
  const [qaUsageOn, setQaUsageOn] = useState<boolean>(() => {
    try {
      if (new URLSearchParams(window.location.search).get('usage') === '1') return true;
      return window.localStorage.getItem('choir_qa_usage') === '1';
    } catch {
      return false;
    }
  });
  const [usageSections, setUsageSections] = useState<DocSectionUsage[] | null>(null);
  const [usageUnmatched, setUsageUnmatched] = useState(0);

  const editorHandleRef = useRef<CrepeEditorHandle | null>(null);
  const editorContainerRef = useRef<HTMLDivElement | null>(null);
  const gutterRef = useRef<HTMLDivElement | null>(null);
  const editStartMarkdownRef = useRef<string | null>(null);
  const documentEditStartBlockTextsRef = useRef<string[]>([]);
  const changedBlockElsRef = useRef<Set<HTMLElement>>(new Set());

  const dirty = changedBlockCount > 0;
  // A manager whose GitHub account cannot push to the repo must not be offered
  // the editor: the commit would be refused and the edit lost. `github` is
  // absent on older servers, which we read as "unknown" and allow.
  const isManager = session?.authenticated === true && session.isManager;
  const githubAccess = session?.authenticated === true ? session.github : undefined;
  // Absent on an unauthenticated session, and on a server older than the
  // settings endpoint — the button stays hidden rather than opening a dialog
  // with nothing to show.
  const languageSettings = session?.authenticated === true ? session.languageSettings : undefined;
  // `reason` is a `DocsApiErrorCode` for every answer CHOIR can give itself —
  // no repository connected, no linked account, archived, read-only, invisible
  // — with `detail` holding the repository slug its sentence names. An older
  // server sends a finished English sentence instead; `describeServerError`
  // handles both.
  const writeBlockedReason =
    (isManager && githubAccess?.canPush === false
      ? describeServerError(t, { error: githubAccess.reason, detail: githubAccess.detail })
      : null) ?? null;
  const canEdit = isManager && !writeBlockedReason;
  const canSeeInsights = session?.authenticated === true && session.isChoirUser;
  const sessionLoaded = session !== null;
  const editorReady = loadedMarkdown !== null;

  const breadcrumb = useMemo(() => filePath, [filePath]);

  // Dismissing the read-only notice is per-visit: a new reason (or a reload
  // after access is granted) should speak up again. The header keeps the
  // Read-only chip either way, so closing it never hides the state entirely.
  // biome-ignore lint/correctness/useExhaustiveDependencies: resetting on a new reason is the point
  useEffect(() => {
    setWriteNoticeDismissed(false);
  }, [writeBlockedReason]);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/docs/session', { credentials: 'same-origin' })
      .then((r) => (r.ok ? (r.json() as Promise<SessionInfo>) : Promise.reject(new Error(`${r.status}`))))
      .then((data) => {
        if (cancelled) return;
        setSession(data);
        // The reader's CHOIR language setting, which outranks the browser's own
        // preference the provider started with.
        applySessionLanguage(data.language);
      })
      .catch(() => {
        if (!cancelled) setSession({ authenticated: false });
      });
    return () => {
      cancelled = true;
    };
  }, [applySessionLanguage]);

  useEffect(() => {
    const handlePopState = () => {
      const parsed = parseDocsUrl();
      if (!parsed || parsed.filePath === filePath) return;

      // Back/forward navigation, like an in-app link click, must not silently
      // discard unsaved edits. popstate can't be vetoed, so on cancel we re-push
      // the current document's URL to keep the address bar and content in sync.
      if (dirty && !window.confirm(t('viewer.confirm.unsavedChanges'))) {
        window.history.pushState(null, '', `/docs/${encodeURIComponent(workspaceId)}/${encodePath(filePath)}`);
        return;
      }

      setFilePath(parsed.filePath);
      setIsEditing(false);
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [dirty, filePath, workspaceId, t]);

  useEffect(() => {
    fetch(`/api/docs/${encodeURIComponent(workspaceId)}`, { credentials: 'same-origin' })
      .then((r) => {
        if (r.status === 401) {
          redirectToSignIn(workspaceId);
          throw new Error(t('viewer.error.signInRequired'));
        }
        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
        return r.json() as Promise<{ files: DocFile[]; repo: RepoInfo | null }>;
      })
      .then(({ files, repo }) => {
        setFiles(files);
        setRepo(repo);
        setFilesLoaded(true);
      })
      .catch(() => {
        setFiles([]);
        setRepo(null);
        setFilesLoaded(true);
      });
  }, [workspaceId, t]);

  // `/docs/:workspaceId` names no document. Once the listing is in, land on the
  // repository's front page and rewrite the address so reload and share work;
  // replaceState, not pushState, so Back leaves the viewer rather than bouncing.
  useEffect(() => {
    if (filePath !== '') return;
    const landing = pickLandingFile(files);
    if (!landing) return;
    window.history.replaceState(null, '', docsPath(workspaceId, landing.path));
    setFilePath(landing.path);
  }, [filePath, files, workspaceId]);

  useEffect(() => {
    const handleClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      const link = target?.closest<HTMLAnchorElement>('a[href^="/docs/"]');
      if (!link || link.origin !== window.location.origin) return;

      const parsedPath = link.pathname.match(/^\/docs\/([^/]+)\/(.+)$/);
      if (!parsedPath) return;

      if (dirty) {
        const proceed = window.confirm(t('viewer.confirm.unsavedChanges'));
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
  }, [dirty, t]);

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
    // Guard against a fetch race: when the user switches files, an earlier
    // request could resolve AFTER the current one and replace the visible doc
    // with the wrong file's content — which would then be committed to the new
    // path. Ignore any response once this effect run is superseded.
    let cancelled = false;

    setLoadedMarkdown(null);
    setCurrentMarkdown('');
    setError('');
    setSaveError(null);
    setIsEditing(false);
    clearChangedBlockMarks();
    clearEditSession();

    // No document yet (the workspace front door): the landing effect above
    // picks one, or the page says the repository is empty.
    if (filePath === '') return;

    fetch(`/api/docs/${encodeURIComponent(workspaceId)}/${encodePath(filePath)}`, { credentials: 'same-origin' })
      .then((r) => {
        if (r.status === 401) {
          redirectToSignIn(workspaceId);
          throw new Error(t('viewer.error.signInRequired'));
        }
        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
        return r.json() as Promise<{ content: string; filePath: string }>;
      })
      .then(({ content }) => {
        if (cancelled) return;
        setToc(extractToc(content));
        setLoadedMarkdown(content);
        setCurrentMarkdown(content);
        setEditorKey((k) => k + 1);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : t('viewer.error.loadFailed'));
      });

    return () => {
      cancelled = true;
    };
  }, [workspaceId, filePath, clearChangedBlockMarks, clearEditSession, t]);

  // Line-level provenance (git blame → record) for the gutter markers. Members only.
  useEffect(() => {
    if (loadedMarkdown === null || session?.authenticated !== true) {
      setLineProvenance(null);
      setProvenanceContent(null);
      return;
    }
    let cancelled = false;
    fetch(`/api/docs/${encodeURIComponent(workspaceId)}/provenance/${encodePath(filePath)}?lines=1`, {
      credentials: 'same-origin',
    })
      .then((r) =>
        r.ok ? (r.json() as Promise<{ lines: Record<number, string>; content?: string }>) : Promise.reject(new Error()),
      )
      .then((d) => {
        if (cancelled) return;
        setLineProvenance(d.lines);
        setProvenanceContent(d.content ?? null);
      })
      .catch(() => {
        if (cancelled) return;
        setLineProvenance(null);
        setProvenanceContent(null);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, filePath, loadedMarkdown, session]);

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

  const openHistoryAt = useCallback((recordId: string) => {
    setHistoryOpen(true);
    setHistoryFocus((prev) => ({ id: recordId, key: (prev?.key ?? 0) + 1 }));
  }, []);

  // Render gutter markers next to blocks whose source line has a provenance
  // record (per git blame). Clicking a marker opens the panel anchored to it.
  // historyOpen is an intentional layout-shift re-trigger: opening the panel
  // reflows content width, moving block (and marker) positions.
  // biome-ignore lint/correctness/useExhaustiveDependencies: historyOpen is a layout-shift re-trigger
  useEffect(() => {
    const gutter = gutterRef.current;
    const container = editorContainerRef.current;
    if (!gutter) return;

    const clear = () => gutter.replaceChildren();

    if (!editorReady || isEditing || !lineProvenance || loadedMarkdown === null || !container) {
      clear();
      return;
    }

    const render = () => {
      clear();
      // Match blocks against the git-clone snapshot (the content the line→record
      // map is keyed to), not the API-mirror content the editor renders — they can
      // diverge. Fall back to the rendered content only if the snapshot is absent.
      const lineSource = provenanceContent ?? loadedMarkdown;
      const srcLines = lineSource.split('\n').map((text, i) => ({ no: i + 1, norm: normalizeForLineMatch(text) }));
      const blocks = getHighlightBlocks();
      const containerTop = container.getBoundingClientRect().top;

      let cursor = 0;
      for (const block of blocks) {
        const bnorm = normalizeForLineMatch(block.textContent ?? '');
        if (!bnorm) continue;
        for (let i = cursor; i < srcLines.length; i += 1) {
          const ln = srcLines[i];
          // Strict whole-line equality (+ forward cursor for position): loose
          // substring matching attached markers to the wrong repeated line.
          if (ln.norm && ln.norm === bnorm) {
            const recordId = lineProvenance[ln.no];
            if (recordId) {
              const top = block.getBoundingClientRect().top - containerTop;
              const btn = document.createElement('button');
              btn.type = 'button';
              btn.className = 'doc-history-marker';
              btn.title = t('viewer.marker.title');
              btn.textContent = '🕘';
              btn.style.top = `${top}px`;
              btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                openHistoryAt(recordId);
              });
              gutter.appendChild(btn);
            }
            cursor = i + 1;
            break;
          }
        }
      }
    };

    // Recompute (debounced) whenever layout settles or shifts: the initial
    // render can land mid-transition, and block positions also move when the
    // sidebar/history panel animates, images finish loading, or fonts swap.
    let debounce = 0;
    const scheduleRender = () => {
      window.clearTimeout(debounce);
      debounce = window.setTimeout(render, 60);
    };

    const timer = window.setTimeout(render, 120);
    window.addEventListener('resize', scheduleRender);

    // A ResizeObserver on the content box catches reflow from the sidebar/panel
    // transition and image loads that a one-shot timeout would measure too early.
    const resizeObserver = new ResizeObserver(scheduleRender);
    resizeObserver.observe(container);

    // Images have no height until loaded, which shifts every block below them.
    const images = Array.from(container.querySelectorAll('img'));
    const onImageSettled = () => scheduleRender();
    for (const img of images) {
      if (!img.complete) {
        img.addEventListener('load', onImageSettled);
        img.addEventListener('error', onImageSettled);
      }
    }

    return () => {
      window.clearTimeout(timer);
      window.clearTimeout(debounce);
      window.removeEventListener('resize', scheduleRender);
      resizeObserver.disconnect();
      for (const img of images) {
        img.removeEventListener('load', onImageSettled);
        img.removeEventListener('error', onImageSettled);
      }
      clear();
    };
  }, [
    editorReady,
    isEditing,
    lineProvenance,
    provenanceContent,
    loadedMarkdown,
    historyOpen,
    sidebarOpen,
    getHighlightBlocks,
    openHistoryAt,
    t,
  ]);

  const toggleQaUsage = useCallback(() => {
    setQaUsageOn((v) => {
      const next = !v;
      try {
        window.localStorage.setItem('choir_qa_usage', next ? '1' : '0');
      } catch {
        // localStorage may be unavailable (private mode); the toggle still works for the session.
      }
      return next;
    });
  }, []);

  // Fetch per-section Q&A usage for the current file when the highlight is on.
  useEffect(() => {
    if (!qaUsageOn || !canSeeInsights) {
      setUsageSections(null);
      return;
    }
    let cancelled = false;
    fetch(`/api/dashboard/${encodeURIComponent(workspaceId)}/doc-usage?file=${encodeURIComponent(filePath)}`, {
      credentials: 'same-origin',
    })
      .then((r) =>
        r.ok ? (r.json() as Promise<{ sections?: DocSectionUsage[] }>) : Promise.reject(new Error(`${r.status}`)),
      )
      .then((data) => {
        if (!cancelled) setUsageSections(data.sections ?? []);
      })
      .catch(() => {
        if (!cancelled) setUsageSections([]);
      });
    return () => {
      cancelled = true;
    };
  }, [qaUsageOn, canSeeInsights, workspaceId, filePath]);

  // Shade each rendered section by how often it was retrieved to answer questions.
  // Highlights are plain classes on the rendered blocks, so they reflow with the
  // content (no gutter positioning needed). Only runs in read-only view.
  // biome-ignore lint/correctness/useExhaustiveDependencies: loadedMarkdown/editorKey re-trigger after the editor re-renders
  useEffect(() => {
    const container = editorContainerRef.current;
    if (!qaUsageOn || !usageSections || !editorReady || isEditing || !container) return;
    const proseEl = container.querySelector('.ProseMirror');
    if (!proseEl) return;

    // Aggregate usage by heading (the last segment of a chunk's heading path).
    const bySlug = new Map<string, { retrievals: number; unanswered: number }>();
    for (const section of usageSections) {
      if (!section.headingPath) continue;
      // The server stores heading text with its markdown markers, so strip them
      // first: the slug below is compared against one built from the *rendered*
      // heading's text, which has none.
      const slug = slugifyHeading(inlineMarkdownToText(section.headingPath.split('>').pop()?.trim() ?? ''));
      if (!slug) continue;
      const cur = bySlug.get(slug) ?? { retrievals: 0, unanswered: 0 };
      cur.retrievals += section.retrievals;
      cur.unanswered += section.unanswered;
      bySlug.set(slug, cur);
    }
    const maxRetrievals = Math.max(1, ...Array.from(bySlug.values()).map((u) => u.retrievals));
    const bucketOf = (n: number): number => {
      const r = n / maxRetrievals;
      return r > 0.75 ? 4 : r > 0.5 ? 3 : r > 0.25 ? 2 : 1;
    };
    const TINT_CLASSES = ['doc-usage-1', 'doc-usage-2', 'doc-usage-3', 'doc-usage-4'];

    // The count "chip" is a data-attribute + CSS ::after, NOT a child node: adding
    // a child would pollute heading.textContent and break slug-based TOC/anchors,
    // and injecting foreign nodes into ProseMirror is fragile.
    const clearHighlights = () => {
      for (const el of Array.from(proseEl.querySelectorAll<HTMLElement>('.doc-usage-hl'))) {
        el.classList.remove('doc-usage-hl', 'doc-usage-warn', ...TINT_CLASSES);
        el.removeAttribute('data-usage');
        if (el.dataset.usageTitle != null) {
          el.removeAttribute('title');
          delete el.dataset.usageTitle;
        }
      }
    };

    const apply = () => {
      clearHighlights();
      const matched = new Set<string>();
      let current: { level: number; bucket: number } | null = null;

      for (const el of Array.from(proseEl.children) as HTMLElement[]) {
        const headingLevel = /^H([1-6])$/.exec(el.tagName);
        if (headingLevel) {
          const level = Number(headingLevel[1]);
          if (current && level <= current.level) current = null; // section ended
          const slug = slugifyHeading(el.textContent ?? '');
          const usage = bySlug.get(slug);
          if (usage) {
            matched.add(slug);
            const bucket = bucketOf(usage.retrievals);
            current = { level, bucket };
            el.classList.add('doc-usage-hl', `doc-usage-${bucket}`);
            const answeredRatio = usage.retrievals > 0 ? (usage.retrievals - usage.unanswered) / usage.retrievals : 1;
            const weak = answeredRatio < 0.5;
            if (weak) el.classList.add('doc-usage-warn');
            el.setAttribute('data-usage', `${weak ? '⚠ ' : ''}${usage.retrievals}×`);
            el.title = t('viewer.usage.tooltip', { count: usage.retrievals, unanswered: usage.unanswered });
            el.dataset.usageTitle = '1';
          } else if (current) {
            el.classList.add('doc-usage-hl', `doc-usage-${current.bucket}`); // deeper subheading in a used section
          }
        } else if (current) {
          el.classList.add('doc-usage-hl', `doc-usage-${current.bucket}`);
        }
      }

      let unmatched = 0;
      for (const [slug, usage] of bySlug) if (!matched.has(slug)) unmatched += usage.retrievals;
      setUsageUnmatched(unmatched);
    };

    // The editor DOM can settle a tick after editorReady flips.
    const timer = window.setTimeout(apply, 120);
    return () => {
      window.clearTimeout(timer);
      clearHighlights();
      setUsageUnmatched(0);
    };
  }, [qaUsageOn, usageSections, editorReady, isEditing, loadedMarkdown, editorKey, t]);

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
    if (dirty && !window.confirm(t('viewer.confirm.discard'))) return;
    if (loadedMarkdown !== null) {
      setCurrentMarkdown(loadedMarkdown);
      setToc(extractToc(loadedMarkdown));
      setEditorKey((k) => k + 1);
    }
    setIsEditing(false);
    clearChangedBlockMarks();
    clearEditSession();
    setSaveError(null);
  }, [clearChangedBlockMarks, clearEditSession, dirty, loadedMarkdown, t]);

  const handleSignIn = useCallback(() => {
    redirectToSignIn(workspaceId);
  }, [workspaceId]);

  /**
   * Adopt what the server stored. The resolved language is applied straight
   * away so the page switches without a reload, and the settings are kept so
   * reopening the dialog shows the choice rather than the stale one.
   */
  const handleSettingsSaved = useCallback(
    (language: Locale, settings: LanguageSettings) => {
      setLocale(language);
      setSession((current) =>
        current?.authenticated === true ? { ...current, language, languageSettings: settings } : current,
      );
    },
    [setLocale],
  );

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

  const handleDeleteDocument = useCallback(async () => {
    setSaving(true);
    setSaveError(null);

    try {
      const response = await fetch(`/api/docs/${encodeURIComponent(workspaceId)}/${encodePath(filePath)}`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        // The server checks this against the path in the URL, so a stray click
        // on a different document cannot be what gets deleted.
        body: JSON.stringify({ confirmPath: filePath }),
      });

      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as ServerErrorPayload;
        throw new Error(describeServerError(t, data) ?? `${response.status} ${response.statusText}`);
      }

      const data = (await response.json()) as { nextFilePath?: string | null };
      setShowDeleteDialog(false);

      if (data.nextFilePath) {
        // A full load, not a pushState: the file tree is fetched once per
        // workspace, so a soft navigation would leave the deleted document in
        // the sidebar.
        window.location.href = docsPath(workspaceId, data.nextFilePath);
        return;
      }
      // Nothing left to show, and /docs/:workspaceId alone does not render a
      // document, so stay put and say so.
      setNotice(t('viewer.notice.deletedLast'));
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : t('viewer.error.deleteFailed'));
    } finally {
      setSaving(false);
    }
  }, [filePath, workspaceId, t]);

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
          const data = (await response.json().catch(() => ({}))) as ServerErrorPayload;
          throw new Error(describeServerError(t, data) ?? `${response.status} ${response.statusText}`);
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
        setNotice(
          data.commitSha ? t('viewer.notice.committed', { sha: data.commitSha.slice(0, 7) }) : t('viewer.notice.saved'),
        );
      } catch (error) {
        setSaveError(error instanceof Error ? error.message : t('viewer.error.saveFailed'));
      } finally {
        setSaving(false);
      }
    },
    [clearChangedBlockMarks, clearEditSession, currentMarkdown, filePath, workspaceId, t],
  );

  const headerRight = (
    <>
      {canSeeInsights && !isEditing && (
        <button
          type="button"
          className={`doc-button doc-button-ghost${qaUsageOn ? ' active' : ''}`}
          onClick={toggleQaUsage}
          title={t('viewer.button.qaUsage.title')}
        >
          {t('viewer.button.qaUsage')}
        </button>
      )}
      {sessionLoaded && !isEditing && (
        <button
          type="button"
          className={`doc-button doc-button-ghost${historyOpen ? ' active' : ''}`}
          onClick={() => setHistoryOpen((v) => !v)}
          title={t('viewer.button.history.title')}
        >
          {t('viewer.button.history')}
        </button>
      )}
      {languageSettings && !isEditing && (
        <button
          type="button"
          className="doc-iconbutton"
          aria-label={t('settings.aria.open')}
          title={t('settings.aria.open')}
          onClick={() => setShowSettingsDialog(true)}
        >
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
            <path
              fill="currentColor"
              d="M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5ZM6.5 8a1.5 1.5 0 1 1 3 0 1.5 1.5 0 0 1-3 0Z"
            />
            <path
              fill="currentColor"
              d="M6.94.75a.75.75 0 0 0-.74.63l-.22 1.32a5.5 5.5 0 0 0-.97.56l-1.25-.47a.75.75 0 0 0-.91.33L1.79 5.13a.75.75 0 0 0 .17.95l1.03.85a5.6 5.6 0 0 0 0 1.13l-1.03.85a.75.75 0 0 0-.17.95l1.06 1.84c.19.32.57.46.91.33l1.25-.47c.3.22.63.41.97.56l.22 1.32c.06.36.38.63.74.63h2.12c.36 0 .68-.27.74-.63l.22-1.32c.34-.15.67-.34.97-.56l1.25.47c.34.13.72-.01.91-.33l1.06-1.84a.75.75 0 0 0-.17-.95l-1.03-.85a5.6 5.6 0 0 0 0-1.13l1.03-.85a.75.75 0 0 0 .17-.95l-1.06-1.84a.75.75 0 0 0-.91-.33l-1.25.47a5.5 5.5 0 0 0-.97-.56L9.8 1.38a.75.75 0 0 0-.74-.63H6.94Zm.63 1.5h.86l.19 1.13c.04.27.24.49.5.57.42.13.8.35 1.14.65.2.18.5.23.75.13l1.07-.4.43.74-.88.73c-.21.17-.31.45-.25.72.09.43.09.87 0 1.3-.06.27.04.55.25.72l.88.73-.43.74-1.07-.4a.75.75 0 0 0-.75.13c-.34.3-.72.52-1.14.65a.75.75 0 0 0-.5.57l-.19 1.13h-.86l-.19-1.13a.75.75 0 0 0-.5-.57 4 4 0 0 1-1.14-.65.75.75 0 0 0-.75-.13l-1.07.4-.43-.74.88-.73c.21-.17.31-.45.25-.72a3.1 3.1 0 0 1 0-1.3.75.75 0 0 0-.25-.72l-.88-.73.43-.74 1.07.4c.25.1.55.05.75-.13.34-.3.72-.52 1.14-.65a.75.75 0 0 0 .5-.57l.19-1.13Z"
            />
          </svg>
        </button>
      )}
      {canEdit && dirty && (
        <span className="doc-change-count">{t('viewer.changedBlocks', { count: changedBlockCount })}</span>
      )}
      {canEdit && isEditing && (
        <>
          <button type="button" className="doc-button doc-button-primary" onClick={handleFinishDocumentEdit}>
            {t('viewer.button.doneEditing')}
          </button>
          <button type="button" className="doc-button doc-button-ghost" onClick={handleCancelDocumentEdit}>
            {t('common.button.cancel')}
          </button>
        </>
      )}
      {canEdit && !isEditing && (
        <button type="button" className="doc-button doc-button-ghost" onClick={handleStartDocumentEdit}>
          {t('viewer.button.editDocument')}
        </button>
      )}
      {canEdit && !isEditing && !dirty && (
        <button
          type="button"
          className="doc-button doc-button-ghost"
          onClick={() => setShowDeleteDialog(true)}
          disabled={saving}
        >
          {t('viewer.button.delete')}
        </button>
      )}
      {canEdit && dirty && (
        <>
          <button type="button" className="doc-button doc-button-ghost" onClick={handleDiscard} disabled={saving}>
            {t('viewer.button.discard')}
          </button>
          <button
            type="button"
            className="doc-button doc-button-primary"
            onClick={() => setShowCommitDialog(true)}
            disabled={!dirty || saving}
          >
            {dirty ? t('viewer.button.save') : t('viewer.button.noChanges')}
          </button>
        </>
      )}
      {writeBlockedReason && !isEditing && (
        <span className="doc-change-count" title={writeBlockedReason}>
          {t('viewer.readOnly')}
        </span>
      )}
      {!isEditing && !dirty && sessionLoaded && isManager && (
        <button type="button" className="doc-button doc-button-ghost" onClick={handleSignOut}>
          {t('viewer.button.signOut')}
        </button>
      )}
      {!isEditing && sessionLoaded && !isManager && (
        <button type="button" className="doc-button doc-button-primary" onClick={handleSignIn}>
          {t('viewer.button.editAsManager')}
        </button>
      )}
      {!isEditing && sessionLoaded && (
        <GoogleDocsSync
          workspaceId={workspaceId}
          filePath={filePath}
          isManager={isManager}
          onReview={isManager ? () => setGdocsReviewOpen(true) : undefined}
        />
      )}
    </>
  );

  const closeSidebarFromBackdrop = () => {
    if (isMobileViewport()) setSidebarOpen(false);
  };

  return (
    <div
      className={`docs-shell${sidebarOpen ? ' sidebar-open' : ' sidebar-closed'}${historyOpen ? ' history-open' : ''}`}
    >
      <button
        type="button"
        className={`sidebar-backdrop${sidebarOpen ? ' visible' : ''}`}
        onClick={closeSidebarFromBackdrop}
        aria-label={t('viewer.aria.closeSidebar')}
      />
      <FilesSidebar
        files={files}
        currentPath={filePath}
        repo={repo}
        workspaceId={workspaceId}
        canSeeInsights={canSeeInsights}
      />
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
            <strong>{t('viewer.error.prefix')}</strong> {error}
          </main>
        ) : filePath === '' ? (
          <main className="doc-page">
            <p className="doc-loading">{filesLoaded ? t('viewer.landing.noDocuments') : t('viewer.loadingDocument')}</p>
          </main>
        ) : (
          <main className="doc-page">
            {qaUsageOn && canSeeInsights && (
              <div className="doc-usage-legend">
                <span className="doc-usage-legend-swatch" /> {t('viewer.usage.legend')}
                {usageUnmatched > 0 && ` ${t('viewer.usage.unmatched', { count: usageUnmatched })}`}
              </div>
            )}
            {writeBlockedReason && !writeNoticeDismissed && (
              <output className="doc-notice doc-notice-error doc-notice-dismissible">
                <span>{writeBlockedReason}</span>
                <button
                  type="button"
                  className="doc-notice-close"
                  onClick={() => setWriteNoticeDismissed(true)}
                  aria-label={t('viewer.notice.dismiss.aria')}
                  title={t('viewer.notice.dismiss.title')}
                >
                  ×
                </button>
              </output>
            )}
            {notice && <output className="doc-notice">{notice}</output>}
            {/* Already translated: the save and delete handlers run the
                server's code through `describeServerError` first. */}
            {saveError && (
              <div className="doc-notice doc-notice-error" role="alert">
                {saveError}
              </div>
            )}
            {!editorReady && <div className="doc-loading">{t('viewer.loadingDocument')}</div>}
            <div className="doc-editor-wrap" ref={editorContainerRef}>
              <div className="doc-history-gutter" ref={gutterRef} aria-hidden="true" />
              {editorReady && (
                <CrepeEditor
                  key={editorKey}
                  ref={editorHandleRef}
                  markdown={loadedMarkdown}
                  editable={canEdit && isEditing}
                  workspaceId={workspaceId}
                  filePath={filePath}
                  onMarkdownChange={handleMarkdownChange}
                />
              )}
            </div>
          </main>
        )}
        <FloatingToc activeSlug={activeSlug} items={toc} />
      </div>
      {gdocsReviewOpen && isManager && (
        <GoogleDocsReview
          workspaceId={workspaceId}
          filePath={filePath}
          onClose={() => setGdocsReviewOpen(false)}
          onApplied={() => window.location.reload()}
        />
      )}
      <HistoryPanel
        workspaceId={workspaceId}
        filePath={filePath}
        open={historyOpen}
        authenticated={session?.authenticated === true}
        focusId={historyFocus?.id}
        focusKey={historyFocus?.key ?? 0}
        onClose={() => setHistoryOpen(false)}
        onSignIn={handleSignIn}
      />
      {showCommitDialog && (
        <CommitDialog
          defaultMessage={t('viewer.commit.defaultMessage', { path: filePath })}
          submitting={saving}
          onCancel={() => setShowCommitDialog(false)}
          onSubmit={handleSubmitCommit}
        />
      )}
      {showDeleteDialog && (
        <DeleteDocumentDialog
          filePath={filePath}
          branch={repo?.branch}
          submitting={saving}
          onCancel={() => setShowDeleteDialog(false)}
          onConfirm={handleDeleteDocument}
        />
      )}
      {showSettingsDialog && languageSettings && session?.authenticated === true && (
        <SettingsDialog
          workspaceId={workspaceId}
          isManager={isManager}
          settings={languageSettings}
          onClose={() => setShowSettingsDialog(false)}
          onSaved={handleSettingsSaved}
        />
      )}
    </div>
  );
}
