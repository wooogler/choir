import type { Document } from '@langchain/core/documents';
import { Logger } from '../common/logger';
import type { MarkdownFile } from '../github';
import { getRetrievalProvider } from '../retrieval';
import type { DocumentMetadata } from './types';

interface VectorWorkspaceState {
  markdownFiles: MarkdownFile[];
}

export class VectorStoreService {
  private static instance: VectorStoreService;
  private readonly workspaceStates = new Map<string, VectorWorkspaceState>();
  private readonly defaultWorkspaceKey = 'default';

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
    Logger.info('VectorStoreService: cleared workspace state', { workspaceId });
  }

  public async initialize(
    markdownFiles: MarkdownFile[],
    _useCache = true,
    _forceRefresh = false,
    workspaceId?: string,
  ): Promise<boolean> {
    this.getState(workspaceId).markdownFiles = markdownFiles;
    Logger.info(`VectorStoreService: stored ${markdownFiles.length} markdown files`, { workspaceId });
    return true;
  }

  public getMarkdownFile(fileName: string, workspaceId?: string): MarkdownFile | undefined {
    return this.getState(workspaceId).markdownFiles.find((f) => f.name === fileName);
  }

  public getAllMarkdownFiles(workspaceId?: string): MarkdownFile[] {
    return this.getState(workspaceId).markdownFiles;
  }

  public setLoadedMarkdownFiles(markdownFiles: MarkdownFile[], workspaceId?: string): void {
    this.getState(workspaceId).markdownFiles = markdownFiles;
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

  public async similaritySearchByFile(
    query: string,
    filePath: string,
    k = 5,
    workspaceId?: string,
  ): Promise<Document<DocumentMetadata>[]> {
    if (!workspaceId) return [];
    const results = await getRetrievalProvider().search({ query, limit: k * 3, workspaceId });
    const fileName = filePath.split('/').pop() || filePath;
    return results.filter((doc) => doc.metadata.fileName?.endsWith(fileName)).slice(0, k);
  }

  public async similaritySearchWritableFiles(
    query: string,
    workspaceId: string,
    k = 5,
  ): Promise<Document<DocumentMetadata>[]> {
    const { WorkspaceStore } = await import('services/workspace/workspace-store');
    const readOnlyFiles = await new WorkspaceStore().getReadOnlyFiles(workspaceId);
    const results = await getRetrievalProvider().search({ query, limit: k * 3, workspaceId });
    return results.filter((doc) => !readOnlyFiles.includes(doc.metadata.fileName || '')).slice(0, k);
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
