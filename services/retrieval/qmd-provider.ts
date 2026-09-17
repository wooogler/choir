import fs from 'node:fs';
import path from 'node:path';
import { Document } from '@langchain/core/documents';
import type { LanguageCode } from 'services/common/language';
import { Logger } from 'services/common/logger';
import { sectionPathToOriginalPath } from 'services/document/markdown-section-splitter';
import type { DocumentMetadata } from 'services/file-registry/types';
import { buildCrossLingualSearchQueries } from 'services/llm/query-translation';
import { getGithubRepo } from 'services/slack';
import { WorkspaceMirrorService } from 'services/workspace/mirror-service';
import { PathMapService } from 'services/workspace/path-map-service';
import {
  VECTOR_SEARCH_FAILURE_HINT,
  ensureEmbedModelUpToDate,
  getConfiguredEmbedModel,
  getVectorSearchFailureCount,
  recordVectorSearchFailure,
  writeIndexMeta,
} from './qmd-embed-guard';
import { buildQmdStructuredSearchQueries, searchQmdLexWithFallback } from './qmd-lex-search';
import { detectRepositoryLanguage } from './repository-language';
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
  /**
   * Dominant language of the mirrored documentation, sampled once per store and
   * refreshed with the index. Drives the cross-lingual query translation.
   */
  repositoryLanguage?: LanguageCode;
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

  /**
   * QMD can re-score hybrid results with `qwen3-reranker`. It is off by default:
   * on the CPU-only production instances the extra cross-encoder pass costs more
   * latency per answer than the ordering it buys. Opt in with `QMD_RERANK=true`.
   */
  private isRerankEnabled(): boolean {
    return process.env.QMD_RERANK === 'true';
  }

  private getWarmupQuery(): string {
    return process.env.QMD_WARMUP_QUERY?.trim() || 'documentation';
  }

  private getDbPath(workspaceId: string): string {
    const workspaceRoot = WorkspaceMirrorService.getInstance().getWorkspaceRoot(workspaceId);
    // The `-v2` suffix is tied to the section-file on-disk layout (see
    // SECTIONS_FORMAT_VERSION in mirror-service): when that layout changes the
    // index must be rebuilt from the new section paths, so a new db file is used
    // and the stale one is simply abandoned.
    return path.join(workspaceRoot, 'state', 'qmd-index-v2.sqlite');
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

  // Serialize store creation/refresh per workspace: concurrent callers (search,
  // warmup, save) would otherwise each build/refresh the index, racing on the
  // sections dir and leaking duplicate stores. Later callers await the same
  // in-flight promise (and then hit the cache fast-path).
  private readonly getOrCreateInFlight = new Map<string, Promise<StoreCacheEntry | null>>();

  private getOrCreateStore(workspaceId: string): Promise<StoreCacheEntry | null> {
    const existing = this.getOrCreateInFlight.get(workspaceId);
    if (existing) return existing;

    const promise = this.getOrCreateStoreUnlocked(workspaceId).finally(() => {
      this.getOrCreateInFlight.delete(workspaceId);
    });
    this.getOrCreateInFlight.set(workspaceId, promise);
    return promise;
  }

  private async getOrCreateStoreUnlocked(workspaceId: string): Promise<StoreCacheEntry | null> {
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
        // Files changed, so the sampled language may have changed with them.
        cached.repositoryLanguage = await detectRepositoryLanguage(cached.sectionsRoot);
      }

      return cached;
    }

    const sectionsRoot = this.getSectionsRoot(workspaceId);
    await mirrorService.populateSectionsIfEmpty(workspaceId);

    const dbPath = this.getDbPath(workspaceId);
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

    // Before this store serves anything: if the configured embedding model no
    // longer matches the one the index was embedded with, the stored vectors are
    // unusable (and would fail as a dimension mismatch deep inside QMD), so a
    // forced re-embed has to run first.
    const embedGuardOutcome = await ensureEmbedModelUpToDate({
      workspaceId,
      dbPath,
      reembed: () => this.syncStoreIndex(store, true),
    });

    if (embedGuardOutcome !== 're-embedded') {
      await this.syncStoreIndex(store);
    }

    const entry: StoreCacheEntry = {
      store,
      indexedAt: syncState?.updatedAt,
      sectionsRoot,
      owner: repoInfo.owner,
      repo: repoInfo.repo,
      branch: repoInfo.branch || syncState?.branch,
      repositoryLanguage: await detectRepositoryLanguage(sectionsRoot),
    };

    this.storeCache.set(workspaceId, entry);
    Logger.info(`QmdRetrievalProvider: initialized QMD store for workspace ${workspaceId}`, {
      repoRoot,
      dbPath,
      searchMode: this.getSearchMode(),
      rerank: this.isRerankEnabled(),
      embedModel: getConfiguredEmbedModel(),
      embedGuardOutcome,
      repositoryLanguage: entry.repositoryLanguage,
      vectorSearchFailures: getVectorSearchFailureCount(),
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
      // The index now holds vectors from whatever model is configured right now:
      // record it so the guard does not re-embed again on the next start.
      await writeIndexMeta(dbPath, getConfiguredEmbedModel());

      this.storeCache.set(workspaceId, {
        store,
        indexedAt: syncState?.updatedAt,
        sectionsRoot,
        owner: repoInfo.owner,
        repo: repoInfo.repo,
        branch: repoInfo.branch || syncState?.branch,
        repositoryLanguage: await detectRepositoryLanguage(sectionsRoot),
      });

      Logger.info(`QmdRetrievalProvider: rebuilt QMD index for workspace ${workspaceId}`, {
        dbPath,
        sectionsRoot,
        updateResult,
        embedResult,
        embedModel: getConfiguredEmbedModel(),
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
    // Capture the narrowed value so the nested map closures below don't need a
    // non-null assertion (control-flow narrowing is lost inside closures).
    const workspaceId = params.workspaceId;

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
        // Adds a translated vector leg when the asker's language is not the
        // repository's; identical to the plain structured queries otherwise.
        const queries = await buildCrossLingualSearchQueries({
          query: params.query,
          repositoryLanguage: storeEntry.repositoryLanguage,
          workspaceId,
          maxLexCandidates: 2,
        });

        let results: QmdHybridQueryResult[] = [];
        try {
          results = await storeEntry.store.search({
            queries,
            limit,
            collections: ['docs'],
            rerank: this.isRerankEnabled(),
          });
        } catch (error) {
          // The single most likely cause is an index whose vectors were written
          // by a different embedding model, which surfaces far away from here as
          // a dimension mismatch. Say so loudly instead of quietly answering
          // from lexical hits alone.
          const failureCount = recordVectorSearchFailure();
          Logger.error(`QmdRetrievalProvider: hybrid search failed. ${VECTOR_SEARCH_FAILURE_HINT}`, error as Error, {
            workspaceId: params.workspaceId,
            embedModel: getConfiguredEmbedModel(),
            vectorSearchFailures: failureCount,
          });
        }

        if (results.length > 0) {
          return results.map((result) =>
            this.mapHybridResultToDocument({
              result,
              sectionsRoot: storeEntry.sectionsRoot,
              owner: storeEntry.owner,
              repo: storeEntry.repo,
              branch: storeEntry.branch,
              workspaceId,
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
          workspaceId,
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

    // No translation on warm-up: the warm-up query exists to load the models, so
    // it must not depend on (or pay for) an LLM round-trip.
    const queries = buildQmdStructuredSearchQueries(query, 2);
    await storeEntry.store.search({
      queries,
      limit: 1,
      collections: ['docs'],
      rerank: this.isRerankEnabled(),
    });

    Logger.info('QmdRetrievalProvider: hybrid warm-up completed.', {
      workspaceId: params.workspaceId,
      embedModel: getConfiguredEmbedModel(),
      repositoryLanguage: storeEntry.repositoryLanguage,
      rerank: this.isRerankEnabled(),
      vectorSearchFailures: getVectorSearchFailureCount(),
    });
  }

  isHealthy(): boolean {
    return this.storeCache.size > 0;
  }
}
