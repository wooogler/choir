import fs from 'node:fs';
import path from 'node:path';
import { Document } from '@langchain/core/documents';
import { Logger } from 'services/common/logger';
import { expandQueryWithOpenAI } from 'services/retrieval/openai-query-expansion';
import { getGithubRepo } from 'services/slack';
import type { DocumentMetadata } from 'services/vector/types';
import { WorkspaceMirrorService } from 'services/workspace/mirror-service';
import { sectionPathToOriginalPath, stripItemHeadingPrefix } from 'services/document/markdown-section-splitter';
import type { RetrievalDocument } from 'services/retrieval';
import { searchQmdLexWithFallback } from 'services/retrieval/qmd-lex-search';
import { type UpdateAnchor, stripSnippetHeader } from './update-anchor';

interface QmdLexResult {
  filepath: string;
  displayPath?: string;
  title: string;
  body?: string;
  score: number;
  chunkPos?: number;
}

interface QmdHybridResult {
  file: string;
  displayPath?: string;
  title: string;
  body: string;
  bestChunk?: string;
  score: number;
}

interface QmdSnippetResult {
  line: number;
  snippet: string;
  linesBefore: number;
  snippetLines: number;
}

interface QmdStore {
  searchLex(query: string, options?: { limit?: number; collection?: string }): Promise<QmdLexResult[]>;
  search(options: {
    query?: string;
    queries?: Array<{ type: 'lex' | 'vec' | 'hyde'; query: string }>;
    limit?: number;
    collection?: string;
    collections?: string[];
    rerank?: boolean;
  }): Promise<QmdHybridResult[]>;
  update(options?: { collections?: string[] }): Promise<unknown>;
  embed(options?: { force?: boolean; model?: string }): Promise<unknown>;
  close(): Promise<void>;
}

interface QmdUpdateResult {
  collections: number;
  indexed: number;
  updated: number;
  unchanged: number;
  removed: number;
  needsEmbedding: number;
}

interface QmdModule {
  createStore(options: {
    dbPath: string;
    config: {
      collections: Record<string, { path: string; pattern?: string }>;
    };
  }): Promise<QmdStore>;
  extractSnippet(
    body: string,
    query: string,
    maxLen?: number,
    chunkPos?: number,
    chunkLen?: number,
    intent?: string,
  ): QmdSnippetResult;
}

interface StoreCacheEntry {
  store: QmdStore;
  indexedAt?: string;
  sectionsRoot: string;
  owner: string;
  repo: string;
  branch?: string;
}

function matchesSelectedFile(relativePath: string, selectedFile?: string): boolean {
  if (!selectedFile) {
    return true;
  }

  const normalizedRelativePath = relativePath.replace(/^\/+/, '');
  const normalizedSelectedFile = selectedFile.replace(/^\/+/, '');

  return (
    normalizedRelativePath === normalizedSelectedFile ||
    normalizedRelativePath.endsWith(`/${normalizedSelectedFile}`) ||
    path.posix.basename(normalizedRelativePath) === path.posix.basename(normalizedSelectedFile)
  );
}

export class QmdUpdateAnchorService {
  private static instance: QmdUpdateAnchorService;
  private readonly storeCache = new Map<string, StoreCacheEntry>();
  private qmdModulePromise?: Promise<QmdModule>;

  public static getInstance(): QmdUpdateAnchorService {
    if (!QmdUpdateAnchorService.instance) {
      QmdUpdateAnchorService.instance = new QmdUpdateAnchorService();
    }

    return QmdUpdateAnchorService.instance;
  }

  private async loadQmdModule(): Promise<QmdModule> {
    if (!this.qmdModulePromise) {
      const importQmd = new Function('specifier', 'return import(specifier);') as (specifier: string) => Promise<QmdModule>;
      this.qmdModulePromise = importQmd('@tobilu/qmd');
    }

    return await this.qmdModulePromise;
  }

  private getDbPath(workspaceId: string): string {
    const workspaceRoot = WorkspaceMirrorService.getInstance().getWorkspaceRoot(workspaceId);
    return path.join(workspaceRoot, 'state', 'qmd-index.sqlite');
  }

  private getWarmupQuery(): string {
    return process.env.QMD_WARMUP_QUERY?.trim() || 'documentation';
  }

