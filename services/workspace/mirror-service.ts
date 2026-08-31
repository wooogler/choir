import fs from 'node:fs';
import path from 'node:path';
import { getDataPath } from 'services/common/data-path';
import { Logger } from 'services/common/logger';
import { injectCachedCaptions } from 'services/document/image-captions/inject';
import { splitMarkdownToItems } from 'services/document/markdown-section-splitter';
import type { MarkdownFile } from 'services/github';
import { ensureRepo } from './git-mirror';
import { PathMapService } from './path-map-service';

export type WorkspaceSyncSource = 'startup' | 'webhook' | 'manual-refresh' | 'document-update' | 'create-file';

// Section files are stored at `sections/<original-repo-path>/<index>.md`, keeping
// the doc's `.md` extension in the directory name so a file `x.md` and a
// directory `x/` never collide (previously both mapped to `sections/x`, letting a
// write of x.md `rm -rf` the sections of every doc under x/). Bump this when the
// on-disk section layout changes so existing workspaces rebuild sections — and,
// via the versioned QMD db path, their search index — on next access.
const SECTIONS_FORMAT_VERSION = '2';
const SECTIONS_FORMAT_MARKER = '.format';

export interface WorkspaceSyncState {
  workspaceId: string;
  owner?: string;
  repo?: string;
  branch?: string;
  fileCount?: number;
  lastCommitSha?: string;
  lastSyncSource?: WorkspaceSyncSource;
  lastSyncedAt?: string;
  dirtyFiles: string[];
  updatedAt: string;
}

export class WorkspaceMirrorService {
  private static instance: WorkspaceMirrorService;

  public static getInstance(): WorkspaceMirrorService {
    if (!WorkspaceMirrorService.instance) {
      WorkspaceMirrorService.instance = new WorkspaceMirrorService();
    }

    return WorkspaceMirrorService.instance;
  }

  public getWorkspaceRoot(workspaceId: string): string {
    // Guard against path traversal: workspaceId becomes a directory segment, and a
    // value like '..' or an absolute path would let callers (e.g. purgeWorkspaceCache
    // → recursive rm) escape the data dir. Slack team ids are safe tokens.
    if (!/^[A-Za-z0-9_-]+$/.test(workspaceId)) {
      throw new Error(`Invalid workspaceId: ${JSON.stringify(workspaceId)}`);
    }
    return getDataPath('workspaces', workspaceId);
  }

  public getRepoRoot(workspaceId: string): string {
    return path.join(this.getWorkspaceRoot(workspaceId), 'repo');
  }

  /**
   * Local git clone kept ALONGSIDE the API-materialized markdown mirror (`repo/`),
   * used only for blame/line-history queries. The caller resolves the
   * token-bearing remote URL (via GithubService) to avoid a dependency cycle.
   */
  public getGitRepoRoot(workspaceId: string): string {
    return path.join(this.getWorkspaceRoot(workspaceId), 'gitrepo');
  }

  // Serialize clone/fetch per workspace so concurrent callers (blame HTTP
  // requests, sync) don't run `git fetch`/`reset --hard` on the same working
  // tree at once and corrupt each other.
  private static readonly gitCloneInFlight = new Map<string, Promise<boolean>>();

  public async ensureGitClone(params: { workspaceId: string; remoteUrl: string; branch?: string }): Promise<boolean> {
    const { workspaceId } = params;
    const existing = WorkspaceMirrorService.gitCloneInFlight.get(workspaceId);
    if (existing) return existing;

    const promise = ensureRepo({
      dir: this.getGitRepoRoot(workspaceId),
      remoteUrl: params.remoteUrl,
      branch: params.branch,
    }).finally(() => {
      WorkspaceMirrorService.gitCloneInFlight.delete(workspaceId);
    });
    WorkspaceMirrorService.gitCloneInFlight.set(workspaceId, promise);
    return promise;
  }

  private getStateRoot(workspaceId: string): string {
    return path.join(this.getWorkspaceRoot(workspaceId), 'state');
  }

  private getSyncStatePath(workspaceId: string): string {
    return path.join(this.getStateRoot(workspaceId), 'sync-state.json');
  }

  public getSectionsRoot(workspaceId: string): string {
    return path.join(this.getWorkspaceRoot(workspaceId), 'sections');
  }

  public async purgeWorkspaceCache(workspaceId: string): Promise<void> {
    const workspaceRoot = this.getWorkspaceRoot(workspaceId);
    await fs.promises.rm(workspaceRoot, { recursive: true, force: true });
    Logger.info(`Workspace mirror purged cache for workspace: ${workspaceId}`, { workspaceId, workspaceRoot });
  }

  private ensureWorkspaceLayout(workspaceId: string): void {
    fs.mkdirSync(this.getRepoRoot(workspaceId), { recursive: true });
    fs.mkdirSync(this.getStateRoot(workspaceId), { recursive: true });
    fs.mkdirSync(this.getSectionsRoot(workspaceId), { recursive: true });
  }

