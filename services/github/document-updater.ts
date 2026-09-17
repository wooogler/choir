import type { WebClient } from '@slack/web-api';
import { Logger } from 'services/common/logger';
import type { DocumentUpdate } from 'services/document';
import { DocumentUpdateService } from 'services/document/document-update-service';
import { type NodeSplice, applyNodeSplices } from 'services/document/node-splice';
import { type ProvenanceRecord, buildContextFile, persistContextToMirror } from 'services/document/provenance';
import { applyAnchorReplacement } from 'services/document/update-anchor';
import { VectorStoreService } from 'services/file-registry/main-service';
import { schedulePublish } from 'services/google/replica-publisher';
import { getUserName, parseGithubUrl, resolveUserNames } from 'services/slack';
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
    updatesByFile.get(update.fileName)?.push(update);
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

      // Capture the pre-update file content for the provenance diff before any
      // in-place mutation below (anchor path / node replacement).
      const originalFileContent = currentMarkdownFile.content;
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
        // Every offset below indexes `originalFileContent`, so they are all
        // collected against the untouched text and applied together afterwards.
        const { toString: nodeToText } = await import('mdast-util-to-string');
        const splices: NodeSplice[] = [];

        for (const update of fileUpdates) {
          if (update.updatedNodeContent !== undefined && update.updatedNodeContent !== null) {
            // 기존 노드 내용과 비교하여 실제 변경사항이 있는지 확인
            const currentNode = currentMarkdownFile.tree.nodeMap.get(update.nodeId);
            if (currentNode) {
              const currentContent = nodeToText(currentNode);

              // 내용이 다른 경우에만 업데이트 처리
              if (currentContent.trim() !== update.updatedNodeContent.trim()) {
                // Recorded before the tree is mutated below: the offsets have to
                // describe the document this splice will be applied to.
                const start = currentNode.position?.start?.offset;
                const end = currentNode.position?.end?.offset;
                if (typeof start === 'number' && typeof end === 'number') {
                  splices.push({
                    start,
                    end,
                    // The model's own text, spliced verbatim. Re-serializing the
                    // replacement nodes instead would put it through
                    // parseAndSplitContent, which trims every line and joins
                    // multi-line paragraphs with a space.
                    replacement: update.updatedNodeContent.trim(),
                    label: update.nodeId,
                  });
                } else {
                  Logger.warn(`Node ${update.nodeId} in ${fileName} has no source position; skipping its edit`);
                }

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

        // Splice the changed nodes into the original text rather than
        // re-serializing the tree. Re-serializing rewrites the whole file in the
        // serializer's dialect — ordered lists become bullets, nested lists
        // collapse onto one line, frontmatter and setext headings are destroyed,
        // the trailing newline is stripped — so a one-paragraph edit arrived at
        // GitHub as a diff touching nearly every line.
        const spliced = applyNodeSplices(originalFileContent, splices);
        for (const { splice, reason } of spliced.skipped) {
          Logger.warn(`Skipped an update to ${fileName} (${reason}): node ${splice.label ?? 'unknown'}`);
        }
        updatedMarkdownForGithub = spliced.markdown;

        // The vector store's copy is what the next update computes offsets
        // against, so it has to describe the text we are about to commit. The
        // anchored path does the same thing for the same reason.
        const { parseMarkdownToTree } = await import('services/document/markdown');
        currentMarkdownFile.content = updatedMarkdownForGithub;
        currentMarkdownFile.tree = parseMarkdownToTree(updatedMarkdownForGithub, currentMarkdownFile.name);
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

      // 3. GitHub에 최종 업데이트 — 문서 변경 + 암호화 provenance를 한 커밋에.
      let updateResult: { commitSha: string };
      if (workspaceId) {
        const updatedByName = await getUserName(userId, client).catch(() => undefined);
        const nameById = await resolveUserNames(
          allMessages.map((m) => m.user),
          client,
        );
        const isAppendOnly = fileUpdates.every((u) => u.suggestionType === 'APPEND');
        const record: ProvenanceRecord = {
          version: 1,
          type: isAppendOnly ? 'append' : 'update',
          file: { path: currentMarkdownFile.path, name: fileName },
          createdAt: new Date().toISOString(),
          updatedBy: { userId, name: updatedByName },
          source: {
            channelId: fileUpdates[0].originalChannelId,
            threadTs: fileUpdates[0].originalThreadTs,
          },
          knowledge: Array.from(
            new Set(fileUpdates.map((u) => u.knowledgeContent).filter((k): k is string => !!k)),
          ).join('\n\n'),
          messages: allMessages.map((m) => ({
            userId: m.user,
            username: m.user ? nameById.get(m.user) : undefined,
            text: m.text,
            ts: m.ts,
          })),
          diff: {
            before: originalFileContent,
            after: updatedMarkdownForGithub,
            sections: Array.from(new Set(fileUpdates.map((u) => u.headingPath).filter((s): s is string => !!s))),
            nodeIds: fileUpdates.map((u) => u.nodeId).filter((id): id is string => !!id),
          },
        };
        const contextFile = await buildContextFile({ workspaceId, docPath: currentMarkdownFile.path, record });
        updateResult = await githubService.commitFilesWithContext({
          owner,
          repo,
          branch,
          message: commitMessage,
          files: [{ path: currentMarkdownFile.path, content: updatedMarkdownForGithub }, contextFile],
          workspaceId,
          userId,
        });
        await persistContextToMirror(workspaceId, contextFile);
      } else {
        updateResult = await githubService.updateMarkdownFile({
          owner,
          repo,
          path: currentMarkdownFile.path,
          content: updatedMarkdownForGithub,
          message: commitMessage,
          branch,
          workspaceId,
          userId,
        });
      }

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

        // Marked [choir-auto], so the webhook skips this commit and the
        // full-sync replica hook never sees it. Publish the replica here.
        schedulePublish({
          workspaceId,
          githubPath: currentMarkdownFile.path,
          markdown: updatedMarkdownForGithub,
          reason: 'slack-document-update',
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
  for (const { fileName, commitSha } of successfulUpdates) {
    results.push({
      fileName,
      success: true,
      message: `✅ Successfully updated ${fileName} on GitHub and attempted vector store sync.`,
      commitSha,
    });
  }
  for (const fileName of failedUpdates) {
    results.push({
      fileName,
      success: false,
      message: `❌ Failed to update ${fileName}. Check logs for details.`,
    });
  }

  return results;
}
