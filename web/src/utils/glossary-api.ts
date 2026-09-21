/**
 * The viewer's client for the glossary endpoints (`/api/docs/:ws/glossary…`).
 *
 * Three calls that mirror the three questions the builder asks: what does this
 * folder already have, what terms are in these documents, and — after the
 * manager has edited the table — write them. Nothing here converts a seed
 * document: a PDF or a URL becomes an import draft through `import-api.ts`
 * first, and what arrives here are draft ids.
 *
 * The wire types are declared rather than imported from `services/glossary`:
 * those modules pull in the mirror, octokit and the OpenAI client, and the
 * viewer's bundle may only share import-free modules
 * (`__tests__/web-shared-modules.test.ts`).
 *
 * See docs/meeting-notes-and-glossary.md, 용어집 §3a.
 */

import type { T } from '../i18n';
import { ApiError, describeApiError, errorPayload } from './api-error';

export { ApiError as GlossaryApiError };

/** What the folder chain already holds, nearest file first. */
export interface GlossaryStatus {
  folder: string;
  /** Every glossary governing this folder, nearest first. */
  files: string[];
  /** How many terms they hold between them. */
  entries: number;
  nearestFile: string | null;
}

export type GlossaryCandidateKind = 'acronym' | 'proper-noun' | 'concept';

/** A row the model proposes and nobody has approved yet. */
export interface GlossaryCandidate {
  term: string;
  aliases: string[];
  description: string;
  kind: GlossaryCandidateKind;
  /** Title of the seed document the term was read from. */
  source?: string;
}

export interface GlossaryExtractResult {
  candidates: GlossaryCandidate[];
  /** How many terms the chain already had; the candidates exclude them. */
  existing: number;
  nearestFile: string | null;
}

/** Where a new glossary goes when the chain already has one. */
export type GlossaryCreateAt = 'nearest' | 'folder';

export interface GlossaryCommitResult {
  path: string;
  commitSha: string;
  added: number;
  /** Terms the file already had, by name. */
  skipped: string[];
  created: boolean;
}

/** The sentence to show for a failed glossary call, in the reader's language. */
export function describeGlossaryError(t: T, error: unknown, fallback: string): string {
  return describeApiError(t, error, fallback);
}

function glossaryBase(workspaceId: string): string {
  return `/api/docs/${encodeURIComponent(workspaceId)}/glossary`;
}

async function request<TResult>(url: string, init?: RequestInit): Promise<TResult> {
  const response = await fetch(url, { credentials: 'same-origin', ...init });
  if (!response.ok) throw new ApiError(await errorPayload(response), response.status);
  return (await response.json()) as TResult;
}

/** The chain governing a folder. Answers for a folder with nothing in it too. */
export function fetchGlossaryStatus(workspaceId: string, folder: string): Promise<GlossaryStatus> {
  return request<GlossaryStatus>(`${glossaryBase(workspaceId)}?folder=${encodeURIComponent(folder)}`);
}

/**
 * The seed drafts in, proposed rows out. Not streamed: extraction is one or two
 * calls over markdown that has already been converted.
 */
export function extractGlossaryTerms(
  workspaceId: string,
  body: { folder: string; draftIds: string[]; language?: 'ko' | 'en' },
): Promise<GlossaryExtractResult> {
  return request<GlossaryExtractResult>(`${glossaryBase(workspaceId)}/extract`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** The table as the manager edited it becomes a commit. */
export function commitGlossaryRows(
  workspaceId: string,
  body: {
    folder: string;
    rows: Array<{ term: string; aliases: string[]; description: string }>;
    fileName?: string;
    createAt?: GlossaryCreateAt;
  },
): Promise<GlossaryCommitResult> {
  return request<GlossaryCommitResult>(`${glossaryBase(workspaceId)}/commit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
