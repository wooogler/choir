import { BlockNoteView } from '@blocknote/mantine';
import { useCreateBlockNote } from '@blocknote/react';
import { useEffect, useState } from 'react';
import type { DocFile, RepoInfo, TocItem } from '../types';
import {
  encodePath,
  extractToc,
  formatTitle,
  normalizeMarkdownForBlockNote,
  parseDocsUrl,
  scrollToAnchor,
  slugifyHeading,
} from '../utils/docs';
import { FilesSidebar } from './FilesSidebar';
import { FloatingToc } from './FloatingToc';

type DocViewerProps = {
  workspaceId: string;
  initialFilePath: string;
};

export function DocViewer({ workspaceId, initialFilePath }: DocViewerProps) {
  const editor = useCreateBlockNote();
  const [title, setTitle] = useState('');
  const [error, setError] = useState('');
  const [filePath, setFilePath] = useState(initialFilePath);
  const [files, setFiles] = useState<DocFile[]>([]);
  const [repo, setRepo] = useState<RepoInfo | null>(null);
  const [ready, setReady] = useState(false);
  const [toc, setToc] = useState<TocItem[]>([]);
  const [activeSlug, setActiveSlug] = useState('');

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

      event.preventDefault();
      window.history.pushState(null, '', link.href);
      setFilePath(decodeURIComponent(parsedPath[2]));
      window.scrollTo({ top: 0, behavior: 'smooth' });
    };

    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, []);

  useEffect(() => {
    setReady(false);
    setError('');

    fetch(`/api/docs/${encodeURIComponent(workspaceId)}/${encodePath(filePath)}`)
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
        return r.json() as Promise<{ content: string; filePath: string }>;
      })
      .then(async ({ content, filePath: fp }) => {
        setTitle(formatTitle(fp));
        setToc(extractToc(content));
        const blocks = await editor.tryParseMarkdownToBlocks(normalizeMarkdownForBlockNote(content));
        editor.replaceBlocks(editor.document, blocks);
        setReady(true);
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : 'Failed to load document');
      });
  }, [workspaceId, filePath, editor]);

  useEffect(() => {
    if (!ready) return;
    const id = setTimeout(() => scrollToAnchor(window.location.hash), 100);
    return () => clearTimeout(id);
  }, [ready]);

  useEffect(() => {
    if (!ready || toc.length === 0) return;

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
  }, [ready, toc]);

  if (error) {
    return (
      <div className="docs-shell">
        <FilesSidebar files={files} currentPath={filePath} repo={repo} workspaceId={workspaceId} />
        <main className="doc-page error-page">
          <strong>Error:</strong> {error}
        </main>
      </div>
    );
  }

  return (
    <div className="docs-shell">
      <FilesSidebar files={files} currentPath={filePath} repo={repo} workspaceId={workspaceId} />
      <main className="doc-page">
        <div className="doc-breadcrumb">{filePath}</div>
        <h1 className="doc-title">{title}</h1>
        {!ready && <div className="doc-loading">Loading document...</div>}
        <BlockNoteView editor={editor} editable={false} />
      </main>
      <FloatingToc activeSlug={activeSlug} items={toc} />
    </div>
  );
}
