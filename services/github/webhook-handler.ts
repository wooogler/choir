import * as crypto from 'crypto';
import type { WebClient } from '@slack/web-api';
import { getGithubRepo, getWorkspaceId } from 'services/slack';
import { WorkspaceStore } from 'services/workspace/workspace-store';
import { CHOIRMessageType, createCHOIRBlockId } from 'types/message-types';

/**
 * GitHub webhook 서명을 검증하는 함수
 */
export function verifyGitHubSignature(payload: string, signature: string, secret: string): boolean {
  if (!signature || !secret) {
    return false;
  }

  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(payload, 'utf8')
    .digest('hex');

  const expectedSignatureWithPrefix = `sha256=${expectedSignature}`;

  // timing attack을 방지하기 위해 crypto.timingSafeEqual 사용
  return crypto.timingSafeEqual(
    Buffer.from(signature, 'utf8'),
    Buffer.from(expectedSignatureWithPrefix, 'utf8')
  );
}

/**
 * 현재 워크스페이스가 해당 저장소와 매칭되는지 확인
 */
export async function isRepoMatchingWorkspace(owner: string, repo: string, client: WebClient): Promise<boolean> {
  try {
    const workspaceId = await getWorkspaceId(client);
    const repoInfo = await getGithubRepo(workspaceId);
    
    return repoInfo?.owner === owner && repoInfo?.repo === repo;
  } catch (error) {
    console.error('Error checking repo matching:', error);
    return false;
  }
}

/**
 * GitHub push 이벤트를 처리하는 함수
 */
export async function handleGitHubPushEvent(
  payload: any,
  client: WebClient,
  logger: any
): Promise<void> {
  try {
    const { repository, ref, commits } = payload;
    const owner = repository.owner.name || repository.owner.login;
    const repo = repository.name;
    const branch = ref.replace('refs/heads/', '');

    logger.info(`GitHub push event received: ${owner}/${repo} on branch ${branch}`);
    logger.info(`Commits: ${commits?.length || 0}`);

    // 현재 워크스페이스가 해당 저장소를 사용하는지 확인
    const isMatching = await isRepoMatchingWorkspace(owner, repo, client);
    
    if (!isMatching) {
      logger.info(`Repository ${owner}/${repo} does not match current workspace`);
      return;
    }

    logger.info(`Repository ${owner}/${repo} matches current workspace, performing auto-reload`);

    // 자동 reload 수행
    await performAutoReloadForWorkspace(owner, repo, branch, client, logger);
  } catch (error) {
    logger.error('Error handling GitHub push event:', error);
  }
}

/**
 * 현재 워크스페이스에 대해 자동 reload 수행
 */
