import { Octokit } from "octokit";
import * as dotenv from "dotenv";
import { DocumentTree, DocumentUpdate, parseMarkdownToTree, updateDocTreeWithChanges, updateNodeContent } from "services/document";
import { WebClient } from "@slack/web-api";
import { VectorStoreService } from "services/vector/main-service";
import { convertUserIdsToNames, parseGithubUrl, replaceMentionsInText, SlackMessage } from "services/slack";


dotenv.config();

export interface GithubFileContent {
  name: string;
  path: string;
  sha: string;
  size: number;
  url: string;
  html_url: string;
  git_url: string;
  download_url: string;
  type: string;
  _links: {
    self: string;
    git: string;
    html: string;
  };
}

export interface MarkdownFile {
  name: string;
  path: string;
  content: string;
  githubUrl: string;
  tree: DocumentTree;
}

export interface GithubCommit {
  author: string;
  message: string;
  description: string;
  date: string;
  commitInfo?: CommitInfo; // 파싱된 JSON 데이터 저장
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

class GithubService {
  private static instance: GithubService;
  private octokit: Octokit;

  private constructor() {
    this.octokit = new Octokit({
      auth: process.env.GITHUB_TOKEN,
    });
  }

  public static getInstance(): GithubService {
    if (!GithubService.instance) {
      GithubService.instance = new GithubService();
    }
    return GithubService.instance;
  }

