import type { WebClient } from '@slack/web-api';
import { Logger } from 'services/common/logger';
import { type DocumentUpdate, updateDocTreeWithChanges } from 'services/document';
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
}: {
  userId: string;
  documentUpdates: DocumentUpdate[];
  client: WebClient;
}): Promise<{ fileName: string; success: boolean; message: string }[]> {
  const successfulUpdates: string[] = [];
  const failedUpdates: string[] = [];

  const updatesByFile = new Map<string, DocumentUpdate[]>();
  for (const update of documentUpdates) {
    if (!updatesByFile.has(update.fileName)) {
      updatesByFile.set(update.fileName, []);
    }
    updatesByFile.get(update.fileName)!.push(update);
  }

  const githubService = GithubService.getInstance();
  const vectorStore = VectorStoreService.getInstance();

  for (const [fileName, fileUpdates] of updatesByFile.entries()) {
    try {
      let currentMarkdownFile = vectorStore.getMarkdownFile(fileName);
      if (!currentMarkdownFile) {
        throw new Error(`File not found in vector store: ${fileName}`);
      }

      // APPEND와 UPDATE 작업을 분리 처리
      const appendOperations = fileUpdates.filter((update) => update.suggestionType === 'APPEND');
      const updateOperations = fileUpdates.filter((update) => update.suggestionType !== 'APPEND');

      // 1. APPEND 작업 먼저 처리 (벡터 스토어 내의 트리 업데이트)
      if (appendOperations.length > 0) {
        for (const appendUpdate of appendOperations) {
          if (appendUpdate.appendedNodeContent !== undefined && appendUpdate.appendedNodeContent !== null) {
            const success = await vectorStore.appendSpecificNode(
              fileName,
              appendUpdate.nodeId,
              appendUpdate.appendedNodeContent,
            );
            if (!success) {
              throw new Error(`Failed to append node ${appendUpdate.nodeId} in ${fileName}`);
            }
          } else {
            console.warn(`Skipping append operation for empty content: nodeId=${appendUpdate.nodeId}, fileName=${fileName}`);
          }
        }
        // APPEND 작업 후 최신 MarkdownFile 객체를 다시 가져옴
        currentMarkdownFile = vectorStore.getMarkdownFile(fileName);
        if (!currentMarkdownFile) {
          throw new Error(`File not found in vector store after APPEND: ${fileName}`);
        }
      }

      // 2. 최종 마크다운 생성
      let updatedMarkdownForGithub: string;
      const { treeToMarkdown } = await import('services/document/markdown');

      if (updateOperations.length > 0) {
        // UPDATE 작업이 있으면, (APPEND가 이미 적용된) 현재 트리에 UPDATE를 적용
        updatedMarkdownForGithub = updateDocTreeWithChanges(currentMarkdownFile.tree, updateOperations);
      } else {
        // APPEND만 있었던 경우, (APPEND가 이미 적용된) 현재 트리를 마크다운으로 변환
        Logger.debug(`APPEND 후 트리 상태 (UPDATE 없음):`, {
          nodeMapSize: currentMarkdownFile.tree.nodeMap.size,
          appendedNodes: Array.from(currentMarkdownFile.tree.nodeMap.keys()).filter((id) => id.includes('_append_')),
        });

        updatedMarkdownForGithub = treeToMarkdown(currentMarkdownFile.tree);

        Logger.debug(`변환된 마크다운 길이 (UPDATE 없음): ${updatedMarkdownForGithub.length}`);
      }

      const allMessages = fileUpdates.flatMap((update) => update.messages || []);
      const commitMessage = await githubService.createCommitMessage(
        fileName,
        userId,
        fileUpdates[0].nodeId,
        fileUpdates[0].knowledgeContent ||
          fileUpdates[0].updatedNodeContent ||
          fileUpdates[0].appendedNodeContent ||
          'Updated content',
        allMessages,
        client,
      );

      const githubUrl = fileUpdates[0].githubUrl;
      const parsedUrl = parseGithubUrl(githubUrl);
      if (!parsedUrl) {
        throw new Error(`Invalid GitHub URL: ${githubUrl}`);
      }
      const { owner, repo, path: repoPath } = parsedUrl;

      // 3. GitHub에 최종 업데이트
      await githubService.updateMarkdownFile({
        owner,
        repo,
        path: currentMarkdownFile.path,
        content: updatedMarkdownForGithub,
        message: commitMessage,
      });

      Logger.info(`Successfully updated ${fileName} on GitHub`);

      // 4. GitHub 업데이트 성공 후, 최종적으로 벡터 스토어의 문서 내용 및 임베딩 업데이트 (UPDATE 작업에 대해서만)
      if (updateOperations.length > 0) {
        try {
          const nodeUpdates = updateOperations.map((op) => ({
            nodeId: op.nodeId,
            content: op.updatedNodeContent,
          }));
          const vectorUpdateSuccess = await vectorStore.updateSpecificNodes(fileName, nodeUpdates);
          if (vectorUpdateSuccess) {
            Logger.info(`Successfully updated vector store for ${fileName} (UPDATE operations)`);
          } else {
            Logger.warn(
              `Failed to update vector store for ${fileName} (UPDATE operations), but GitHub update was successful`,
            );
          }
        } catch (vectorError) {
          Logger.error(
            `Error updating vector store for ${fileName} (UPDATE operations) after GitHub success`,
            vectorError as Error,
          );
        }
      }

      successfulUpdates.push(fileName);
    } catch (error) {
      failedUpdates.push(fileName);
      Logger.error(`Error processing updates for ${fileName}`, error as Error);
    }
  }

  const results: { fileName: string; success: boolean; message: string }[] = [];
  successfulUpdates.forEach((fileName) => {
    results.push({
      fileName,
      success: true,
      message: `✅ Successfully updated ${fileName} on GitHub and attempted vector store sync.`,
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
