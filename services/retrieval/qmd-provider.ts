import fs from 'node:fs';
import path from 'node:path';
import { Document } from '@langchain/core/documents';
import { Logger } from 'services/common/logger';
import { sectionPathToOriginalPath } from 'services/document/markdown-section-splitter';
import type { DocumentMetadata } from 'services/file-registry/types';
import { getGithubRepo } from 'services/slack';
import { WorkspaceMirrorService } from 'services/workspace/mirror-service';
import { PathMapService } from 'services/workspace/path-map-service';
import { buildQmdStructuredSearchQueries, searchQmdLexWithFallback } from './qmd-lex-search';
import type { RetrievalDocument, RetrievalProvider, RetrievalSearchParams, RetrievalWarmupParams } from './types';

type QmdSearchMode = 'lex' | 'hybrid';

interface QmdStore {
  searchLex(query: string, options?: { limit?: number; collection?: string }): Promise<QmdSearchResult[]>;
  search(options: {
    query?: string;
    queries?: Array<{ type: 'lex' | 'vec' | 'hyde'; query: string }>;
    limit?: number;
    collection?: string;
    collections?: string[];
    rerank?: boolean;
  }): Promise<QmdHybridQueryResult[]>;
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

interface QmdEmbedResult {
  docsProcessed: number;
  chunksEmbedded: number;
  errors: number;
  durationMs: number;
}

interface QmdSearchResult {
  filepath: string;
  displayPath?: string;
  title: string;
  body?: string;
  score: number;
}

interface QmdHybridQueryResult {
  file: string;
  displayPath?: string;
  title: string;
  body: string;
  bestChunk?: string;
  score: number;
}

interface QmdModule {
  createStore(options: {
    dbPath: string;
    config: {
      collections: Record<string, { path: string; pattern?: string }>;
    };
  }): Promise<QmdStore>;
}

interface StoreCacheEntry {
  store: QmdStore;
  indexedAt?: string;
  sectionsRoot: string;
  owner: string;
  repo: string;
  branch?: string;
}

export class QmdRetrievalProvider implements RetrievalProvider {
  public readonly name = 'qmd' as const;
  private readonly storeCache = new Map<string, StoreCacheEntry>();
  private qmdModulePromise?: Promise<QmdModule>;

  private async loadQmdModule(): Promise<QmdModule> {
    if (!this.qmdModulePromise) {
      const importQmd = new Function('specifier', 'return import(specifier);') as (
        specifier: string,
      ) => Promise<QmdModule>;
      this.qmdModulePromise = importQmd('@tobilu/qmd');
    }

    return await this.qmdModulePromise;
  }

  private getSearchMode(): QmdSearchMode {
    return process.env.QMD_SEARCH_MODE === 'lex' ? 'lex' : 'hybrid';
  }

  private getWarmupQuery(): string {
    return process.env.QMD_WARMUP_QUERY?.trim() || 'documentation';
  }

  private getDbPath(workspaceId: string): string {
    const workspaceRoot = WorkspaceMirrorService.getInstance().getWorkspaceRoot(workspaceId);
    return path.join(workspaceRoot, 'state', 'qmd-index.sqlite');
  }

  private getSectionsRoot(workspaceId: string): string {
    return WorkspaceMirrorService.getInstance().getSectionsRoot(workspaceId);
  }

  private buildGithubUrl(
    owner: string,
    repo: string,
    branch: string | undefined,
    relativePath: string,
    workspaceId?: string,
  ): string {
    const normalizedPath = relativePath.split(path.sep).join(path.posix.sep).replace(/^\/+/, '');
    const docsBaseUrl = process.env.DOCS_BASE_URL?.replace(/\/$/, '');
    if (docsBaseUrl && workspaceId) {
      return `${docsBaseUrl}/docs/${workspaceId}/${normalizedPath}`;
    }
    const ref = branch || 'main';
    return `https://github.com/${owner}/${repo}/blob/${ref}/${normalizedPath}`;
  }

