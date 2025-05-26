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
  nodeIds: string[],
  allMessages: SlackMessage[],
  client: WebClient
): Promise<string> {
  // 유저 ID를 유저 이름으로 변환
  const messagesWithUsernames = await convertUserIdsToNames(
    allMessages,
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
    source: "choir_app",
    timestamp: new Date().toISOString(),
    updatedBy: userId,
    nodeIds,
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

  // 파일별로 업데이트 그룹화
  const updatesByFile = new Map<string, DocumentUpdate[]>();
  
  for (const update of documentUpdates) {
    if (!updatesByFile.has(update.fileName)) {
      updatesByFile.set(update.fileName, []);
    }
    updatesByFile.get(update.fileName)!.push(update);
  }

  // GitHub 서비스 인스턴스 가져오기
  const githubService = GithubService.getInstance();
  const vectorStore = VectorStoreService.getInstance();

  // 각 파일별로 업데이트 처리
  for (const [fileName, fileUpdates] of updatesByFile.entries()) {
    try {
      // VectorStoreService에서 원본 파일 가져오기
      const markdownFile = vectorStore.getMarkdownFile(fileName);
      
      if (!markdownFile) {
        throw new Error(`파일을 찾을 수 없습니다: ${fileName}`);
      }

      // 문서 트리에 변경사항 적용하여 전체 마크다운 생성
      const updatedMarkdown = updateDocTreeWithChanges(markdownFile.tree, fileUpdates);

      // Slack 메시지들을 commit message에 포함
      const allMessages = fileUpdates.flatMap(update => update.messages || []);
      
      // 구조화된 커밋 메시지 생성 (유저명 변환 및 멘션 처리 포함)
      const commitMessage = await createCommitMessage(
        fileName,
        userId,
        fileUpdates.map(update => update.nodeId),
        allMessages,
        client
      );

      // GitHub URL에서 owner와 repo 추출
      const githubUrl = fileUpdates[0].githubUrl;
      const [owner, repo] = githubUrl
        .replace("https://github.com/", "")
        .split("/");

      // 전체 파일 업데이트
      await githubService.updateMarkdownFile({
        owner,
        repo,
        path: fileName,
        content: updatedMarkdown,
        message: commitMessage,
      });

      successfulUpdates.push(fileName);
      console.log(`Successfully updated ${fileName} with ${fileUpdates.length} changes`);
    } catch (error) {
      failedUpdates.push(fileName);
      console.error(`Error updating ${fileName}:`, error);
    }
  }

  // 결과 반환
  const results: { fileName: string; success: boolean; message: string }[] = [];
  
  successfulUpdates.forEach(fileName => {
    results.push({
      fileName,
      success: true,
      message: `✅ Successfully updated ${fileName}`,
    });
  });

  failedUpdates.forEach(fileName => {
    results.push({
      fileName,
      success: false,
      message: `❌ Failed to update ${fileName}`,
    });
  });

  return results;
}

export default GithubService;
