import { detectLanguage } from 'services/common/language';
import { normalizeDocumentPath } from 'services/docs-editor/document-path';
import { DEFAULT_GLOSSARY_FILE, folderOf, glossaryFileFor } from 'services/glossary/load';
import { GLOSSARY_TEMPLATE, type GlossaryLanguage } from 'services/glossary/parse';
import { type GlossaryRowInput, appendGlossaryRows } from 'services/glossary/table';
import { WorkspaceMirrorService } from 'services/workspace/mirror-service';
import { ImportRefusal } from './types';

/**
 * The glossary rows a manager ticked in the import preview, as a file to commit
 * with the document.
 *
 * This is `commitGlossaryRows` without the commit: the same file-picking rule
 * (nearest `GLOSSARY.md` walking up from the document's folder, or a new one in
 * the folder itself) and the same append, but the result is handed back as
 * content rather than pushed. The reason is the whole point of the feature —
 * the rows have to land in the SAME commit as the document that taught them
 * (docs/meeting-notes-and-glossary.md, 용어집 §5), so the landing needs a file,
 * not a second commit.
 *
 * Deliberately imports the glossary submodules rather than the barrel: the
 * barrel's `./commit` re-export would drag the GitHub client (octokit, ESM-only)
 * into every consumer of the import routes.
 */

/** What the caller asked for; `rows` are already parsed and trimmed. */
export interface BuildGlossaryCompanionParams {
  workspaceId: string;
  /** Repository path the document is being committed to; only its folder matters. */
  targetPath: string;
  rows: GlossaryRowInput[];
  /** Basename of a glossary in this workspace; `GLOSSARY.md` unless App Home says otherwise. */
  fileName?: string;
  /** `folder` forces a new glossary in the document's folder even when a parent has one. */
  createAt?: GlossaryCompanionCreateAt;
  /** Language of a file this has to create; guessed from the rows otherwise. */
  language?: GlossaryLanguage;
}

export type GlossaryCompanionCreateAt = 'nearest' | 'folder';

export interface GlossaryCompanion {
  /** Repository path the rows land in. */
  path: string;
  /** The whole glossary file as it will be committed. */
  content: string;
  added: number;
  /** Terms already in the file (or repeated in the request), in the order given. */
  skipped: string[];
  /** True when the glossary does not exist yet and this commit creates it. */
  created: boolean;
}

/**
 * Null when there is nothing to commit — no usable rows, or every one of them
 * already in the file. That is not a refusal: proposing a term twice is what
 * the loop does, and an empty tree entry would only put a commit message on a
 * diff that says nothing.
 */
export async function buildGlossaryCompanion(params: BuildGlossaryCompanionParams): Promise<GlossaryCompanion | null> {
  const rows = params.rows.filter((row) => row.term.trim().length > 0);
  if (rows.length === 0) return null;

  const fileName = params.fileName?.trim() || DEFAULT_GLOSSARY_FILE;
  const path = await targetPath(params.workspaceId, params.targetPath, fileName, params.createAt ?? 'nearest');

  // Read failures are not swallowed. The companion replaces the file wholesale,
  // so appending to content we could not read would commit a glossary holding
  // only the new rows — every term the folder already had, gone. Failing the
  // whole import is the safe answer: nothing is committed, and a retry costs
  // the manager the preview they still have open.
  const current = await WorkspaceMirrorService.getInstance().readMirrorFile(params.workspaceId, path);
  const created = current === null;
  const language = params.language ?? guessLanguage(rows);

  const appended = appendGlossaryRows(current ?? GLOSSARY_TEMPLATE(language), rows, { language });
  if (appended.added === 0) return null;

  return { path, content: appended.markdown, added: appended.added, skipped: appended.skipped, created };
}

/**
 * The file the rows go in: the nearest glossary at or above the document's
 * folder, or a new one in that folder. `folder` keeps the search only to notice
 * that this very folder already has one, so the rows are appended to it rather
 * than proposed as a creation over the top of it.
 */
async function targetPath(
  workspaceId: string,
  documentPath: string,
  fileName: string,
  createAt: GlossaryCompanionCreateAt,
): Promise<string> {
  let folder: string;
  try {
    folder = folderOf(documentPath);
  } catch {
    // A traversing document path; the landing would refuse it a moment later,
    // but the glossary must not read outside the mirror on the way there.
    throw new ImportRefusal(400, 'glossary_file_invalid', { path: documentPath });
  }

  const nearest = await glossaryFileFor(workspaceId, folder, { fileName });
  const usable = nearest !== null && (createAt === 'nearest' || folderOf(nearest) === folder);
  const candidate = usable && nearest ? nearest : joinPath(folder, fileName);

  // The path is about to become a commit, so it is checked by the same function
  // "New document" is checked by: repository-relative, markdown, no traversal,
  // and not inside `assets/` or `.choir/`. A `fileName` from the request that is
  // not a markdown basename fails here.
  const normalized = normalizeDocumentPath(candidate);
  if (!normalized) {
    throw new ImportRefusal(400, 'glossary_file_invalid', { path: candidate });
  }
  return normalized;
}

function joinPath(folder: string, fileName: string): string {
  return folder ? `${folder}/${fileName}` : fileName;
}

/**
 * Which language a glossary this has to create is headed in. The rows are all
 * there is to go on when the caller did not say — the file does not exist yet —
 * and `appendGlossaryRows` then finds the template's table and leaves the
 * headers alone.
 */
function guessLanguage(rows: GlossaryRowInput[]): GlossaryLanguage {
  const sample = rows.map((row) => `${row.term} ${row.aliases.join(' ')} ${row.description}`).join(' ');
  return detectLanguage(sample) === 'ko' ? 'ko' : 'en';
}