  private getRelativePath(sectionsRoot: string, rawPath: string, displayPath?: string): string {
    let sectionRelativePath: string;

    if (rawPath.startsWith('qmd://')) {
      const virtualPath = rawPath.replace(/^qmd:\/\//, '');
      const separatorIndex = virtualPath.indexOf('/');
      sectionRelativePath = separatorIndex >= 0 ? virtualPath.slice(separatorIndex + 1) : virtualPath;
    } else if (displayPath) {
      const normalizedDisplayPath = displayPath.split(path.sep).join(path.posix.sep).replace(/^\/+/, '');
      const separatorIndex = normalizedDisplayPath.indexOf('/');
      sectionRelativePath = separatorIndex >= 0 ? normalizedDisplayPath.slice(separatorIndex + 1) : normalizedDisplayPath;
    } else {
      const absolutePath = path.isAbsolute(rawPath) ? rawPath : path.join(sectionsRoot, rawPath);
      sectionRelativePath = path.relative(sectionsRoot, absolutePath).split(path.sep).join(path.posix.sep);
    }

    return sectionPathToOriginalPath(sectionRelativePath);
  }

  private buildGithubUrl(owner: string, repo: string, branch: string | undefined, relativePath: string): string {
    const ref = branch || 'main';
    const normalizedPath = relativePath.split(path.sep).join(path.posix.sep).replace(/^\/+/, '');
    return `https://github.com/${owner}/${repo}/blob/${ref}/${normalizedPath}`;
  }

  private async syncStoreIndex(store: QmdStore, forceEmbed = false): Promise<QmdUpdateResult> {
    const updateResult = (await store.update({ collections: ['docs'] })) as QmdUpdateResult;

    if (forceEmbed || updateResult.needsEmbedding > 0) {
      Logger.info('QmdUpdateAnchorService: generating embeddings for refreshed QMD index.', {
        forceEmbed,
        needsEmbedding: updateResult.needsEmbedding,
      });
      await store.embed({ force: forceEmbed });
    }

    return updateResult;
  }

  private async getOrCreateStore(workspaceId: string): Promise<StoreCacheEntry | null> {
    const repoInfo = await getGithubRepo(workspaceId);
    if (!repoInfo) {
      Logger.warn(`QmdUpdateAnchorService: no GitHub repo configured for workspace ${workspaceId}`);
      return null;
    }

    const mirrorService = WorkspaceMirrorService.getInstance();
    const sectionsRoot = mirrorService.getSectionsRoot(workspaceId);
    const syncState = await mirrorService.getSyncState(workspaceId);
    const cached = this.storeCache.get(workspaceId);

    if (cached) {
      if (syncState?.updatedAt && syncState.updatedAt !== cached.indexedAt) {
        await this.syncStoreIndex(cached.store);
        cached.indexedAt = syncState.updatedAt;
      }

      return cached;
    }

    const qmd = await this.loadQmdModule();
    const store = await qmd.createStore({
      dbPath: this.getDbPath(workspaceId),
      config: {
        collections: {
          docs: {
            path: sectionsRoot,
            pattern: '**/*.md',
          },
        },
      },
    });

    await this.syncStoreIndex(store);

    const entry: StoreCacheEntry = {
      store,
      indexedAt: syncState?.updatedAt,
      sectionsRoot,
      owner: repoInfo.owner,
      repo: repoInfo.repo,
      branch: repoInfo.branch,
    };

    this.storeCache.set(workspaceId, entry);
    return entry;
  }

  public async invalidateWorkspace(workspaceId: string): Promise<void> {
    const cached = this.storeCache.get(workspaceId);
    if (!cached) {
      return;
    }

    try {
      await cached.store.close();
    } catch (error) {
      Logger.warn(`QmdUpdateAnchorService: failed to close cached store for workspace ${workspaceId}`, error as Error);
    } finally {
      this.storeCache.delete(workspaceId);
    }
  }

  public async search(params: {
    workspaceId: string;
    query: string;
    limit?: number;
    selectedFile?: string;
  }): Promise<RetrievalDocument[]> {
    const qmd = await this.loadQmdModule();
    const storeEntry = await this.getOrCreateStore(params.workspaceId);
    if (!storeEntry) {
      return [];
    }

    const limit = params.limit ?? 5;
    const queries = await expandQueryWithOpenAI({
      query: params.query,
      purpose: 'update',
    });
    const hybridResults = await storeEntry.store.search({
      queries,
      limit: Math.max(limit * 3, limit),
      collections: ['docs'],
      rerank: false,
    });

    const searchResults =
      hybridResults.length > 0
        ? hybridResults
        : (
            await searchQmdLexWithFallback({
              store: storeEntry.store,
              query: params.query,
              limit: Math.max(limit * 3, limit),
              collection: 'docs',
            })
          ).results;

    const filteredResults = searchResults
      .map((result) => ({
        result,
        relativePath: this.getRelativePath(
          storeEntry.sectionsRoot,
          'file' in result ? result.file : result.filepath,
          result.displayPath,
        ),
      }))
      .filter(({ relativePath }) => matchesSelectedFile(relativePath, params.selectedFile))
      .slice(0, limit);

    const repoRoot = WorkspaceMirrorService.getInstance().getRepoRoot(params.workspaceId);

    return filteredResults.map(({ result, relativePath }) => {
      const sectionBody = result.body || '';
      const itemText = stripItemHeadingPrefix(sectionBody).trim();

      // Locate the item text in the original file to get accurate line numbers.
      let startLine = 1;
      let endLine = 1;
      let originalText = itemText;
      try {
        const originalFilePath = path.join(repoRoot, relativePath);
        const originalContent = fs.readFileSync(originalFilePath, 'utf-8').replace(/\r\n/g, '\n');
        const matchIndex = originalContent.indexOf(itemText);
        if (matchIndex >= 0) {
          startLine = originalContent.slice(0, matchIndex).split('\n').length;
          endLine = startLine + itemText.split('\n').length - 1;
        } else {
          Logger.warn(`QmdUpdateAnchorService: item text not found in original file ${relativePath}`, {
            workspaceId: params.workspaceId,
            itemTextPreview: itemText.slice(0, 80),
          });
          // Fall back to extractSnippet if exact match fails
          const fallback = qmd.extractSnippet(
            originalContent,
            params.query,
            Number(process.env.QMD_UPDATE_SNIPPET_MAX_LEN || 500),
          );
          if (fallback?.snippet) {
            originalText = stripSnippetHeader(fallback.snippet).trim();
            startLine = (fallback.linesBefore ?? 0) + 1;
            endLine = startLine + (fallback.snippetLines ?? 1) - 1;
          }
        }
      } catch (error) {
        Logger.warn(`QmdUpdateAnchorService: could not read original file ${relativePath}`, error as Error);
      }

      const focusLine = startLine;

      const updateAnchor: UpdateAnchor = {
        source: 'qmd',
        anchorId: `qmd:${relativePath}:${startLine}:${focusLine}`,
        filePath: relativePath,
        snippet: sectionBody,
        originalText,
        title: result.title,
        score: result.score,
        startLine,
        endLine,
        focusLine,
        snippetLines: Math.max(1, originalText.split('\n').length),
        chunkPos: 'chunkPos' in result ? result.chunkPos : undefined,
      };

      return new Document<DocumentMetadata>({
        pageContent: sectionBody,
        metadata: {
          fileName: relativePath,
          nodeId: updateAnchor.anchorId,
          sectionName: result.title,
          headingPath: result.title,
          nodeType: 'document',
          githubUrl: this.buildGithubUrl(storeEntry.owner, storeEntry.repo, storeEntry.branch, relativePath),
          originalContent: originalText,
          updateAnchor,
        },
      });
    });
  }

  public async warmup(params: { workspaceId: string; query?: string }): Promise<void> {
    const storeEntry = await this.getOrCreateStore(params.workspaceId);
    if (!storeEntry) {
      Logger.warn(`QmdUpdateAnchorService: skipping warm-up because no store is available for workspace ${params.workspaceId}`);
      return;
    }

    const query = params.query?.trim() || this.getWarmupQuery();
    Logger.info('QmdUpdateAnchorService: starting hybrid warm-up.', {
      workspaceId: params.workspaceId,
      query,
    });

    const queries = await expandQueryWithOpenAI({
      query,
      purpose: 'update',
    });
    await storeEntry.store.search({
      queries,
      limit: 1,
      collections: ['docs'],
      rerank: false,
    });

    Logger.info('QmdUpdateAnchorService: hybrid warm-up completed.', {
      workspaceId: params.workspaceId,
    });
  }
}
