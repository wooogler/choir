import type { DocFile, FolderNode, TocItem } from '../types';
import { inlineMarkdownToText, parseInlineMarkdown } from './inline-markdown';

// `/docs/:workspaceId/dashboard` is reserved for the Insights view, so parseDocsUrl
// (used by DocViewer's routing) treats it as "not a document" and stays inert there.
export function parseDocsUrl(): { workspaceId: string; filePath: string } | null {
  const match = window.location.pathname.match(/^\/docs\/([^/]+)\/(.+)$/);
  if (!match) return null;
  const filePath = decodeURIComponent(match[2]);
  if (filePath === 'dashboard') return null;
  return { workspaceId: decodeURIComponent(match[1]), filePath };
}

export type Route =
  | { view: 'docs'; workspaceId: string; filePath: string }
  | { view: 'dashboard'; workspaceId: string; from?: string };

/** Top-level route for App: docs viewer vs the awareness dashboard. */
export function parseRoute(): Route | null {
  const match = window.location.pathname.match(/^\/docs\/([^/]+)(?:\/(.*))?$/);
  if (!match) return null;
  const workspaceId = decodeURIComponent(match[1]);
  const rest = decodeURIComponent(match[2] ?? '');
  if (rest === 'dashboard') {
    const from = new URLSearchParams(window.location.search).get('from') || undefined;
    return { view: 'dashboard', workspaceId, from };
  }
  // `/docs/:workspaceId` alone is the workspace's front door (what the App Home
  // "Open Docs" button links to): an empty filePath, which DocViewer resolves to
  // the landing document once it has the file listing.
  return { view: 'docs', workspaceId, filePath: rest };
}

/**
 * The document a visitor lands on when the URL names only the workspace: the
 * repository's README, else an index, else the shallowest file — folders before
 * depth so a `docs/README.md` beats `a/b/c.md`, alphabetical within a depth.
 */
export function pickLandingFile(files: DocFile[]): DocFile | null {
  if (files.length === 0) return null;
  const depth = (file: DocFile) => file.path.split('/').length;
  const byName = (pattern: RegExp) =>
    [...files].filter((file) => pattern.test(file.name)).sort((a, b) => depth(a) - depth(b))[0];
  return (
    byName(/^readme$/i) ??
    byName(/^index$/i) ??
    [...files].sort((a, b) => depth(a) - depth(b) || a.path.localeCompare(b.path))[0]
  );
}

export function docsPath(workspaceId: string, filePath: string): string {
  return `/docs/${encodeURIComponent(workspaceId)}/${encodePath(filePath)}`;
}

export function dashboardPath(workspaceId: string, fromFilePath?: string): string {
  const base = `/docs/${encodeURIComponent(workspaceId)}/dashboard`;
  return fromFilePath ? `${base}?from=${encodeURIComponent(fromFilePath)}` : base;
}

/** SPA navigation: pushState, then notify App's popstate listener to re-render. */
export function navigate(path: string): void {
  window.history.pushState(null, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function slugifyHeading(text: string): string {
  return (
    text
      .toLowerCase()
      // Unicode letters and numbers are kept, matching the server's
      // createGitHubAnchor (services/document/section-utils.ts): an ASCII-only
      // class collapsed every Korean heading to the same empty anchor, so their
      // outline rows all shared a slug and their Slack deep links never resolved.
      .replace(/[^\p{L}\p{N}\s-]/gu, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
  );
}

export function extractToc(markdown: string): TocItem[] {
  return markdown
    .split('\n')
    .map((line, index) => {
      const match = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
      if (!match) return null;

      const source = match[2].trim();
      // The rail renders emphasis, so keep the styled runs alongside the plain
      // text the slug and the tooltip need.
      const label = inlineMarkdownToText(source);
      if (!label) return null;

      return {
        id: `${index}-${slugifyHeading(label)}`,
        label,
        level: match[1].length,
        segments: parseInlineMarkdown(source),
        slug: slugifyHeading(label),
      };
    })
    .filter((item): item is TocItem => Boolean(item));
}

export function encodePath(pathValue: string): string {
  return pathValue.split('/').map(encodeURIComponent).join('/');
}

/**
 * Repo-relative, markdown, no traversal — mirrors the server's own check
 * (`normalizeDocumentPath`), so a path the viewer accepts is one the API will
 * take. Shared by the Google Docs import and by "New document", which write to
 * the same repository and must refuse the same paths.
 */
export function looksLikeRepoPath(candidate: string): boolean {
  const trimmed = candidate.trim();
  if (!trimmed || trimmed.startsWith('/')) return false;
  if (trimmed.split('/').includes('..')) return false;
  // `assets/` holds committed binaries and `.choir/` holds encrypted provenance,
  // which the server refuses by the same names. Repeating them here is what
  // turns a round-trip 400 into a hint under the field.
  if (trimmed.startsWith('assets/') || trimmed.startsWith('.choir/')) return false;
  return /\.md$/i.test(trimmed);
}

/**
 * A title → the filename someone would have typed for it. Hangul is kept, which
 * is ordinary in these documents. `fallback` is what an untitled (or entirely
 * punctuation) document is called instead.
 */
export function suggestFileName(title: string, fallback: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return `${slug || fallback}.md`;
}

export function formatTitle(filePath: string): string {
  return (
    filePath
      .split('/')
      .pop()
      ?.replace(/\.md$/i, '')
      .replace(/^\d+[-_\s]*/, '')
      .replace(/[-_]+/g, ' ') || filePath
  );
}

export function buildFolderTree(files: DocFile[]): FolderNode {
  const root: FolderNode = { name: '', path: '', folders: [], files: [] };
  const foldersByPath = new Map<string, FolderNode>([['', root]]);

  for (const file of files) {
    const segments = file.path.split('/');
    let current = root;
    let currentPath = '';

    for (const folderName of segments.slice(0, -1)) {
      currentPath = currentPath ? `${currentPath}/${folderName}` : folderName;
      let folder = foldersByPath.get(currentPath);
      if (!folder) {
        folder = { name: folderName, path: currentPath, folders: [], files: [] };
        foldersByPath.set(currentPath, folder);
        current.folders.push(folder);
      }
      current = folder;
    }

    current.files.push(file);
  }

  const sortNode = (node: FolderNode) => {
    node.folders.sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true }));
    node.files.sort((left, right) => left.path.localeCompare(right.path, undefined, { numeric: true }));
    node.folders.forEach(sortNode);
  };
  sortNode(root);

  return root;
}

export function folderContainsPath(folder: FolderNode, currentPath: string): boolean {
  return (
    folder.files.some((file) => file.path === currentPath) ||
    folder.folders.some((child) => folderContainsPath(child, currentPath))
  );
}

export function scrollToAnchor(hash: string): void {
  if (!hash) return;
  const target = hash.startsWith('#') ? hash.slice(1) : hash;

  const headings = document.querySelectorAll('h1, h2, h3, h4, h5, h6');
  for (const el of headings) {
    const anchor = slugifyHeading(el.textContent ?? '');
    if (anchor === target) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      break;
    }
  }
}