async function performAutoReloadForWorkspace(
  owner: string,
  repo: string,
  branch: string,
  client: WebClient,
  logger: any
): Promise<void> {
  try {
    const workspaceId = await getWorkspaceId(client);
    const repoInfo = await getGithubRepo(workspaceId);
    
    if (!repoInfo) {
      logger.warn('No GitHub repository configured for current workspace');
      return;
    }

    // 브랜치가 다르면 스킵 (기본 브랜치만 처리)
    const configBranch = repoInfo.branch || 'main';
    if (branch !== configBranch) {
      logger.info(`Skipping auto-reload: branch ${branch} != ${configBranch}`);
      return;
    }

    logger.info('Performing auto-reload for current workspace');

    // 워크스페이스의 관리자들 가져오기
    const workspaceStore = new WorkspaceStore();
    const workspaceConfig = await workspaceStore.getWorkspaceConfig(workspaceId);
    const managers = workspaceConfig?.managers || [];
    
    if (managers.length === 0) {
      logger.warn('No managers found for current workspace');
      return;
    }

    // 첫 번째 관리자를 대신해서 reload 수행
    const firstManager = managers[0];
    
    // reloadFromGithubAction과 유사한 로직으로 자동 reload
    const mockBody = {
      user: { id: firstManager },
      // reloadFromGithubAction에서 필요한 다른 속성들
    };

    // 진행 상황 메시지 전송
    const progressMessage = await client.chat.postMessage({
      channel: firstManager,
      text: `🔄 Reflecting your document changes...`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `🔄 *Reflecting your document changes...*\n\nDetected updates in your documents. Please wait while we sync the changes.`,
          },
          block_id: createCHOIRBlockId(CHOIRMessageType.STATUS_UPDATE),
        },
      ],
    });

    // VectorStoreService를 직접 사용해서 reload 수행
    const { VectorStoreService } = await import('services/vector/main-service');
    const { GithubService } = await import('services/github');
    
    const githubService = GithubService.getInstance();
    const vectorStore = VectorStoreService.getInstance();

    // GitHub에서 최신 파일들 가져오기
    const markdownFiles = await githubService.getAllMarkdownFiles({
      owner,
      repo,
      path: repoInfo.path || '',
      ref: branch,
      workspaceId,
      userId: firstManager,
    });

    if (markdownFiles.length === 0) {
      await client.chat.update({
        channel: firstManager,
        ts: progressMessage.ts!,
        text: '❌ Unable to reflect changes: No documents found.',
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `❌ *Unable to reflect changes*\n\nNo documents found in the repository.\n\n<https://github.com/${owner}/${repo}|View Repository>`,
            },
            block_id: createCHOIRBlockId(CHOIRMessageType.RESPONSE),
          },
        ],
      });
      return;
    }

    // 벡터 저장소 업데이트
    const success = await vectorStore.initialize(markdownFiles, false, true, workspaceId);

    if (success) {
      // 캐시 업데이트
      const fileList = markdownFiles.map((file) => ({
        name: file.name,
        path: file.path,
      }));
      await workspaceStore.setMarkdownFilesCache(workspaceId, fileList);

      // 진행 메시지를 성공 메시지로 업데이트
      await client.chat.update({
        channel: firstManager,
        ts: progressMessage.ts!,
        text: `✅ Document changes reflected successfully!`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `✅ *Document changes reflected successfully!*\n\nUpdated ${markdownFiles.length} files. Your knowledge base is now up to date!\n\n<https://github.com/${owner}/${repo}|View Repository>`,
            },
            block_id: createCHOIRBlockId(CHOIRMessageType.SUCCESS),
          },
        ],
      });

      logger.info(`Auto-reload completed: ${markdownFiles.length} files`);
    } else {
      await client.chat.update({
        channel: firstManager,
        ts: progressMessage.ts!,
        text: '❌ Unable to reflect changes: Processing failed.',
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `❌ *Unable to reflect changes*\n\nProcessing failed. Please try using the "Reload From Github" button in the Home screen or contact the research team.\n\n<https://github.com/${owner}/${repo}|View Repository>`,
            },
            block_id: createCHOIRBlockId(CHOIRMessageType.RESPONSE),
          },
        ],
      });
      logger.error('Auto-reload failed: vector store update failed');
    }
  } catch (error) {
    logger.error('Error in performAutoReloadForWorkspace:', error);
    
    // 오류 알림
    try {
      const workspaceId = await getWorkspaceId(client);
      const workspaceStore = new WorkspaceStore();
      const workspaceConfig = await workspaceStore.getWorkspaceConfig(workspaceId);
      const managers = workspaceConfig?.managers || [];
      
      if (managers.length > 0) {
        await client.chat.postMessage({
          channel: managers[0],
          text: `❌ Unable to reflect document changes: System error occurred.`,
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `❌ *Unable to reflect document changes*\n\nA system error occurred while processing updates. Please try using the "Reload From Github" button in the Home screen or contact the research team.\n\n<https://github.com/${owner}/${repo}|View Repository>`,
              },
              block_id: createCHOIRBlockId(CHOIRMessageType.RESPONSE),
            },
          ],
        });
      }
    } catch (notificationError) {
      logger.error('Failed to send error notification:', notificationError);
    }
  }
}