  private resolveMirrorPath(workspaceId: string, relativePath: string): string {
    const repoRoot = this.getRepoRoot(workspaceId);
    const repoRootResolved = path.resolve(repoRoot);
    const normalized = path.posix.normalize(relativePath).replace(/^\/+/, '');
    const targetPath = path.resolve(repoRootResolved, normalized);

    // Trailing separator so a sibling like "<repoRoot>-evil" can't pass startsWith.
    if (targetPath !== repoRootResolved && !targetPath.startsWith(repoRootResolved + path.sep)) {
      throw new Error(`Refusing to write outside workspace mirror: ${relativePath}`);
    }

    return targetPath;
  }

  public async writeMarkdownFile(workspaceId: string, relativePath: string, content: string): Promise<string> {
    this.ensureWorkspaceLayout(workspaceId);

    const targetPath = this.resolveMirrorPath(workspaceId, relativePath);
    await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.promises.writeFile(targetPath, content, 'utf-8');

    await this.writeSectionFiles(workspaceId, relativePath, content);
    await PathMapService.getInstance().upsert(workspaceId, relativePath);

    Logger.info(`Workspace mirror wrote file: ${relativePath}`, { workspaceId, targetPath });
    return targetPath;
  }

  /**
   * Writes a non-markdown repo file (e.g. an encrypted provenance sidecar under
   * `.choir/context/`) into the mirror so the viewer can read it locally without a
   * GitHub round-trip. Skips the markdown-only concerns (section split / path map).
   */
  public async writeContextFile(workspaceId: string, relativePath: string, content: string): Promise<string> {
    this.ensureWorkspaceLayout(workspaceId);

    const targetPath = this.resolveMirrorPath(workspaceId, relativePath);
    await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.promises.writeFile(targetPath, content, 'utf-8');

    Logger.info(`Workspace mirror wrote context file: ${relativePath}`, { workspaceId });
    return targetPath;
  }

  /**
   * One-time, self-healing migration: if the on-disk section layout predates the
   * current SECTIONS_FORMAT_VERSION (or is unstamped), wipe the existing section
   * directories so the caller rebuilds them in the current layout, then stamp the
   * version. Only the full-rebuild paths (populateSectionsIfEmpty / writeMarkdownFiles)
   * call this — single-file writes must not wipe the whole index.
   */
  private async ensureSectionsFormat(workspaceId: string): Promise<void> {
    const sectionsRoot = this.getSectionsRoot(workspaceId);
    const markerPath = path.join(sectionsRoot, SECTIONS_FORMAT_MARKER);

    let current: string | null = null;
    try {
      current = (await fs.promises.readFile(markerPath, 'utf-8')).trim();
    } catch {
      current = null;
    }
    if (current === SECTIONS_FORMAT_VERSION) return;

    // Async I/O throughout: a large stale sections/ tree would otherwise block the
    // event loop for the whole recursive delete during this one-time migration.
    let entries: string[] | null = null;
    try {
      entries = await fs.promises.readdir(sectionsRoot);
    } catch {
      entries = null; // sections/ doesn't exist yet
    }
    if (entries) {
      await Promise.all(
        entries
          .filter((entry) => entry !== SECTIONS_FORMAT_MARKER)
          .map((entry) => fs.promises.rm(path.join(sectionsRoot, entry), { recursive: true, force: true })),
      );
    } else {
      await fs.promises.mkdir(sectionsRoot, { recursive: true });
    }
    await fs.promises.writeFile(markerPath, SECTIONS_FORMAT_VERSION, 'utf-8');
    if (current !== null) {
      Logger.info('Workspace mirror migrated sections/ to a new layout format', {
        workspaceId,
        from: current,
        to: SECTIONS_FORMAT_VERSION,
      });
    }
  }

