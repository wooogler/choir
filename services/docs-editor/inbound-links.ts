import fs from 'node:fs';
import path from 'node:path';
import { listMarkdownPaths } from './list-markdown-paths';

/**
 * Who points at a document.
 *
 * Rename does not rewrite links (docs/meeting-notes-and-glossary.md, 전제 기능
 * 표: 자동 갱신은 후속), so the dialog owes the manager a number instead: "three
 * documents link to this one, and those links will break". That makes the
 * counting the whole feature here, and it has to be honest in both directions —
 * a missed form understates the damage, and a false match tells a manager to
 * fix links nobody wrote.
 *
 * Deliberately text matching rather than a markdown parse. The mirror can hold
 * thousands of documents and this runs on a dialog opening, and the forms that
 * matter (inline links, angle-bracket destinations, reference definitions) are
 * all recognisable from the line they sit on.
 */

/** Fenced code blocks: a link inside one is a sample, not a reference. */
const FENCE = /^\s{0,3}(```+|~~~+)/;

/** `](destination)` and `](<destination>)`, including image links. */
const INLINE_LINK = /\]\(\s*(<[^>\n]*>|[^)\s]*)/g;

/** `[label]: destination "optional title"` — the reference-style definition. */
const REFERENCE_DEFINITION = /^\s{0,3}\[[^\]]+\]:\s*(<[^>\n]*>|\S+)/;

/** Anything with a scheme (or a protocol-relative host) points outside the repo. */
const ABSOLUTE_URL = /^([a-z][a-z0-9+.-]*:|\/\/)/i;

/**
 * Every repo-relative path `markdown` links to, resolved against the folder the
 * linking document sits in. Pure, so the matching rules can be tested without a
 * mirror on disk.
 */
export function linkedDocumentPaths(markdown: string, fromPath: string): string[] {
  const fromDir = path.posix.dirname(fromPath);
  const out: string[] = [];

  let inFence = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const definition = REFERENCE_DEFINITION.exec(line);
    if (definition?.[1]) {
      const resolved = resolveLinkTarget(definition[1], fromDir);
      if (resolved) out.push(resolved);
      // A definition line holds no inline links; `[a]: b (title)` would
      // otherwise be read as one.
      continue;
    }

    INLINE_LINK.lastIndex = 0;
    let match = INLINE_LINK.exec(line);
    while (match) {
      const resolved = resolveLinkTarget(match[1] ?? '', fromDir);
      if (resolved) out.push(resolved);
      match = INLINE_LINK.exec(line);
    }
  }

  return out;
}

/**
 * The repo-relative markdown path a link destination names, or null when it
 * names something else (an external URL, a bare anchor, a non-markdown file).
 */
function resolveLinkTarget(rawTarget: string, fromDir: string): string | null {
  let target = rawTarget.trim();
  const bracketed = target.startsWith('<') && target.endsWith('>');
  if (bracketed) {
    // Angle brackets are exactly what a destination containing spaces is
    // wrapped in, so the whole of it is the destination.
    target = target.slice(1, -1).trim();
  } else {
    // Otherwise a title may follow it: `[a]: b.md "B"`.
    target = target.split(/\s+/)[0] ?? '';
  }
  // Drop the fragment and query; `guide.md#setup` is still a link to guide.md.
  target = target.split('#')[0].split('?')[0];
  if (!target) return null;
  if (ABSOLUTE_URL.test(target)) return null;

  try {
    target = decodeURIComponent(target);
  } catch {
    // A destination with a stray `%` is used as typed rather than dropped.
  }
  if (!target.toLowerCase().endsWith('.md')) return null;

  // `/x.md` is repository-root-relative, the form the viewer's own links take.
  const resolved = target.startsWith('/')
    ? path.posix.normalize(target).replace(/^\/+/, '')
    : path.posix.normalize(path.posix.join(fromDir === '.' ? '' : fromDir, target));

  // A link that climbs out of the repository points at nothing here.
  if (resolved.startsWith('..')) return null;
  return resolved;
}

/**
 * How many OTHER markdown documents in the mirror link to `docPath`.
 *
 * Counted per document, not per link: the warning the manager reads is "N
 * documents link here", and a document that mentions the same target four times
 * is still one document to go and fix.
 */
export async function countInboundLinks(repoRoot: string, docPath: string): Promise<number> {
  const paths = await listMarkdownPaths(repoRoot);
  let count = 0;

  for (const candidate of paths) {
    if (candidate === docPath) continue; // A document's links to itself are not inbound.

    let markdown: string;
    try {
      markdown = await fs.promises.readFile(path.join(repoRoot, candidate), 'utf-8');
    } catch {
      continue;
    }
    // No "does the text mention the basename?" shortcut before the walk: a
    // percent-encoded destination (`%EC%97%B0%EA%B5%AC.md`) never mentions it,
    // and undercounting is the one failure mode that misleads the manager.
    if (linkedDocumentPaths(markdown, candidate).includes(docPath)) count += 1;
  }

  return count;
}
