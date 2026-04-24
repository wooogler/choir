import path from 'node:path';
import { Document } from '@langchain/core/documents';
import { Logger } from 'services/common/logger';
import { expandQueryWithOpenAI } from 'services/retrieval/openai-query-expansion';
import { getGithubRepo } from 'services/slack';
import type { DocumentMetadata } from 'services/vector/types';
import { WorkspaceMirrorService } from 'services/workspace/mirror-service';
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
  repoRoot: string;
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

function isFenceLine(line: string): boolean {
  return line.trim().startsWith('```');
}

function isBoundaryLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed === '' || /^#{1,6}\s/.test(trimmed);
}

function isInsideCodeFence(lines: string[], lineIndex: number): boolean {
  let fenceCount = 0;

  for (let index = 0; index <= lineIndex; index += 1) {
    if (isFenceLine(lines[index] || '')) {
      fenceCount += 1;
    }
  }

  return fenceCount % 2 === 1;
}

function getBlockAroundLine(body: string, startLine: number, snippetLines: number): { text: string; startLine: number; endLine: number } {
  const lines = body.split('\n');
  if (lines.length === 0) {
    return {
      text: '',
      startLine: startLine || 1,
      endLine: startLine || 1,
    };
  }

  let startIndex = Math.max(0, startLine - 1);
  let endIndex = Math.min(lines.length - 1, startIndex + Math.max(0, snippetLines - 1));

  if (isInsideCodeFence(lines, startIndex) || isFenceLine(lines[startIndex] || '')) {
    while (startIndex > 0 && !isFenceLine(lines[startIndex - 1] || '')) {
      startIndex -= 1;
    }
    while (endIndex < lines.length - 1 && !isFenceLine(lines[endIndex] || '')) {
      endIndex += 1;
    }
    if (endIndex < lines.length - 1 && isFenceLine(lines[endIndex + 1] || '')) {
      endIndex += 1;
    }
  } else {
    while (startIndex > 0 && !isBoundaryLine(lines[startIndex - 1] || '')) {
      startIndex -= 1;
    }
    while (endIndex < lines.length - 1 && !isBoundaryLine(lines[endIndex + 1] || '')) {
      endIndex += 1;
    }
  }

  return {
    text: lines.slice(startIndex, endIndex + 1).join('\n').trim(),
    startLine: startIndex + 1,
    endLine: endIndex + 1,
  };
}

function findChunkLineRange(body: string, chunk: string): { startLine: number; snippetLines: number } | null {
  const normalizedChunk = chunk.trim();
  if (!body || !normalizedChunk) {
    return null;
  }

  const chunkIndex = body.indexOf(normalizedChunk);
  if (chunkIndex < 0) {
    return null;
  }

  const prefix = body.slice(0, chunkIndex);
  const startLine = prefix.split('\n').length;
  const snippetLines = Math.max(1, normalizedChunk.split('\n').length);

  return {
    startLine,
    snippetLines,
  };
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

  private getRelativePath(repoRoot: string, rawPath: string, displayPath?: string): string {
    if (rawPath.startsWith('qmd://')) {
      const virtualPath = rawPath.replace(/^qmd:\/\//, '');
      const separatorIndex = virtualPath.indexOf('/');
      if (separatorIndex >= 0) {
        return virtualPath.slice(separatorIndex + 1);
      }
    }

    if (displayPath) {
      const normalizedDisplayPath = displayPath.split(path.sep).join(path.posix.sep).replace(/^\/+/, '');
      const separatorIndex = normalizedDisplayPath.indexOf('/');
      if (separatorIndex >= 0) {
        return normalizedDisplayPath.slice(separatorIndex + 1);
      }
    }

    const absolutePath = path.isAbsolute(rawPath) ? rawPath : path.join(repoRoot, rawPath);
    return path.relative(repoRoot, absolutePath).split(path.sep).join(path.posix.sep);
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
    const repoRoot = mirrorService.getRepoRoot(workspaceId);
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
            path: repoRoot,
            pattern: '**/*.md',
          },
        },
      },
    });

    await this.syncStoreIndex(store);

    const entry: StoreCacheEntry = {
      store,
      indexedAt: syncState?.updatedAt,
      repoRoot,
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
          storeEntry.repoRoot,
          'file' in result ? result.file : result.filepath,
          result.displayPath,
        ),
      }))
      .filter(({ relativePath }) => matchesSelectedFile(relativePath, params.selectedFile))
      .slice(0, limit);

    return filteredResults.map(({ result, relativePath }) => {
      const body = result.body || '';
      const bestChunk = stripSnippetHeader(('bestChunk' in result ? result.bestChunk : '') || '');
      const chunkLocation = findChunkLineRange(body, bestChunk);
      const snippetResult =
        body && !chunkLocation
          ? qmd.extractSnippet(body, params.query, Number(process.env.QMD_UPDATE_SNIPPET_MAX_LEN || 500))
          : null;
      const snippetBody = bestChunk || stripSnippetHeader(snippetResult?.snippet || '') || body;
      const snippetStartLine = chunkLocation?.startLine || (snippetResult ? snippetResult.linesBefore + 1 : 1);
      const snippetLines = chunkLocation?.snippetLines || snippetResult?.snippetLines || Math.max(1, snippetBody.split('\n').length);
      const blockResult = getBlockAroundLine(body || snippetBody, snippetStartLine, snippetLines);
      const focusLine = snippetResult?.line || snippetStartLine;

      const updateAnchor: UpdateAnchor = {
        source: 'qmd',
        anchorId: `qmd:${relativePath}:${blockResult.startLine}:${focusLine}`,
        filePath: relativePath,
        snippet: snippetBody,
        originalText: blockResult.text || snippetBody,
        title: result.title,
        score: result.score,
        startLine: blockResult.startLine,
        endLine: blockResult.endLine,
        focusLine,
        snippetLines,
        chunkPos: 'chunkPos' in result ? result.chunkPos : undefined,
      };

      return new Document<DocumentMetadata>({
        pageContent: blockResult.text || snippetBody,
        metadata: {
          fileName: relativePath,
          nodeId: updateAnchor.anchorId,
          sectionName: result.title,
          headingPath: result.title,
          nodeType: 'document',
          githubUrl: this.buildGithubUrl(storeEntry.owner, storeEntry.repo, storeEntry.branch, relativePath),
          originalContent: blockResult.text || snippetBody,
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
