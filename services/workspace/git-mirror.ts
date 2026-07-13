import fs from 'node:fs';
import path from 'node:path';
import { Logger } from 'services/common/logger';
import { type SimpleGit, simpleGit } from 'simple-git';

/**
 * Thin wrapper around a local git clone used purely for blame queries (line →
 * commit). It runs ALONGSIDE the API-materialized markdown mirror; the existing
 * mirror is the source for content, this clone is the source for line history.
 * All operations are best-effort: callers degrade gracefully when git or the
 * remote is unavailable. The access token is injected per git invocation and is
 * never written to .git/config nor allowed into logs (see splitRemoteAuth /
 * redactSecrets below).
 */

function isCloned(dir: string): boolean {
  return fs.existsSync(path.join(dir, '.git'));
}

/**
 * Strip inline credentials (`https://x-access-token:<tok>@host/…`) out of a
 * remote URL so the token is never persisted into `.git/config`. The token is
 * returned as `-c http.<base>.extraheader=…` args that authenticate a single
 * git invocation without writing anything to disk.
 */
export function splitRemoteAuth(remoteUrl: string): { cleanUrl: string; authArgs: string[] } {
  try {
    const url = new URL(remoteUrl);
    if (url.username || url.password) {
      const basic = Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString(
        'base64',
      );
      const base = `${url.protocol}//${url.host}/`;
      url.username = '';
      url.password = '';
      return { cleanUrl: url.toString(), authArgs: ['-c', `http.${base}.extraheader=AUTHORIZATION: basic ${basic}`] };
    }
  } catch {
    // Not a parseable URL — leave it untouched.
  }
  return { cleanUrl: remoteUrl, authArgs: [] };
}

/** Scrub any credentials that a git error message/command might echo back. */
export function redactSecrets(text: string): string {
  return text
    .replace(/x-access-token:[^@\s]+@/gi, 'x-access-token:***@')
    .replace(/(AUTHORIZATION:\s*basic\s+)[A-Za-z0-9+/=]+/gi, '$1***')
    .replace(/(\/\/)[^/@\s]+:[^/@\s]+@/g, '$1***:***@');
}

/** Log a git failure without ever serializing the token-bearing error object. */
function warnGitFailure(message: string, error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error);
  Logger.warn(message, { error: redactSecrets(detail) });
}

/**
 * Clone the repo into `dir`, or (if already cloned) refresh it to the tip of
 * `branch`. The remote URL is reset every time so an expired token is replaced.
 * Returns true when `dir` holds a usable clone afterwards.
 */
export async function ensureRepo(params: { dir: string; remoteUrl: string; branch?: string }): Promise<boolean> {
  const { dir, remoteUrl, branch } = params;
  const { cleanUrl, authArgs } = splitRemoteAuth(remoteUrl);
  try {
    if (isCloned(dir)) {
      const git = simpleGit(dir);
      // Persist only the token-free URL; auth travels per-invocation via authArgs.
      await git.raw(['remote', 'set-url', 'origin', cleanUrl]);
      await git.raw([
        ...authArgs,
        ...(branch ? ['fetch', '--prune', 'origin', branch] : ['fetch', '--prune', 'origin']),
      ]);
      const target = branch ? `origin/${branch}` : 'origin/HEAD';
      await git.raw(['reset', '--hard', target]);
      return true;
    }

    await fs.promises.mkdir(path.dirname(dir), { recursive: true });
    const cloneArgs = [...authArgs, 'clone', '--single-branch', ...(branch ? ['--branch', branch] : []), cleanUrl, dir];
    await simpleGit().raw(cloneArgs);
    return true;
  } catch (error) {
    warnGitFailure(`git mirror ensureRepo failed for ${path.basename(dir)}`, error);
    return false;
  }
}

/**
 * Map each current line of `filePath` to the commit SHA that last changed it.
 * Returns a Map keyed by 1-based final line number.
 */
export async function blameLineCommits(dir: string, filePath: string): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  if (!isCloned(dir)) return map;
  try {
    const git: SimpleGit = simpleGit(dir);
    const out = await git.raw(['blame', '--line-porcelain', '--', filePath]);
    // `--line-porcelain` repeats a header per line; the header's first token is
    // the commit SHA and the third token is the final (current) line number.
    for (const line of out.split('\n')) {
      const m = line.match(/^([0-9a-f]{40}) \d+ (\d+)/);
      if (m) map.set(Number(m[2]), m[1]);
    }
  } catch (error) {
    warnGitFailure(`git blame failed for ${filePath}`, error);
  }
  return map;
}

/** Commit SHA that first ADDED `filePath` (records are immutable, added once). */
export async function firstAddCommit(dir: string, filePath: string): Promise<string | null> {
  if (!isCloned(dir)) return null;
  try {
    const git = simpleGit(dir);
    const out = (await git.raw(['log', '--diff-filter=A', '-1', '--format=%H', '--', filePath])).trim();
    return out || null;
  } catch (error) {
    warnGitFailure(`git log (add commit) failed for ${filePath}`, error);
    return null;
  }
}

/**
 * Map every file added under `dirPath` to the commit SHA that added it, in one
 * `git log` pass. Used to link each `.choir/context/…` record file to the
 * commit it was created in (which is the doc-change commit it travels with).
 */
export async function addCommitsForDir(dir: string, dirPath: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (!isCloned(dir)) return map;
  try {
    const git = simpleGit(dir);
    // core.quotePath=false keeps non-ASCII (e.g. Korean) paths verbatim in
    // --name-only output; otherwise git C-quotes them and the record-id join fails.
    const out = await git.raw([
      '-c',
      'core.quotePath=false',
      'log',
      '--diff-filter=A',
      '--format=C %H',
      '--name-only',
      '--',
      dirPath,
    ]);
    let sha: string | null = null;
    for (const line of out.split('\n')) {
      if (line.startsWith('C ')) {
        sha = line.slice(2).trim();
        continue;
      }
      const file = line.trim();
      if (sha && file && !map.has(file)) map.set(file, sha);
    }
  } catch (error) {
    warnGitFailure(`git log (dir add commits) failed for ${dirPath}`, error);
  }
  return map;
}
