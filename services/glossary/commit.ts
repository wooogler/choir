/**
 * Writing approved rows into a `GLOSSARY.md`.
 *
 * The glossary is a document like any other, so this is an ordinary commit —
 * `createDocument` when the folder has none yet, `saveEditedDocument` when it
 * does — and everything that follows an edit (provenance, mirror, index,
 * replica) follows this one too. What is specific to a glossary is only *which*
 * file the rows land in: the nearest one walking up from the folder, the same
 * rule the loader reads by, so a term added while writing a meeting note goes
 * where that note will look for it.
 *
 * The exception is deliberate: the GUI can force a folder-level glossary with
 * `createAt: 'folder'` even when a parent has one. A team that wants its own
 * terms should not have to put them in the organization's file because the
 * organization got there first.
 *
 * See docs/meeting-notes-and-glossary.md, 용어집 §2 and §3a.
 */

import { detectLanguage } from 'services/common/language';
import { Logger } from 'services/common/logger';
import type { DocsApiErrorCode, DocsApiErrorDetail } from 'services/docs-editor/api-errors';
import { createDocument } from 'services/docs-editor/create-document';
import { normalizeDocumentPath } from 'services/docs-editor/document-path';
import { saveEditedDocument } from 'services/docs-editor/save-document';
import { WorkspaceMirrorService } from 'services/workspace/mirror-service';
import { DEFAULT_GLOSSARY_FILE, folderOf, glossaryFileFor } from './load';
import { GLOSSARY_TEMPLATE, type GlossaryLanguage } from './parse';
import { type GlossaryRowInput, appendGlossaryRows } from './table';

/**
 * A refusal the route can answer with as-is — an unusable path, or a request
 * that would produce an empty commit. Neither is a fault; both are something
 * the manager can fix in the dialog.
 */
export class GlossaryRefusal extends Error {
  readonly status: number;
  readonly apiCode: DocsApiErrorCode;
  readonly detail?: DocsApiErrorDetail;

  constructor(status: number, apiCode: DocsApiErrorCode, detail?: DocsApiErrorDetail) {
    super(apiCode);
    this.name = 'GlossaryRefusal';
    this.status = status;
    this.apiCode = apiCode;
    this.detail = detail;
  }
}

/** Where a new glossary may be created when the chain already has one. */
export type GlossaryCreateAt = 'nearest' | 'folder';

export interface CommitGlossaryRowsParams {
  workspaceId: string;
  userId: string;
  /** Repository-relative folder the rows are being added for; `''` is the root. */
  folder: string;
  rows: GlossaryRowInput[];
  /** Basename of a glossary in this workspace; `GLOSSARY.md` unless App Home says otherwise. */
  fileName?: string;
  /** `folder` forces a new glossary in `folder` even when a parent has one. */
  createAt?: GlossaryCreateAt;
  /** Language of a file this has to create; guessed from the rows otherwise. */
  language?: GlossaryLanguage;
}

export interface CommitGlossaryRowsResult {
  /** Repository path the rows landed in. */
  path: string;
  commitSha: string;
  added: number;
  /** Terms that were already in the file, in the order they were given. */
  skipped: string[];
  /** True when the glossary did not exist and this commit created it. */
  created: boolean;
}

export async function commitGlossaryRows(params: CommitGlossaryRowsParams): Promise<CommitGlossaryRowsResult> {
  const rows = params.rows.filter((row) => row.term.trim().length > 0);
  if (rows.length === 0) {
    throw new GlossaryRefusal(400, 'glossary_no_terms');
  }

  const fileName = params.fileName?.trim() || DEFAULT_GLOSSARY_FILE;
  const folder = normalizeFolder(params.folder);
  const path = await targetPath(params.workspaceId, folder, fileName, params.createAt ?? 'nearest');

  const current = await WorkspaceMirrorService.getInstance().readMirrorFile(params.workspaceId, path);
  const created = current === null;
  const language = params.language ?? guessLanguage(rows);

  const appended = appendGlossaryRows(current ?? GLOSSARY_TEMPLATE(language), rows, { language });
  if (appended.added === 0) {
    // Every row was already there. Committing would produce an empty diff and a
    // commit message that lies about what it did.
    throw new GlossaryRefusal(409, 'glossary_no_terms');
  }

  const commitSha = created
    ? (
        await createDocument({
          workspaceId: params.workspaceId,
          userId: params.userId,
          filePath: path,
          content: appended.markdown,
          commitMessage: `Create glossary for ${folder || 'the repository root'}`,
        })
      ).commitSha
    : (
        await saveEditedDocument({
          workspaceId: params.workspaceId,
          userId: params.userId,
          filePath: path,
          content: appended.markdown,
          commitMessage: `Add ${appended.added} glossary term${appended.added === 1 ? '' : 's'}`,
        })
      ).commitSha;

  Logger.info('Glossary rows committed', {
    workspaceId: params.workspaceId,
    userId: params.userId,
    operation: 'glossary.commit',
    path,
    added: appended.added,
    skipped: appended.skipped.length,
    created,
  });

  return { path, commitSha, added: appended.added, skipped: appended.skipped, created };
}

/**
 * The file the rows go in.
 *
 * `nearest` walks up as the loader does; `folder` keeps the search only to
 * notice that this very folder already has a glossary, since a create onto an
 * occupied path would be refused — and case-insensitively, because `Glossary.md`
 * and `GLOSSARY.md` are one file to the people who write them.
 */
async function targetPath(
  workspaceId: string,
  folder: string,
  fileName: string,
  createAt: GlossaryCreateAt,
): Promise<string> {
  const nearest = await glossaryFileFor(workspaceId, folder, { fileName });
  const usable = nearest && (createAt === 'nearest' || folderOf(nearest) === folder);
  const candidate = usable && nearest ? nearest : joinPath(folder, fileName);

  // The path is about to become a commit, so it is checked by the same function
  // "New document" is checked by: repository-relative, markdown, no traversal,
  // and not inside `assets/` or `.choir/`.
  const normalized = normalizeDocumentPath(candidate);
  if (!normalized) {
    throw new GlossaryRefusal(400, 'glossary_file_invalid', { path: candidate });
  }
  return normalized;
}

/** A repository-relative folder with no leading or trailing slash; `''` is the root. */
function normalizeFolder(folder: string): string {
  // `folderOf` wants a folder to be marked as one, and refuses traversal.
  const trimmed = folder.trim().replace(/\\/g, '/');
  try {
    return folderOf(trimmed.endsWith('/') || trimmed === '' ? trimmed : `${trimmed}/`);
  } catch {
    throw new GlossaryRefusal(400, 'glossary_file_invalid', { path: folder });
  }
}

function joinPath(folder: string, fileName: string): string {
  return folder ? `${folder}/${fileName}` : fileName;
}

/**
 * Which language a glossary this has to create is headed in. The rows are all
 * there is to go on — the file does not exist yet — and `appendGlossaryRows`
 * then finds the template's table and leaves the headers alone.
 */
function guessLanguage(rows: GlossaryRowInput[]): GlossaryLanguage {
  const sample = rows.map((row) => `${row.term} ${row.aliases.join(' ')} ${row.description}`).join(' ');
  return detectLanguage(sample) === 'ko' ? 'ko' : 'en';
}
