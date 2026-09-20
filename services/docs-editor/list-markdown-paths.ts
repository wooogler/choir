import fs from 'node:fs';
import path from 'node:path';

/**
 * Every markdown path in the mirror, repo-relative and sorted as the viewer sorts.
 *
 * Shared because `PathMapService` is add-only: both delete and rename fix the
 * map by re-saving the surviving list rather than by removing one key, so both
 * need the same walk and must agree on what "surviving" means. A second copy
 * would drift the moment one of them learned to skip a directory.
 */
export async function listMarkdownPaths(repoRoot: string): Promise<string[]> {
  const found: string[] = [];
  const stack = [repoRoot];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;

    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      found.push(path.relative(repoRoot, entryPath).split(path.sep).join(path.posix.sep));
    }
  }

  return found.sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
}
