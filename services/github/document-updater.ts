import type { WebClient } from '@slack/web-api';
import { Logger } from 'services/common/logger';
import { type DocumentUpdate, updateDocTreeWithChanges } from 'services/document';
import { DocumentUpdateService } from 'services/document/document-update-service';
import { applyAnchorReplacement } from 'services/document/update-anchor';
import { parseGithubUrl } from 'services/slack';
import { VectorStoreService } from 'services/vector/main-service';
import GithubService from './github-service';

/**
 * 문서 업데이트들을 GitHub에 적용합니다.
 */
export async function applyDocumentUpdatesToGithub({
  userId,
  documentUpdates,
  client,
  workspaceId,
}: {
  userId: string;
  documentUpdates: DocumentUpdate[];
  client: WebClient;
  workspaceId?: string;
}): Promise<{ fileName: string; success: boolean; message: string; commitSha?: string }[]> {
  const successfulUpdates: { fileName: string; commitSha: string }[] = [];
  const failedUpdates: string[] = [];

  const updatesByFile = new Map<string, DocumentUpdate[]>();
  for (const update of documentUpdates) {
    if (!updatesByFile.has(update.fileName)) {
      updatesByFile.set(update.fileName, []);
    }
    updatesByFile.get(update.fileName)!.push(update);
  }

  const githubService = GithubService.getInstance();
  const documentUpdateService = DocumentUpdateService.getInstance();
  const vectorStore = VectorStoreService.getInstance();

  for (const [fileName, fileUpdates] of updatesByFile.entries()) {
    try {
      let currentMarkdownFile = vectorStore.getMarkdownFile(fileName, workspaceId);
      if (!currentMarkdownFile) {
        throw new Error(`File not found in vector store: ${fileName}`);
      }

      let updatedMarkdownForGithub = currentMarkdownFile.content;
      const hasAnchorUpdates = fileUpdates.some((update) => !!update.updateAnchor);

      if (hasAnchorUpdates) {
        for (const update of fileUpdates) {
          if (!update.updatedNodeContent?.trim()) {
            Logger.warn(`Skipping anchor update with empty content: ${update.nodeId}`);
            continue;
          }

          if (!update.updateAnchor) {
            Logger.warn(`Skipping non-anchor update in anchor-first path for ${update.nodeId}`);
            continue;
          }

          const replacementResult = applyAnchorReplacement(
            updatedMarkdownForGithub,
            update.updateAnchor,
            update.updatedNodeContent,
          );

          if (!replacementResult.success) {
            throw new Error(`Failed to apply anchored update ${update.updateAnchor.anchorId} in ${fileName}`);
          }

          updatedMarkdownForGithub = replacementResult.updatedMarkdown;
          Logger.info(`Applied anchored update ${update.updateAnchor.anchorId} in ${fileName}`);
        }
        const { parseMarkdownToTree } = await import('services/document/markdown');
        currentMarkdownFile.content = updatedMarkdownForGithub;
        currentMarkdownFile.tree = parseMarkdownToTree(updatedMarkdownForGithub, currentMarkdownFile.name);
      } else {
        // 통일된 처리: 모든 업데이트를 parseAndSplitContent 방식으로 처리
        for (const update of fileUpdates) {
          if (update.updatedNodeContent !== undefined && update.updatedNodeContent !== null) {
            // 기존 노드 내용과 비교하여 실제 변경사항이 있는지 확인
            const currentNode = currentMarkdownFile.tree.nodeMap.get(update.nodeId);
            if (currentNode) {
              const { toString } = await import('mdast-util-to-string');
              const currentContent = toString(currentNode);

              // 내용이 다른 경우에만 업데이트 처리
              if (currentContent.trim() !== update.updatedNodeContent.trim()) {
                const success = await vectorStore.replaceNodeWithEnhancedContent(
                  fileName,
                  update.nodeId,
                  update.updatedNodeContent,
                  workspaceId,
                );
                if (!success) {
                  throw new Error(`Failed to update node ${update.nodeId} in ${fileName}`);
                }
                Logger.info(`Successfully processed unified update for node ${update.nodeId}`);
              } else {
                Logger.info(`No changes detected for node ${update.nodeId}, skipping update`);
              }
            } else {
              Logger.warn(`Node ${update.nodeId} not found in tree, skipping update`);
            }
          } else {
            console.warn(`Skipping update operation for empty content: nodeId=${update.nodeId}, fileName=${fileName}`);
          }
        }

        // 업데이트 후 최신 MarkdownFile 객체를 다시 가져옴
        currentMarkdownFile = vectorStore.getMarkdownFile(fileName, workspaceId);
        if (!currentMarkdownFile) {
          throw new Error(`File not found in vector store after updates: ${fileName}`);
        }

        // 최종 마크다운 생성
        const { treeToMarkdown } = await import('services/document/markdown');
        updatedMarkdownForGithub = treeToMarkdown(currentMarkdownFile.tree);
      }

      Logger.debug(`Generated final markdown length: ${updatedMarkdownForGithub.length}`);
      Logger.debug(`Generated markdown content for ${fileName}:\n${updatedMarkdownForGithub}`);

      const allMessages = fileUpdates.flatMap((update) => update.messages || []);
      const commitMessage = await githubService.createCommitMessage(
        fileName,
        userId,
        fileUpdates[0].nodeId,
        fileUpdates[0].knowledgeContent || fileUpdates[0].updatedNodeContent || 'Updated content',
        allMessages,
        client,
      );

      const githubUrl = fileUpdates[0].githubUrl;
      const parsedUrl = parseGithubUrl(githubUrl);
      if (!parsedUrl) {
        throw new Error(`Invalid GitHub URL: ${githubUrl}`);
      }
      const { owner, repo, path: repoPath } = parsedUrl;
      const branchMatch = githubUrl.match(/\/blob\/([^/]+)\//);
      const branch = branchMatch?.[1];

      if (workspaceId) {
        await documentUpdateService.stageMarkdownUpdate({
          workspaceId,
          filePath: currentMarkdownFile.path,
          content: updatedMarkdownForGithub,
          owner,
          repo,
          branch,
        });
      }

      // 3. GitHub에 최종 업데이트
      const updateResult = await githubService.updateMarkdownFile({
        owner,
        repo,
        path: currentMarkdownFile.path,
        content: updatedMarkdownForGithub,
        message: commitMessage,
        branch,
        workspaceId,
        userId,
      });

      Logger.info(`Successfully updated ${fileName} on GitHub`);
      if (workspaceId) {
        await documentUpdateService.markGithubSyncSuccess({
          workspaceId,
          filePath: currentMarkdownFile.path,
          owner,
          repo,
          branch,
          commitSha: updateResult.commitSha,
        });
      }

      // 벡터 스토어는 이미 appendSpecificNode를 통해 업데이트됨
      Logger.info(`Vector store updates completed during node processing for ${fileName}`);

      successfulUpdates.push({ fileName, commitSha: updateResult.commitSha });
    } catch (error) {
      failedUpdates.push(fileName);
      Logger.error(`Error processing updates for ${fileName}`, error as Error);
    }
  }

  const results: { fileName: string; success: boolean; message: string; commitSha?: string }[] = [];
  successfulUpdates.forEach(({ fileName, commitSha }) => {
    results.push({
      fileName,
      success: true,
      message: `✅ Successfully updated ${fileName} on GitHub and attempted vector store sync.`,
      commitSha,
    });
  });
  failedUpdates.forEach((fileName) => {
    results.push({
      fileName,
      success: false,
      message: `❌ Failed to update ${fileName}. Check logs for details.`,
    });
  });

  return results;
}