  public async populateSectionsIfEmpty(workspaceId: string): Promise<void> {
    const sectionsRoot = this.getSectionsRoot(workspaceId);
    const repoRoot = this.getRepoRoot(workspaceId);

    if (!fs.existsSync(repoRoot)) return;

    // Rebuild from scratch if the on-disk layout is stale (wipes old-format dirs).
    await this.ensureSectionsFormat(workspaceId);

    const sectionsHasFiles =
      fs.existsSync(sectionsRoot) &&
      fs.readdirSync(sectionsRoot).some((entry) => {
        const entryPath = path.join(sectionsRoot, entry);
        return fs.statSync(entryPath).isDirectory();
      });

    if (sectionsHasFiles) return;

    Logger.info('QmdRetrievalProvider: sections/ is empty, rebuilding from repo/', { workspaceId });

    const stack = [repoRoot];
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current) continue;
      const entries = await fs.promises.readdir(current, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(fullPath);
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          const relativePath = path.relative(repoRoot, fullPath).split(path.sep).join(path.posix.sep);
          const content = await fs.promises.readFile(fullPath, 'utf-8');
          await this.writeSectionFiles(workspaceId, relativePath, content);
        }
      }
    }
  }

  private async writeSectionFiles(workspaceId: string, relativePath: string, content: string): Promise<void> {
    const sectionsRoot = this.getSectionsRoot(workspaceId);
    // Keep the `.md` in the directory name so the file `x.md` (→ sections/x.md/)
    // and a directory `x/` (→ sections/x/foo.md/) occupy disjoint namespaces.
    const sectionDir = path.join(sectionsRoot, relativePath);

    if (fs.existsSync(sectionDir)) {
      await fs.promises.rm(sectionDir, { recursive: true, force: true });
    }
    await fs.promises.mkdir(sectionDir, { recursive: true });

    const fileBaseName = path.posix.basename(relativePath, '.md');
    const items = injectCachedCaptions(splitMarkdownToItems(content, fileBaseName), workspaceId, relativePath);
    for (const item of items) {
      const itemFilePath = path.join(sectionDir, `${item.index}.md`);
      await fs.promises.writeFile(itemFilePath, item.content, 'utf-8');
    }

    Logger.info(`Workspace mirror wrote ${items.length} item file(s) for: ${relativePath}`, { workspaceId });
  }

  /**
   * Rebuilds the section files for a single document from its current mirror
   * content. Used after image captions are generated so the captions get
   * injected into the section index.
   */
  public async rebuildSectionsForFile(workspaceId: string, relativePath: string): Promise<void> {
    const repoRoot = this.getRepoRoot(workspaceId);
    const absolutePath = path.join(repoRoot, relativePath);
    if (!fs.existsSync(absolutePath)) return;
    const content = await fs.promises.readFile(absolutePath, 'utf-8');
    await this.writeSectionFiles(workspaceId, relativePath, content);
  }

  public async writeMarkdownFiles(workspaceId: string, markdownFiles: MarkdownFile[]): Promise<void> {
    this.ensureWorkspaceLayout(workspaceId);
    // Full rewrite: migrate a stale on-disk layout before writing so old-format
    // section dirs don't linger alongside the new ones.
    await this.ensureSectionsFormat(workspaceId);

    for (const markdownFile of markdownFiles) {
      await this.writeMarkdownFile(workspaceId, markdownFile.path, markdownFile.content);
    }

    const expectedPaths = new Set(markdownFiles.map((file) => path.posix.normalize(file.path).replace(/^\/+/, '')));
    await this.removeOrphanedMarkdownFiles(workspaceId, expectedPaths);
    await this.removeOrphanedSectionDirs(workspaceId, expectedPaths);
    await PathMapService.getInstance().save(
      workspaceId,
      markdownFiles.map((f) => f.path),
    );
  }

  private async removeOrphanedSectionDirs(workspaceId: string, expectedPaths: Set<string>): Promise<void> {
    const sectionsRoot = this.getSectionsRoot(workspaceId);
    if (!fs.existsSync(sectionsRoot)) {
      return;
    }

    // Expected section dirs: one per expected file, keyed by the full repo path
    // WITH its .md extension (matching writeSectionFiles' layout).
    const expectedSectionDirs = new Set(expectedPaths);

    const topLevelEntries = await fs.promises.readdir(sectionsRoot, { withFileTypes: true });
    for (const entry of topLevelEntries) {
      if (!entry.isDirectory()) {
        continue;
      }
      await this.removeOrphanedSectionDirsRecursive(
        path.join(sectionsRoot, entry.name),
        entry.name,
        sectionsRoot,
        expectedSectionDirs,
        workspaceId,
      );
    }
  }

  private async removeOrphanedSectionDirsRecursive(
    dirPath: string,
    relativeDirPath: string,
    sectionsRoot: string,
    expectedSectionDirs: Set<string>,
    workspaceId: string,
  ): Promise<void> {
    if (expectedSectionDirs.has(relativeDirPath)) {
      return; // This dir is still needed
    }

    // Check if any subdirectory matches an expected section dir
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    const subDirs = entries.filter((e) => e.isDirectory());

    if (subDirs.length === 0) {
      // Leaf dir not in expected set → remove
      await fs.promises.rm(dirPath, { recursive: true, force: true });
      Logger.info(`Workspace mirror removed orphaned section dir: ${relativeDirPath}`, { workspaceId });
      return;
    }

    for (const subDir of subDirs) {
      await this.removeOrphanedSectionDirsRecursive(
        path.join(dirPath, subDir.name),
        `${relativeDirPath}/${subDir.name}`,
        sectionsRoot,
        expectedSectionDirs,
        workspaceId,
      );
    }
  }

  private async removeOrphanedMarkdownFiles(workspaceId: string, expectedPaths: Set<string>): Promise<void> {
    const repoRoot = this.getRepoRoot(workspaceId);
    if (!fs.existsSync(repoRoot)) {
      return;
    }

    const stack = [repoRoot];
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current) {
        continue;
      }

      const entries = await fs.promises.readdir(current, { withFileTypes: true });
      for (const entry of entries) {
        const entryPath = path.join(current, entry.name);

        if (entry.isDirectory()) {
          stack.push(entryPath);
          continue;
        }

        if (!entry.isFile() || !entry.name.endsWith('.md')) {
          continue;
        }

        const relativePath = path.relative(repoRoot, entryPath).split(path.sep).join(path.posix.sep);
        if (!expectedPaths.has(relativePath)) {
          await fs.promises.unlink(entryPath);
          Logger.info(`Workspace mirror removed orphaned file: ${relativePath}`, { workspaceId });
        }
      }
    }
  }

  /**
   * Reads one file from the workspace mirror, or null when it is absent. Goes
   * through resolveMirrorPath so the repo-root containment guard applies to
   * callers outside this class.
   */
  public async readMirrorFile(workspaceId: string, relativePath: string): Promise<string | null> {
    try {
      return await fs.promises.readFile(this.resolveMirrorPath(workspaceId, relativePath), 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  public async getSyncState(workspaceId: string): Promise<WorkspaceSyncState | null> {
    const syncStatePath = this.getSyncStatePath(workspaceId);
    if (!fs.existsSync(syncStatePath)) {
      return null;
    }

    const content = await fs.promises.readFile(syncStatePath, 'utf-8');
    return JSON.parse(content) as WorkspaceSyncState;
  }

  public async saveSyncState(workspaceId: string, state: WorkspaceSyncState): Promise<void> {
    this.ensureWorkspaceLayout(workspaceId);
    await fs.promises.writeFile(this.getSyncStatePath(workspaceId), JSON.stringify(state, null, 2), 'utf-8');
  }

  public async syncMarkdownFiles(params: {
    workspaceId: string;
    owner: string;
    repo: string;
    branch?: string;
    markdownFiles: MarkdownFile[];
    source: WorkspaceSyncSource;
    commitSha?: string;
  }): Promise<void> {
    await this.writeMarkdownFiles(params.workspaceId, params.markdownFiles);

    const state: WorkspaceSyncState = {
      workspaceId: params.workspaceId,
      owner: params.owner,
      repo: params.repo,
      branch: params.branch,
      fileCount: params.markdownFiles.length,
      lastCommitSha: params.commitSha,
      lastSyncSource: params.source,
      lastSyncedAt: new Date().toISOString(),
      dirtyFiles: [],
      updatedAt: new Date().toISOString(),
    };

    await this.saveSyncState(params.workspaceId, state);
  }

  public async markFilesDirty(params: {
    workspaceId: string;
    filePaths: string[];
    owner?: string;
    repo?: string;
    branch?: string;
    source: WorkspaceSyncSource;
  }): Promise<void> {
    const currentState = (await this.getSyncState(params.workspaceId)) || {
      workspaceId: params.workspaceId,
      dirtyFiles: [],
      updatedAt: new Date().toISOString(),
    };

    const dirtyFiles = new Set(currentState.dirtyFiles);
    for (const filePath of params.filePaths) dirtyFiles.add(filePath);

    await this.saveSyncState(params.workspaceId, {
      ...currentState,
      owner: params.owner || currentState.owner,
      repo: params.repo || currentState.repo,
      branch: params.branch || currentState.branch,
      dirtyFiles: Array.from(dirtyFiles).sort(),
      lastSyncSource: params.source,
      updatedAt: new Date().toISOString(),
    });
  }

  public async markFilesSynced(params: {
    workspaceId: string;
    filePaths: string[];
    owner?: string;
    repo?: string;
    branch?: string;
    source: WorkspaceSyncSource;
    commitSha?: string;
  }): Promise<void> {
    const currentState = (await this.getSyncState(params.workspaceId)) || {
      workspaceId: params.workspaceId,
      dirtyFiles: [],
      updatedAt: new Date().toISOString(),
    };

    const dirtyFiles = new Set(currentState.dirtyFiles);
    for (const filePath of params.filePaths) dirtyFiles.delete(filePath);

    await this.saveSyncState(params.workspaceId, {
      ...currentState,
      owner: params.owner || currentState.owner,
      repo: params.repo || currentState.repo,
      branch: params.branch || currentState.branch,
      lastCommitSha: params.commitSha || currentState.lastCommitSha,
      lastSyncSource: params.source,
      lastSyncedAt: new Date().toISOString(),
      dirtyFiles: Array.from(dirtyFiles).sort(),
      updatedAt: new Date().toISOString(),
    });
  }
}