  async getAllMarkdownFiles({
    owner,
    repo,
    path,
    ref = "master",
  }: {
    owner: string;
    repo: string;
    path: string;
    ref?: string;
  }): Promise<MarkdownFile[]> {
    try {
      // 모든 마크다운 파일을 저장할 배열
      const allMarkdownFiles: MarkdownFile[] = [];

      // 재귀적으로 디렉토리 탐색하는 내부 함수
      const exploreDirectory = async (dirPath: string): Promise<void> => {
        try {
          const { data: contents } = await this.octokit.rest.repos.getContent({
            owner,
            repo,
            path: dirPath,
            ref,
          });

          if (!Array.isArray(contents)) {
            console.log(`${dirPath}는 디렉토리가 아닙니다.`);
            return;
          }

          // 현재 디렉토리의 모든 항목을 처리
          for (const item of contents) {
            if (item.type === "dir") {
              // 폴더인 경우 재귀적으로 탐색
              await exploreDirectory(item.path);
            } else if (item.type === "file" && item.name.endsWith(".md")) {
              // 마크다운 파일인 경우 내용 가져오기
              try {
                const { data: fileData } =
                  await this.octokit.rest.repos.getContent({
                    owner,
                    repo,
                    path: item.path,
                    ref,
                  });

                if (Array.isArray(fileData) || !("content" in fileData)) {
                  console.warn(`${item.path}의 내용을 가져올 수 없습니다.`);
                  continue;
                }

                const content = Buffer.from(
                  fileData.content,
                  "base64"
                ).toString("utf-8");
                const tree = parseMarkdownToTree(content, item.name);

                allMarkdownFiles.push({
                  name: item.name,
                  path: item.path,
                  content,
                  githubUrl: item.html_url,
                  tree,
                });

                console.log(`마크다운 파일 로드: ${item.path}`);
              } catch (fileError) {
                console.error(`${item.path} 파일 로드 중 오류:`, fileError);
              }
            }
          }
        } catch (dirError) {
          console.error(`${dirPath} 디렉토리 탐색 중 오류:`, dirError);
        }
      };

      // 초기 경로부터 시작하여 재귀적으로 모든 디렉토리 탐색
      await exploreDirectory(path);

      console.log(
        `총 ${allMarkdownFiles.length}개의 마크다운 파일을 로드했습니다.`
      );
      return allMarkdownFiles;
    } catch (error) {
      console.error("마크다운 파일 로드 중 오류 발생:", error);
      throw error;
    }
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
      // 1. 현재 파일 내용 가져오기
      const { data: currentFile } = await this.octokit.rest.repos.getContent({
        owner,
        repo,
        path,
      });

      if (Array.isArray(currentFile) || !("content" in currentFile)) {
        throw new Error("Invalid file data");
      }

      const currentContent = Buffer.from(
        currentFile.content,
        "base64"
      ).toString();

      // 2. 변경될 라인들 찾기
      const currentLines = currentContent.split("\n");
      const newLines = newContent.split("\n");
      const changedLineNumbers = new Set<number>();

      for (let i = 0; i < Math.max(currentLines.length, newLines.length); i++) {
        if (currentLines[i] !== newLines[i]) {
          changedLineNumbers.add(i + 1); // GitHub의 라인 번호는 1부터 시작
        }
      }

      // 3. 해당 라인들의 커밋 히스토리 가져오기
      const { data: commits } = await this.octokit.rest.repos.listCommits({
        owner,
        repo,
        path,
      });

      // 4. 각 커밋에 대해 변경된 라인과 관련된 것만 필터링
      const relevantCommits = await Promise.all(
        commits.map(
          async (commit: {
            sha: string;
            commit: {
              author?: { name?: string; date?: string };
              message: string;
            };
          }) => {
            const { data: commitData } =
              await this.octokit.rest.repos.getCommit({
                owner,
                repo,
                ref: commit.sha,
              });

            // 이 커밋에서 해당 파일의 변경사항 찾기
            const fileChange = commitData.files?.find(
              (file: { filename: string; patch?: string }) =>
                file.filename === path
            );
            if (!fileChange) return null;

            // 변경된 라인 번호들 추출 - 개선된 패치 파싱 로직
            const commitChangedLines = new Set<number>();
            const patch = fileChange.patch ?? "";
            const patchLines = patch.split("\n");

            let targetLineNumber = 0; // 대상 파일(새 파일)의 현재 라인 번호

            for (let i = 0; i < patchLines.length; i++) {
              const line = patchLines[i];

              // 헝크(hunk) 헤더 파싱 (예: @@ -1,7 +1,9 @@)
              if (line.startsWith("@@")) {
                const match = line.match(/@@ -\d+,\d+ \+(\d+),\d+ @@/);
                if (match && match[1]) {
                  targetLineNumber = parseInt(match[1], 10) - 1; // 헝크 시작 라인 (1부터 시작하므로 0 기반으로 조정)
                }
                continue;
              }

              // 라인 종류에 따라 처리
              if (line.startsWith(" ")) {
                // 컨텍스트 라인 (변경 없음)
                targetLineNumber++;
              } else if (line.startsWith("+")) {
                // 추가된 라인
                targetLineNumber++;
                commitChangedLines.add(targetLineNumber);
              } else if (line.startsWith("-")) {
                // 삭제된 라인 - 대상 파일 라인 번호는 증가하지 않음
                // 이전 버전의 라인이므로 무시
              }
            }

            // 현재 변경사항과 관련된 라인이 있는지 확인
            const hasRelevantChanges = Array.from(changedLineNumbers).some(
              (line) => commitChangedLines.has(line)
            );

            if (!hasRelevantChanges) return null;

            // JSON 형태의 커밋 메시지 파싱
            let message = "";
            let description = "";
            let commitInfo: CommitInfo | null = null;

            try {
              // 커밋 메시지가 JSON 형태인지 확인
              const commitMessage = commit.commit.message;
              if (
                commitMessage.startsWith("{") &&
                commitMessage.endsWith("}")
              ) {
                commitInfo = JSON.parse(commitMessage);

                if (!commitInfo) {
                  throw new Error("Invalid commit message");
                }

                // 메시지 구성
                message = `문서 업데이트: ${commitInfo.fileName}`;

                description = commitInfo.toString();
              } else {
                // 일반 텍스트 커밋 메시지인 경우
                const messageLines = commitMessage.split("\n");
                message = messageLines[0];
                description = messageLines.slice(1).join("\n").trim();
              }
            } catch (error) {
              // JSON 파싱 실패 시 기본 메시지 사용
              const messageLines = commit.commit.message.split("\n");
              message = messageLines[0];
              description = messageLines.slice(1).join("\n").trim();
            }

            return {
              author: commit.commit.author?.name ?? "Unknown",
              message: message,
              description: description,
              date: commit.commit.author?.date ?? "",
              commitInfo,
            };
          }
        )
      );

      // null 값 필터링 및 limit 적용
      const filteredCommits = relevantCommits.filter(
        (commit: GithubCommit | null): commit is NonNullable<typeof commit> =>
          commit !== null
      );

      // limit이 지정된 경우 최신 몇 개까지만 반환
      if (limit && limit > 0) {
        return filteredCommits.slice(0, limit);
      }

      return filteredCommits;
    } catch (error) {
      console.error("Failed to get commit history:", error);
      throw error;
    }
  }