  private getRelativePathFromQmdPath(sectionsRoot: string, rawPath: string, displayPath?: string): string {
    let sectionRelativePath: string;

    if (rawPath.startsWith('qmd://')) {
      const virtualPath = rawPath.replace(/^qmd:\/\//, '');
      const separatorIndex = virtualPath.indexOf('/');
      sectionRelativePath = separatorIndex >= 0 ? virtualPath.slice(separatorIndex + 1) : virtualPath;
    } else if (displayPath) {
      const normalizedDisplayPath = displayPath.split(path.sep).join(path.posix.sep).replace(/^\/+/, '');
      const separatorIndex = normalizedDisplayPath.indexOf('/');
      sectionRelativePath =
        separatorIndex >= 0 ? normalizedDisplayPath.slice(separatorIndex + 1) : normalizedDisplayPath;
    } else {
      const absolutePath = path.isAbsolute(rawPath) ? rawPath : path.join(sectionsRoot, rawPath);
      sectionRelativePath = path.relative(sectionsRoot, absolutePath).split(path.sep).join(path.posix.sep);
    }

    return sectionPathToOriginalPath(sectionRelativePath);
  }

  private mapLexResultToDocument(params: {
    result: QmdSearchResult;
    sectionsRoot: string;
    owner: string;
    repo: string;
    branch?: string;
    workspaceId: string;
  }): RetrievalDocument {
    const relativePath = this.getRelativePathFromQmdPath(
      params.sectionsRoot,
      params.result.filepath,
      params.result.displayPath,
    );
    const originalPath = PathMapService.getInstance().getOriginalPath(params.workspaceId, relativePath);
    const body = params.result.body || '';
    const title = params.result.title || path.posix.basename(originalPath);

    return new Document<DocumentMetadata>({
      pageContent: body,
      metadata: {
        fileName: originalPath,
        nodeId: `qmd:${relativePath}`,
        sectionName: title,
        headingPath: title,
        nodeType: 'document',
        githubUrl: this.buildGithubUrl(params.owner, params.repo, params.branch, originalPath, params.workspaceId),
        originalContent: body,
      },
    });
  }

  private mapHybridResultToDocument(params: {
    result: QmdHybridQueryResult;
    sectionsRoot: string;
    owner: string;
    repo: string;
    branch?: string;
    workspaceId: string;
  }): RetrievalDocument {
    const relativePath = this.getRelativePathFromQmdPath(
      params.sectionsRoot,
      params.result.file,
      params.result.displayPath,
    );
    const originalPath = PathMapService.getInstance().getOriginalPath(params.workspaceId, relativePath);
    const body = params.result.bestChunk || params.result.body || '';
    const title = params.result.title || path.posix.basename(originalPath);

    return new Document<DocumentMetadata>({
      pageContent: body,
      metadata: {
        fileName: originalPath,
        nodeId: `qmd:${relativePath}`,
        sectionName: title,
        headingPath: title,
        nodeType: 'document',
        githubUrl: this.buildGithubUrl(params.owner, params.repo, params.branch, originalPath, params.workspaceId),
        originalContent: body,
      },
    });
  }

  private async syncStoreIndex(
    store: QmdStore,
    forceEmbed = false,
  ): Promise<{
    updateResult: QmdUpdateResult;
    embedResult?: QmdEmbedResult;
  }> {
    const updateResult = (await store.update({ collections: ['docs'] })) as QmdUpdateResult;
    let embedResult: QmdEmbedResult | undefined;

    if (forceEmbed || updateResult.needsEmbedding > 0) {
      Logger.info(
        'QmdRetrievalProvider: generating embeddings for refreshed QMD index. This can take a while on CPU.',
        {
          forceEmbed,
          needsEmbedding: updateResult.needsEmbedding,
        },
      );
      embedResult = (await store.embed({ force: forceEmbed })) as QmdEmbedResult;
    }

    return {
      updateResult,
      embedResult,
    };
  }

  private async removeDbArtifacts(dbPath: string): Promise<void> {
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      const targetPath = `${dbPath}${suffix}`;
      if (fs.existsSync(targetPath)) {
        await fs.promises.unlink(targetPath);
      }
    }
  }

  private async getOrCreateStore(workspaceId: string): Promise<StoreCacheEntry | null> {
    const repoInfo = await getGithubRepo(workspaceId);
    if (!repoInfo) {
      Logger.warn(`QmdRetrievalProvider: no GitHub repo configured for workspace ${workspaceId}`);
      return null;
    }

    const mirrorService = WorkspaceMirrorService.getInstance();
    const repoRoot = mirrorService.getRepoRoot(workspaceId);
    const syncState = await mirrorService.getSyncState(workspaceId);
    const cached = this.storeCache.get(workspaceId);

    if (cached) {
      if (syncState?.updatedAt && syncState.updatedAt !== cached.indexedAt) {
        Logger.info('QmdRetrievalProvider: workspace mirror changed, refreshing QMD index', {
          workspaceId,
          updatedAt: syncState.updatedAt,
        });
        await this.syncStoreIndex(cached.store);
        cached.indexedAt = syncState.updatedAt;
      }

      return cached;
    }

    const sectionsRoot = this.getSectionsRoot(workspaceId);
    await mirrorService.populateSectionsIfEmpty(workspaceId);

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
      branch: repoInfo.branch || syncState?.branch,
    };

