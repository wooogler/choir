import fs from 'node:fs';
import path from 'node:path';
import { Logger } from 'services/common/logger';
import type { MarkdownFile } from 'services/github';

export type WorkspaceSyncSource = 'startup' | 'webhook' | 'manual-refresh' | 'document-update' | 'create-file';

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
    return path.join(process.cwd(), 'data', 'workspaces', workspaceId);
  }

  public getRepoRoot(workspaceId: string): string {
    return path.join(this.getWorkspaceRoot(workspaceId), 'repo');
  }

  private getStateRoot(workspaceId: string): string {
    return path.join(this.getWorkspaceRoot(workspaceId), 'state');
  }

  private getSyncStatePath(workspaceId: string): string {
    return path.join(this.getStateRoot(workspaceId), 'sync-state.json');
  }

  private ensureWorkspaceLayout(workspaceId: string): void {
    fs.mkdirSync(this.getRepoRoot(workspaceId), { recursive: true });
    fs.mkdirSync(this.getStateRoot(workspaceId), { recursive: true });
  }

  private resolveMirrorPath(workspaceId: string, relativePath: string): string {
    const repoRoot = this.getRepoRoot(workspaceId);
    const normalized = path.posix.normalize(relativePath).replace(/^\/+/, '');
    const targetPath = path.resolve(repoRoot, normalized);

    if (!targetPath.startsWith(path.resolve(repoRoot))) {
      throw new Error(`Refusing to write outside workspace mirror: ${relativePath}`);
    }

    return targetPath;
  }

  public async writeMarkdownFile(workspaceId: string, relativePath: string, content: string): Promise<string> {
    this.ensureWorkspaceLayout(workspaceId);

    const targetPath = this.resolveMirrorPath(workspaceId, relativePath);
    await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.promises.writeFile(targetPath, content, 'utf-8');

    Logger.info(`Workspace mirror wrote file: ${relativePath}`, { workspaceId, targetPath });
    return targetPath;
  }

  public async writeMarkdownFiles(workspaceId: string, markdownFiles: MarkdownFile[]): Promise<void> {
    this.ensureWorkspaceLayout(workspaceId);

    for (const markdownFile of markdownFiles) {
      await this.writeMarkdownFile(workspaceId, markdownFile.path, markdownFile.content);
    }

    await this.removeOrphanedMarkdownFiles(
      workspaceId,
      new Set(markdownFiles.map((file) => path.posix.normalize(file.path).replace(/^\/+/, ''))),
    );
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
    params.filePaths.forEach((filePath) => dirtyFiles.add(filePath));

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
    params.filePaths.forEach((filePath) => dirtyFiles.delete(filePath));

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