  async updateMarkdownFile({
    owner,
    repo,
    path,
    content,
    message = "Update markdown content",
  }: {
    owner: string;
    repo: string;
    path: string;
    content: string;
    message?: string;
  }): Promise<void> {
    try {
      // 현재 파일의 SHA 가져오기
      const { data: currentFile } = await this.octokit.rest.repos.getContent({
        owner,
        repo,
        path,
      });

      if (Array.isArray(currentFile) || !("sha" in currentFile)) {
        throw new Error("Invalid file data");
      }

      // 파일 업데이트
      await this.octokit.rest.repos.createOrUpdateFileContents({
        owner,
        repo,
        path,
        message,
        content: Buffer.from(content).toString("base64"),
        sha: currentFile.sha,
      });
    } catch (error) {
      console.error("Failed to update file:", error);
      throw error;
    }
  }

  /**
   * GitHub 저장소에 접근 가능한지 확인합니다.
   * @param owner 저장소 소유자
   * @param repo 저장소 이름
   * @returns 접근 가능 여부와 결과 메시지
   */
  async testConnection({
    owner,
    repo,
  }: {
    owner: string;
    repo: string;
  }): Promise<{ success: boolean; message: string }> {
    try {
      // 저장소 기본 정보 가져오기 시도
      const { data } = await this.octokit.rest.repos.get({
        owner,
        repo,
      });

      return {
        success: true,
        message: `저장소 연결 성공: ${data.full_name} (${
          data.description || "설명 없음"
        })`,
      };
    } catch (error: unknown) {
      console.error("GitHub 연결 테스트 실패:", error);

      // 타입 정의
      interface ErrorWithStatus {
        status?: number;
        message?: string;
      }

      const err = error as ErrorWithStatus;

      // 오류 상태 코드에 따른 메시지
      if (err.status === 404) {
        return {
          success: false,
          message: `저장소를 찾을 수 없습니다: ${owner}/${repo}. 저장소 이름이 정확한지 확인하세요.`,
        };
      } else if (err.status === 401 || err.status === 403) {
        return {
          success: false,
          message: "인증 실패: GitHub 토큰이 유효하지 않거나 권한이 없습니다.",
        };
      } else {
        return {
          success: false,
          message: `GitHub 연결 실패: ${err.message || "알 수 없는 오류"}`,
        };
      }
    }
  }

  /**
   * 특정 마크다운 파일 한 개만 가져옵니다.
   */
  async getMarkdownFile({
    owner,
    repo,
    path,
    ref = "master",
  }: {
    owner: string;
    repo: string;
    path: string;
    ref?: string;
  }): Promise<MarkdownFile | null> {
    try {
      console.log(`마크다운 파일 로드 중: ${path} (${owner}/${repo})`);

      // 파일 내용 가져오기
      const { data: fileData } = await this.octokit.rest.repos.getContent({
        owner,
        repo,
        path,
        ref,
      });

      if (Array.isArray(fileData) || !("content" in fileData)) {
        console.warn(`${path}의 내용을 가져올 수 없습니다.`);
        return null;
      }

      const content = Buffer.from(fileData.content, "base64").toString("utf-8");
      const tree = parseMarkdownToTree(content, path.split("/").pop() || "");

      const markdownFile: MarkdownFile = {
        name: fileData.name,
        path: fileData.path,
        content,
        githubUrl: fileData.html_url,
        tree,
      };

      console.log(
        `마크다운 파일 로드 완료: ${path} (${content.length} 바이트)`
      );
      return markdownFile;
    } catch (error) {
      console.error(`${path} 파일 로드 중 오류:`, error);
      return null;
    }
  }
}

/**
 * Slack 메시지들을 처리하여 구조화된 커밋 메시지를 생성합니다.
 */