    this.storeCache.set(workspaceId, entry);
    Logger.info(`QmdRetrievalProvider: initialized QMD store for workspace ${workspaceId}`, {
      repoRoot,
      dbPath: this.getDbPath(workspaceId),
      searchMode: this.getSearchMode(),
    });

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
      Logger.warn(`QmdRetrievalProvider: failed to close cached store for workspace ${workspaceId}`, error as Error);
    } finally {
      this.storeCache.delete(workspaceId);
    }
  }

  public async rebuildWorkspaceIndex(workspaceId: string): Promise<{
    updateResult: QmdUpdateResult;
    embedResult?: QmdEmbedResult;
    dbPath: string;
  }> {
    const repoInfo = await getGithubRepo(workspaceId);
    if (!repoInfo) {
      throw new Error(`No GitHub repository configured for workspace ${workspaceId}`);
    }

    const mirrorService = WorkspaceMirrorService.getInstance();
    const sectionsRoot = this.getSectionsRoot(workspaceId);
    const syncState = await mirrorService.getSyncState(workspaceId);
    const dbPath = this.getDbPath(workspaceId);

    await this.invalidateWorkspace(workspaceId);
    await this.removeDbArtifacts(dbPath);

    const qmd = await this.loadQmdModule();
    const store = await qmd.createStore({
      dbPath,
      config: {
        collections: {
          docs: {
            path: sectionsRoot,
            pattern: '**/*.md',
          },
        },
      },
    });

    try {
      const { updateResult, embedResult } = await this.syncStoreIndex(store, true);
      this.storeCache.set(workspaceId, {
        store,
        indexedAt: syncState?.updatedAt,
        sectionsRoot,
        owner: repoInfo.owner,
        repo: repoInfo.repo,
        branch: repoInfo.branch || syncState?.branch,
      });

      Logger.info(`QmdRetrievalProvider: rebuilt QMD index for workspace ${workspaceId}`, {
        dbPath,
        sectionsRoot,
        updateResult,
        embedResult,
      });

      return {
        updateResult,
        embedResult,
        dbPath,
      };
    } catch (error) {
      try {
        await store.close();
      } catch (closeError) {
        Logger.warn(
          `QmdRetrievalProvider: failed to close store after rebuild failure for workspace ${workspaceId}`,
          closeError as Error,
        );
      }
      throw error;
    }
  }

  async search(params: RetrievalSearchParams): Promise<RetrievalDocument[]> {
    if (!params.workspaceId) {
      Logger.warn('QmdRetrievalProvider: workspaceId missing, returning empty results');
      return [];
    }

    try {
      const storeEntry = await this.getOrCreateStore(params.workspaceId);
      if (!storeEntry) {
        return [];
      }

      const limit = params.limit ?? 5;
      const searchMode = this.getSearchMode();

      Logger.info(
        `QmdRetrievalProvider: searching for "${params.query.substring(0, 50)}${params.query.length > 50 ? '...' : ''}"`,
        {
          workspaceId: params.workspaceId,
          limit,
          searchMode,
        },
      );

      if (searchMode === 'hybrid') {
        const queries = buildQmdStructuredSearchQueries(params.query, 2);
        const results = await storeEntry.store.search({
          queries,
          limit,
          collections: ['docs'],
          rerank: false,
        });

        if (results.length > 0) {
          return results.map((result) =>
            this.mapHybridResultToDocument({
              result,
              sectionsRoot: storeEntry.sectionsRoot,
              owner: storeEntry.owner,
              repo: storeEntry.repo,
              branch: storeEntry.branch,
              workspaceId: params.workspaceId!,
            }),
          );
        }

        Logger.info(
          'QmdRetrievalProvider: hybrid search returned no results, falling back to lexical candidate search.',
          {
            workspaceId: params.workspaceId,
            query: params.query,
            queries,
          },
        );
      }

      const { results, matchedCandidate, queryCandidates } = await searchQmdLexWithFallback({
        store: storeEntry.store,
        query: params.query,
        limit,
        collection: 'docs',
      });

      if (matchedCandidate && matchedCandidate !== params.query.trim()) {
        Logger.info('QmdRetrievalProvider: lexical fallback matched with simplified query candidate.', {
          workspaceId: params.workspaceId,
          originalQuery: params.query,
          matchedCandidate,
          queryCandidates,
          resultCount: results.length,
        });
      }

      return results.map((result) =>
        this.mapLexResultToDocument({
          result,
          sectionsRoot: storeEntry.sectionsRoot,
          owner: storeEntry.owner,
          repo: storeEntry.repo,
          branch: storeEntry.branch,
          workspaceId: params.workspaceId!,
        }),
      );
    } catch (error) {
      Logger.warn(
        `QmdRetrievalProvider: search failed for query "${params.query.substring(0, 50)}${params.query.length > 50 ? '...' : ''}".`,
        error as Error,
      );
      return [];
    }
  }

  async warmup(params: RetrievalWarmupParams): Promise<void> {
    const storeEntry = await this.getOrCreateStore(params.workspaceId);
    if (!storeEntry) {
      Logger.warn(
        `QmdRetrievalProvider: skipping warm-up because no store is available for workspace ${params.workspaceId}`,
      );
      return;
    }

    const query = params.query?.trim() || this.getWarmupQuery();
    Logger.info('QmdRetrievalProvider: starting hybrid warm-up.', {
      workspaceId: params.workspaceId,
      query,
    });

    const queries = buildQmdStructuredSearchQueries(query, 2);
    await storeEntry.store.search({
      queries,
      limit: 1,
      collections: ['docs'],
      rerank: false,
    });

    Logger.info('QmdRetrievalProvider: hybrid warm-up completed.', {
      workspaceId: params.workspaceId,
    });
  }

  isHealthy(): boolean {
    return this.storeCache.size > 0;
  }
}
