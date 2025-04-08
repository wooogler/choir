import { Octokit } from "octokit";
import * as dotenv from "dotenv";
import {
  parseMarkdownToTree,
  treeToMarkdown,
  updateNodeContent,
  updateDocTreeWithChanges,
  type DocumentTree,
} from "./markdown";
import { WebClient } from "@slack/web-api";
import {
  convertUserIdsToNames,
  replaceMentionsInText,
  SlackMessage,
} from "./slack-utils";
import { parseGithubUrl } from "./slack-utils";
import { DocumentUpdate } from "./document-store";
import { VectorStoreService } from "./vector/main-service";

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
    ref = "main",
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
                const tree = parseMarkdownToTree(content);

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
              commitInfo: commitInfo,
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
    ref = "main",
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
      const tree = parseMarkdownToTree(content);

      const markdownFile: MarkdownFile = {
        name: fileData.name,
        path: fileData.path,
        content: content,
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

// GitHub에 선택된 문서 업데이트 적용
export async function applySelectedToGithub({
  userId,
  channelId,
  client,
  selectedNodeIds,
  documentUpdates,
  vectorStore,
  validMessages,
}: {
  userId: string;
  channelId: string;
  client: WebClient;
  selectedNodeIds: string[];
  documentUpdates: DocumentUpdate[];
  vectorStore: VectorStoreService;
  validMessages: SlackMessage[];
}): Promise<{ fileName: string; success: boolean; message: string }[]> {
  // 결과 저장 배열
  const results: { fileName: string; success: boolean; message: string }[] = [];

  // 파일별로 그룹화된 노드 ID
  const nodesByFile = new Map<
    string,
    {
      nodeIds: string[];
      githubUrl: string;
      fileName: string;
      documentUpdates: any[];
    }
  >();

  // document update 데이터에서 선택된 노드 정보 찾기
  for (const nodeId of selectedNodeIds) {
    // documentUpdates에서 해당 노드 ID에 대한 업데이트 찾기
    const update = documentUpdates.find((update) => update.nodeId === nodeId);

    if (update) {
      const fileName = update.fileName;
      const githubUrl = update.githubUrl;

      // 파일별 그룹에 노드 ID 추가
      if (!nodesByFile.has(fileName)) {
        nodesByFile.set(fileName, {
          nodeIds: [],
          githubUrl,
          fileName,
          documentUpdates: [],
        });
      }

      nodesByFile.get(fileName)!.nodeIds.push(nodeId);
      nodesByFile.get(fileName)!.documentUpdates.push(update);
    } else {
      console.log(`노드 ID ${nodeId}에 대한 업데이트 정보를 찾을 수 없습니다.`);
    }
  }

  // GitHub 서비스 인스턴스 생성
  const githubService = GithubService.getInstance();

  // 파일별로 업데이트 실행
  for (const [fileName, fileData] of nodesByFile.entries()) {
    console.log(
      `'${fileName}' 파일의 ${fileData.nodeIds.length}개 노드 업데이트 중...`
    );

    // 마크다운 파일 가져오기
    const markdownFile = vectorStore.getMarkdownFile(fileName);
    if (!markdownFile) {
      console.error(`파일을 찾을 수 없습니다: ${fileName}`);
      results.push({
        fileName,
        success: false,
        message: `❌ ${fileName} 파일 업데이트 실패: 파일을 찾을 수 없습니다.`,
      });
      continue;
    }

    let docTree = markdownFile.tree;
    let modified = false;

    // GitHub URL에서 owner와 repo 추출
    const githubInfo = parseGithubUrl(fileData.githubUrl);
    if (!githubInfo) {
      console.error(`유효한 GitHub URL이 아닙니다: ${fileData.githubUrl}`);
      results.push({
        fileName,
        success: false,
        message: `❌ ${fileName} 파일 업데이트 실패: 유효한 GitHub URL이 아닙니다.`,
      });
      continue;
    }

    // 선택된 모든 노드에 대해 업데이트 적용
    for (const update of fileData.documentUpdates) {
      const nodeId = update.nodeId;
      const updatedNodeContent = update.updatedNodeContent;

      // 노드 콘텐츠 업데이트
      docTree = updateNodeContent(docTree, nodeId, updatedNodeContent);
    }

    // 업데이트된 마크다운 생성
    const updatedMarkdown = updateDocTreeWithChanges(
      docTree,
      fileData.documentUpdates
    );

    // 유저 ID를 유저 이름으로 변환
    const messagesWithUsernames = await convertUserIdsToNames(
      validMessages,
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
      nodeIds: fileData.nodeIds,
      messages: messagesWithReplacedMentions,
    };

    try {
      // 실제 GitHub 업데이트 수행
      const result = await githubService.updateMarkdownFile({
        owner: githubInfo.owner,
        repo: githubInfo.repo,
        path: fileName,
        content: updatedMarkdown,
        message: JSON.stringify(commitMessageJson),
      });

      console.log(`✅ ${fileName} 파일이 성공적으로 업데이트되었습니다!`);
      results.push({
        fileName,
        success: true,
        message: `✅ ${fileName} 파일이 성공적으로 업데이트되었습니다!`,
      });
    } catch (error) {
      console.error(`${fileName} 파일 업데이트 중 오류 발생:`, error);
      results.push({
        fileName,
        success: false,
        message: `❌ ${fileName} 파일 업데이트 실패: ${
          error instanceof Error ? error.message : "알 수 없는 오류"
        }`,
      });
    }
  }

  return results;
}

export default GithubService;
