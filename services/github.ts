import { Octokit } from "octokit";
import * as dotenv from "dotenv";
import { parseMarkdownToTree, type MarkdownTree } from "./markdown";

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
  tree: MarkdownTree;
}

export interface GithubCommit {
  author: string;
  message: string;
  description: string;
  date: string;
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
  }: {
    owner: string;
    repo: string;
    path: string;
    newContent: string;
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

            // 변경된 라인 번호들 추출
            const commitChangedLines = new Set<number>();
            const patch = fileChange.patch ?? "";
            const patchLines = patch.split("\n");
            let currentLine = 0;

            for (const line of patchLines) {
              if (line.startsWith("+") || line.startsWith("-")) {
                currentLine++;
                commitChangedLines.add(currentLine);
              }
            }

            // 현재 변경사항과 관련된 라인이 있는지 확인
            const hasRelevantChanges = Array.from(changedLineNumbers).some(
              (line) => commitChangedLines.has(line)
            );

            if (!hasRelevantChanges) return null;

            return {
              author: commit.commit.author?.name ?? "Unknown",
              subject: commit.commit.message.split("\n")[0], // 첫 줄은 subject
              body: commit.commit.message
                .split("\n")
                .slice(1)
                .join("\n")
                .trim(), // 나머지는 body
              date: commit.commit.author?.date ?? "",
            };
          }
        )
      );

      return relevantCommits.filter(
        (
          commit: {
            author: string;
            message: string;
            description: string;
            date: string;
          } | null
        ): commit is NonNullable<typeof commit> => commit !== null
      );
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
}

export default GithubService;
