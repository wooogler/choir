import type { Document } from '@langchain/core/documents';
import { Logger } from '../common/logger';
import type { MarkdownFile } from '../github';
import { getRetrievalProvider } from '../retrieval';
import type { RetrievalScope } from '../retrieval/types';
import type { DocumentMetadata } from './types';

interface VectorWorkspaceState {
  markdownFiles: MarkdownFile[];
}

export class VectorStoreService {
  private static instance: VectorStoreService;
  private readonly workspaceStates = new Map<string, VectorWorkspaceState>();
  private readonly defaultWorkspaceKey = 'default';
  /**
   * Workspaces whose file list has been set since the process started. Kept
   * apart from `workspaceStates`, which every read creates an empty entry in, so
   * "never loaded" cannot be mistaken for "loaded, and the repo is empty".
   */
  private readonly loadedWorkspaces = new Set<string>();
  private readonly inFlightLoads = new Map<string, Promise<boolean>>();

  public static getInstance(): VectorStoreService {
    if (!VectorStoreService.instance) {
      VectorStoreService.instance = new VectorStoreService();
    }
    return VectorStoreService.instance;
  }

  private getWorkspaceKey(workspaceId?: string): string {
    return workspaceId || this.defaultWorkspaceKey;
  }

  private getState(workspaceId?: string): VectorWorkspaceState {
    const key = this.getWorkspaceKey(workspaceId);
    let state = this.workspaceStates.get(key);
    if (!state) {
      state = { markdownFiles: [] };
      this.workspaceStates.set(key, state);
    }
    return state;
  }

  public clearWorkspaceState(workspaceId: string): void {
    this.workspaceStates.delete(this.getWorkspaceKey(workspaceId));
    this.loadedWorkspaces.delete(this.getWorkspaceKey(workspaceId));
    Logger.info('VectorStoreService: cleared workspace state', { workspaceId });
  }

  public async initialize(
    markdownFiles: MarkdownFile[],
    _useCache = true,
    _forceRefresh = false,
    workspaceId?: string,
  ): Promise<boolean> {
    this.getState(workspaceId).markdownFiles = markdownFiles;
    this.loadedWorkspaces.add(this.getWorkspaceKey(workspaceId));
    Logger.info(`VectorStoreService: stored ${markdownFiles.length} markdown files`, { workspaceId });
    return true;
  }

  /**
   * The file list lives only in memory, and in OAuth mode nothing reloads it at
   * startup until a webhook or a manual refresh arrives — so after a restart
   * every lookup missed and document updates failed with "File not found in
   * vector store". Anything that reads the list, or rewrites it from what it
   * read, awaits this first; it fills the list from the on-disk mirror once.
   *
   * Returns whether the list is loaded. A workspace with no repo or an empty
   * mirror stays unloaded, so the next call tries again.
   */
  public async ensureLoaded(workspaceId?: string): Promise<boolean> {
    if (!workspaceId) return false;
    const key = this.getWorkspaceKey(workspaceId);
    if (this.loadedWorkspaces.has(key)) return true;

    let load = this.inFlightLoads.get(key);
    if (!load) {
      load = this.loadFromMirror(workspaceId).finally(() => this.inFlightLoads.delete(key));
      this.inFlightLoads.set(key, load);
    }
    return load;
  }

  private async loadFromMirror(workspaceId: string): Promise<boolean> {
    try {
      // Imported lazily: both modules sit above this one in the import graph.
      const { WorkspaceStore } = await import('../workspace/workspace-store');
      const { WorkspaceMirrorMarkdownLoader } = await import('../workspace/mirror-markdown-loader');

      const repo = (await new WorkspaceStore().getWorkspaceConfig(workspaceId))?.githubRepo;
      if (!repo) return false;

      const markdownFiles = await WorkspaceMirrorMarkdownLoader.getInstance().loadMarkdownFiles({
        workspaceId,
        owner: repo.owner,
        repo: repo.repo,
        branch: repo.branch,
      });
      if (markdownFiles.length === 0) {
        Logger.warn('VectorStoreService: mirror has no markdown files to load', { workspaceId });
        return false;
      }

      // A full load (webhook, refresh) that finished while the mirror was being
      // read is at least as fresh as what we read.
      if (this.loadedWorkspaces.has(this.getWorkspaceKey(workspaceId))) return true;
      this.setLoadedMarkdownFiles(markdownFiles, workspaceId);
      return true;
    } catch (error) {
      Logger.error('VectorStoreService: failed to load markdown files from the mirror', error as Error);
      return false;
    }
  }

  public getMarkdownFile(fileName: string, workspaceId?: string): MarkdownFile | undefined {
    const files = this.getState(workspaceId).markdownFiles;
    // Prefer an exact full-repo-path match: this resolves files in subdirectories
    // (whose identity is a path like "docs/guide.md") and disambiguates duplicate
    // basenames (e.g. two README.md). Fall back to a basename match for legacy
    // callers that still pass only a file name.
    return files.find((f) => f.path === fileName) ?? files.find((f) => f.name === fileName);
  }

  public getAllMarkdownFiles(workspaceId?: string): MarkdownFile[] {
    return this.getState(workspaceId).markdownFiles;
  }

  public setLoadedMarkdownFiles(markdownFiles: MarkdownFile[], workspaceId?: string): void {
    this.getState(workspaceId).markdownFiles = markdownFiles;
    this.loadedWorkspaces.add(this.getWorkspaceKey(workspaceId));
    Logger.info(`VectorStoreService: hydrated ${markdownFiles.length} markdown files`, { workspaceId });
  }

