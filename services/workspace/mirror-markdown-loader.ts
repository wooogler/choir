import fs from 'node:fs';
import path from 'node:path';
import { parseMarkdownToTree } from 'services/document/markdown';
import { Logger } from 'services/common/logger';
import type { MarkdownFile } from 'services/github';
import { WorkspaceMirrorService } from './mirror-service';

export class WorkspaceMirrorMarkdownLoader {
  private static instance: WorkspaceMirrorMarkdownLoader;

  public static getInstance(): WorkspaceMirrorMarkdownLoader {
    if (!WorkspaceMirrorMarkdownLoader.instance) {
      WorkspaceMirrorMarkdownLoader.instance = new WorkspaceMirrorMarkdownLoader();
    }

    return WorkspaceMirrorMarkdownLoader.instance;
  }

  public async loadMarkdownFiles(params: {
    workspaceId: string;
    owner: string;
    repo: string;
    branch?: string;
  }): Promise<MarkdownFile[]> {
    const repoRoot = WorkspaceMirrorService.getInstance().getRepoRoot(params.workspaceId);
    if (!fs.existsSync(repoRoot)) {
      Logger.info(`Workspace mirror repo root does not exist: ${repoRoot}`);
      return [];
    }

    const markdownPaths: string[] = [];
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

        if (entry.isFile() && entry.name.endsWith('.md')) {
          markdownPaths.push(entryPath);
        }
      }
    }

    markdownPaths.sort();

    const branch = params.branch || 'main';
    const markdownFiles: MarkdownFile[] = [];

    for (const absolutePath of markdownPaths) {
      const content = await fs.promises.readFile(absolutePath, 'utf-8');
      const relativePath = path.relative(repoRoot, absolutePath).split(path.sep).join(path.posix.sep);

      markdownFiles.push({
        name: path.posix.basename(relativePath),
        path: relativePath,
        content,
        githubUrl: `https://github.com/${params.owner}/${params.repo}/blob/${branch}/${relativePath}`,
        tree: parseMarkdownToTree(content, path.posix.basename(relativePath)),
      });
    }

    Logger.info(`Loaded ${markdownFiles.length} markdown files from workspace mirror`, {
      workspaceId: params.workspaceId,
      owner: params.owner,
      repo: params.repo,
    });

    return markdownFiles;
  }
}
