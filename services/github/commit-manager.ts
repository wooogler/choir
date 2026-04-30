import type { WebClient } from '@slack/web-api';
import { Octokit } from 'octokit';
import { ErrorCodes, GitHubError } from 'services/common/error-handler';
import { Logger } from 'services/common/logger';
import type { SlackMessage } from 'services/slack';

export interface GithubCommit {
  author: string;
  message: string;
  description: string;
  date: string;
  commitInfo?: CommitInfo;
}

export interface CommitInfo {
  fileName: string;
  updateType: string;
  source: string;
  timestamp: string;
  updatedBy: string;
  nodeIds: string[];
  messages: CommitMessage[];
}

export interface CommitMessage {
  userId: string;
  username: string;
  text: string;
  ts: string;
}

export class GitHubCommitManager {
  private octokit: Octokit;

  constructor(token?: string) {
    this.octokit = new Octokit({
      auth: token,
    });
  }

  async getHistoryOfMarkdownUpdate({
    owner,
    repo,
    path,
    newContent,
    limit,
  }: {
    owner: string;
    repo: string;
    path: string;
    newContent: string;
    limit?: number;
  }): Promise<GithubCommit[]> {
    try {
      const { data: currentFile } = await this.octokit.rest.repos.getContent({
        owner,
        repo,
        path,
      });

      if (Array.isArray(currentFile) || !('content' in currentFile)) {
        throw new GitHubError('Invalid file data', {
          code: ErrorCodes.GITHUB_FILE_NOT_FOUND,
        });
      }

      const currentContent = Buffer.from(currentFile.content, 'base64').toString();
      const currentLines = currentContent.split('\n');
      const newLines = newContent.split('\n');
      const changedLineNumbers = new Set<number>();

      for (let i = 0; i < Math.max(currentLines.length, newLines.length); i++) {
        if (currentLines[i] !== newLines[i]) {
          changedLineNumbers.add(i + 1);
        }
      }

      const { data: commits } = await this.octokit.rest.repos.listCommits({
        owner,
        repo,
        path,
      });

      const relevantCommits = await Promise.all(
        commits.map(async (commit: any) => {
          const { data: commitData } = await this.octokit.rest.repos.getCommit({
            owner,
            repo,
            ref: commit.sha,
          });

          const fileChange = commitData.files?.find((file: any) => file.filename === path);
          if (!fileChange) return null;

          const commitChangedLines = new Set<number>();
          const patch = fileChange.patch ?? '';
          const patchLines = patch.split('\n');

          let targetLineNumber = 0;

          for (let i = 0; i < patchLines.length; i++) {
            const line = patchLines[i];

            if (line.startsWith('@@')) {
              const match = line.match(/@@ -\d+,\d+ \+(\d+),\d+ @@/);
              if (match?.[1]) {
                targetLineNumber = Number.parseInt(match[1], 10) - 1;
              }
              continue;
            }

            if (line.startsWith(' ')) {
              targetLineNumber++;
            } else if (line.startsWith('+')) {
              targetLineNumber++;
              commitChangedLines.add(targetLineNumber);
            }
          }

          const hasRelevantChanges = Array.from(changedLineNumbers).some((line) => commitChangedLines.has(line));

          if (!hasRelevantChanges) return null;

          let message = '';
          let description = '';
          let commitInfo: CommitInfo | null = null;

          try {
            const commitMessage = (commit as any).commit.message;
            if (commitMessage.startsWith('{') && commitMessage.endsWith('}')) {
              commitInfo = JSON.parse(commitMessage);

              if (!commitInfo) {
                throw new Error('Invalid commit message');
              }

              message = `Document update: ${commitInfo.fileName}`;
              description = commitInfo.toString();
            } else {
              const messageLines = commitMessage.split('\n');
              message = messageLines[0];
              description = messageLines.slice(1).join('\n').trim();
            }
          } catch (error) {
            const messageLines = (commit as any).commit.message.split('\n');
            message = messageLines[0];
            description = messageLines.slice(1).join('\n').trim();
          }

          return {
            author: (commit as any).commit.author?.name ?? 'Unknown',
            message: message,
            description: description,
            date: (commit as any).commit.author?.date ?? '',
            commitInfo,
          };
        }),
      );

      const filteredCommits = relevantCommits.filter(
        (commit: any): commit is NonNullable<typeof commit> => commit !== null,
      );

      if (limit && limit > 0) {
        return filteredCommits.slice(0, limit);
      }

      return filteredCommits;
    } catch (error) {
      Logger.error('Failed to get commit history', error as Error);
      throw new GitHubError('Failed to get commit history', {
        code: ErrorCodes.GITHUB_CONNECTION_FAILED,
        metadata: { owner, repo, path },
      });
    }
  }

  async createCommitMessage(
    fileName: string,
    userId: string,
    _nodeId: string,
    _knowledgeContent: string,
    _sourceMessages: SlackMessage[],
    client: WebClient,
  ): Promise<string> {
    let updatedByUserName = 'Unknown User';
    try {
      const userInfo = await client.users.info({ user: userId });
      updatedByUserName = userInfo.user?.real_name || userInfo.user?.name || 'Unknown User';
    } catch (error) {
      Logger.error('Failed to get user info for commit message', error as Error, { userId });
    }

    // 간단한 커밋 메시지 생성
    return `Update ${fileName} - ${updatedByUserName}`;
  }
}