  public addToMarkdownFiles(markdownFile: MarkdownFile, workspaceId?: string): void {
    this.getState(workspaceId).markdownFiles.push(markdownFile);
    Logger.info(`VectorStoreService: added ${markdownFile.name}`, { workspaceId });
  }

  public async setMarkdownFiles(
    markdownFiles: MarkdownFile[],
    options?: { owner: string; repo: string; workspaceId?: string },
  ): Promise<void> {
    this.setLoadedMarkdownFiles(markdownFiles, options?.workspaceId);
  }

  public extractRepoInfoFromFiles(workspaceId?: string) {
    const firstFile = this.getState(workspaceId).markdownFiles[0];
    if (!firstFile?.githubUrl) return null;

    const match = firstFile.githubUrl.match(/github\.com\/([^/]+)\/([^/]+)/);
    if (match && match.length >= 3) {
      return {
        owner: match[1],
        repo: match[2],
        path: '',
        url: `https://github.com/${match[1]}/${match[2]}`,
      };
    }
    return null;
  }

  public async resetAndRebuildVectorStore(workspaceId?: string): Promise<boolean> {
    if (!workspaceId) return false;
    try {
      const provider = getRetrievalProvider();
      if ('rebuildWorkspaceIndex' in provider && typeof provider.rebuildWorkspaceIndex === 'function') {
        await (provider as any).rebuildWorkspaceIndex(workspaceId);
        Logger.info('VectorStoreService: QMD index rebuilt', { workspaceId });
      }
      return true;
    } catch (error) {
      Logger.error('VectorStoreService: failed to rebuild QMD index', error as Error);
      return false;
    }
  }

  /**
   * `scope` is forwarded rather than applied here: this store keeps markdown
   * metadata but no vectors of its own, so the project-folder filter belongs
   * where the ranking happens (services/retrieval/scope).
   */
  public async similaritySearchByFile(
    query: string,
    filePath: string,
    k = 5,
    workspaceId?: string,
    scope?: RetrievalScope,
  ): Promise<Document<DocumentMetadata>[]> {
    if (!workspaceId) return [];
    const results = await getRetrievalProvider().search({ query, limit: k * 3, workspaceId, scope });
    const fileName = filePath.split('/').pop() || filePath;
    return results.filter((doc) => doc.metadata.fileName?.endsWith(fileName)).slice(0, k);
  }

  /**
   * Writable candidates for a document update.
   *
   * `folderPrefix` restricts them to one project folder
   * (docs/project-folders.md 4). It is a post-filter, like the read-only one
   * beside it, so the over-fetch widens to match: a repository whose best hits
   * all sit outside the folder would otherwise return far fewer than `k`.
   */
  public async similaritySearchWritableFiles(
    query: string,
    workspaceId: string,
    k = 5,
    scope?: RetrievalScope,
    folderPrefix?: string,
  ): Promise<Document<DocumentMetadata>[]> {
    const { WorkspaceStore } = await import('services/workspace/workspace-store');
    const { isReadOnlyFile } = await import('services/workspace/read-only');
    const { isUnderFolder } = await import('services/document/update-scope');
    const readOnlyFiles = await new WorkspaceStore().getReadOnlyFiles(workspaceId);
    const results = await getRetrievalProvider().search({
      query,
      limit: k * (folderPrefix ? 8 : 3),
      workspaceId,
      scope,
    });
    // metadata.fileName carries the full repo path; match read-only entries
    // path-first (with a legacy basename fallback).
    return results
      .filter((doc) => !isReadOnlyFile(readOnlyFiles, { path: doc.metadata.fileName }))
      .filter((doc) => !folderPrefix || isUnderFolder(doc.metadata.fileName, folderPrefix))
      .slice(0, k);
  }

  public async addNewSection(
    fileName: string,
    sectionTitle: string,
    sectionBody: string,
    workspaceId?: string,
  ): Promise<boolean> {
    try {
      const file = this.getMarkdownFile(fileName, workspaceId);
      if (!file) {
        Logger.error(`File not found: ${fileName}`);
        return false;
      }

      const { createNewSectionNode } = await import('../document/markdown');
      const result = createNewSectionNode(file.tree, sectionTitle, sectionBody);
      file.tree = result.tree;
      Logger.info(`VectorStoreService: added section "${sectionTitle}" to ${fileName}`);
      return true;
    } catch (error) {
      Logger.error('Error adding new section', error as Error);
      return false;
    }
  }

  public async replaceNodeWithEnhancedContent(
    fileName: string,
    nodeId: string,
    content: string,
    workspaceId?: string,
  ): Promise<boolean> {
    try {
      const file = this.getMarkdownFile(fileName, workspaceId);
      if (!file) {
        Logger.error(`File not found: ${fileName}`);
        return false;
      }

      const { parseAndSplitContent, createReplacementNodes, replaceNodeAtomically } = await import(
        '../document/markdown'
      );
      const contentItems = parseAndSplitContent(content);
      const originalNode = file.tree.nodeMap.get(nodeId);

      if (!originalNode) {
        Logger.warn(`Node ${nodeId} not found in ${fileName}`);
        return false;
      }

      const replacementNodes = createReplacementNodes(originalNode, contentItems);
      file.tree = replaceNodeAtomically(file.tree, nodeId, replacementNodes);
      Logger.info(`VectorStoreService: replaced node ${nodeId} in ${fileName}`);
      return true;
    } catch (error) {
      Logger.error('Error replacing node with enhanced content', error as Error);
      return false;
    }
  }
}
