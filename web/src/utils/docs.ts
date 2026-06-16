import type { DocFile, FolderNode, TocItem } from '../types';

export function parseDocsUrl(): { workspaceId: string; filePath: string } | null {
  const match = window.location.pathname.match(/^\/docs\/([^/]+)\/(.+)$/);
  if (!match) return null;
  return {
    workspaceId: decodeURIComponent(match[1]),
    filePath: decodeURIComponent(match[2]),
  };
}

export function slugifyHeading(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export function extractToc(markdown: string): TocItem[] {
  return markdown
    .split('\n')
    .map((line, index) => {
      const match = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
      if (!match) return null;

      const label = match[2].trim();
      if (!label) return null;

      return {
        id: `${index}-${slugifyHeading(label)}`,
        label,
        level: match[1].length,
        slug: slugifyHeading(label),
      };
    })
    .filter((item): item is TocItem => Boolean(item));
}

export function encodePath(pathValue: string): string {
  return pathValue.split('/').map(encodeURIComponent).join('/');
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