async function createCommitMessage(
  fileName: string,
  userId: string,
  nodeId: string,
  knowledgeContent: string,
  sourceMessages: SlackMessage[],
  client: WebClient
): Promise<string> {
  // 유저 정보 가져오기
  let updatedByUserName = "Unknown User";
  try {
    const userInfo = await client.users.info({ user: userId });
    updatedByUserName = userInfo.user?.real_name || userInfo.user?.name || "Unknown User";
  } catch (error) {
    console.error("Failed to get user info for commit message:", error);
  }

  // 유저 ID를 유저 이름으로 변환
  const messagesWithUsernames = await convertUserIdsToNames(
    sourceMessages,
    client
  );

  // 멘션을 유저 이름으로 치환
  const messagesWithReplacedMentions = await Promise.all(
    messagesWithUsernames.map(async (message) => {
      const replacedText = await replaceMentionsInText(message.text, client);
      return {
        ...message,
        text: replacedText,
      } as SlackMessage;
    })
  );

  // 커밋 메시지 생성
  const commitMessageJson = {
    fileName,
    updateType: "document_update",
    knowledge: knowledgeContent,
    timestamp: new Date().toISOString(),
    updatedBy: updatedByUserName,
    nodeId: nodeId,
    messages: messagesWithReplacedMentions,
  };

  return JSON.stringify(commitMessageJson);
}

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
      const appendOperations = fileUpdates.filter(update => update.suggestionType === "APPEND");
      const updateOperations = fileUpdates.filter(update => update.suggestionType !== "APPEND");

      // 1. APPEND 작업 먼저 처리 (벡터 스토어 내의 트리 업데이트)
      if (appendOperations.length > 0) {
        for (const appendUpdate of appendOperations) {
          if (appendUpdate.appendedNodeContent) {
            const success = await vectorStore.appendSpecificNode(
              fileName,
              appendUpdate.nodeId,
              appendUpdate.appendedNodeContent
            );
            if (!success) {
              throw new Error(`Failed to append node ${appendUpdate.nodeId} in ${fileName}`);
            }
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
      const { treeToMarkdown } = await import("services/document/markdown");

      if (updateOperations.length > 0) {
        // UPDATE 작업이 있으면, (APPEND가 이미 적용된) 현재 트리에 UPDATE를 적용
        updatedMarkdownForGithub = updateDocTreeWithChanges(currentMarkdownFile.tree, updateOperations);
      } else {
        // APPEND만 있었던 경우, (APPEND가 이미 적용된) 현재 트리를 마크다운으로 변환
        console.log(`[DEBUG] APPEND 후 트리 상태 (UPDATE 없음):`);
        console.log(`- 노드 맵 크기: ${currentMarkdownFile.tree.nodeMap.size}`);
        console.log(`- 새로 추가된 노드들:`, Array.from(currentMarkdownFile.tree.nodeMap.keys()).filter(id => id.includes('_append_')));
        
        updatedMarkdownForGithub = treeToMarkdown(currentMarkdownFile.tree);
        
        console.log(`[DEBUG] 변환된 마크다운 길이 (UPDATE 없음): ${updatedMarkdownForGithub.length}`);
        console.log(`[DEBUG] 마크다운 미리보기 (마지막 200자, UPDATE 없음):`);
        console.log(updatedMarkdownForGithub.slice(-200));
      }

      const allMessages = fileUpdates.flatMap(update => update.messages || []);
      const commitMessage = await createCommitMessage(
        fileName,
        userId,
        fileUpdates[0].nodeId, // 커밋 메시지용 대표 nodeId는 그대로 첫 번째 요소 사용
        fileUpdates[0].knowledgeContent || fileUpdates[0].updatedNodeContent || fileUpdates[0].appendedNodeContent || "Updated content",
        allMessages,
        client
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
        path: currentMarkdownFile.path, // 최신 파일 경로 사용
        content: updatedMarkdownForGithub,
        message: commitMessage,
      });

      console.log(`Successfully updated ${fileName} on GitHub.`);

      // 4. GitHub 업데이트 성공 후, 최종적으로 벡터 스토어의 문서 내용 및 임베딩 업데이트 (UPDATE 작업에 대해서만)
      // APPEND는 이미 vectorStore.appendSpecificNode에서 처리됨
      if (updateOperations.length > 0) {
        try {
          const vectorUpdateSuccess = await vectorStore.updateSpecificNodes(fileName, updateOperations);
          if (vectorUpdateSuccess) {
            console.log(`Successfully updated vector store for ${fileName} (UPDATE operations).`);
          } else {
            console.warn(`Failed to update vector store for ${fileName} (UPDATE operations), but GitHub update was successful.`);
          }
        } catch (vectorError) {
          console.error(`Error updating vector store for ${fileName} (UPDATE operations) after GitHub success:`, vectorError);
        }
      }

      successfulUpdates.push(fileName);
    } catch (error) {
      failedUpdates.push(fileName);
      console.error(`Error processing updates for ${fileName}:`, error);
    }
  }

  const results: { fileName: string; success: boolean; message: string }[] = [];
  successfulUpdates.forEach(fileName => {
    results.push({
      fileName,
      success: true,
      message: `✅ Successfully updated ${fileName} on GitHub and attempted vector store sync.`,
    });
  });
  failedUpdates.forEach(fileName => {
    results.push({
      fileName,
      success: false,
      message: `❌ Failed to update ${fileName}. Check logs for details.`,
    });
  });

  return results;
}

export default GithubService;
