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
      const { data: contents } = await this.octokit.rest.repos.getContent({
        owner,
        repo,
        path,
        ref,
      });

      if (!Array.isArray(contents)) {
        throw new Error("Path is not a directory");
      }

      const markdownFiles: GithubFileContent[] = contents.filter((file) =>
        file.name.endsWith(".md")
      );

      const markdownContents: MarkdownFile[] = await Promise.all(
        markdownFiles.map(async (file): Promise<MarkdownFile> => {
          const { data: fileData } = await this.octokit.rest.repos.getContent({
            owner,
            repo,
            path: file.path,
            ref,
          });

          if (Array.isArray(fileData) || !("content" in fileData)) {
            throw new Error(`${file.path}의 내용을 가져올 수 없습니다.`);
          }

          const content = Buffer.from(fileData.content, "base64").toString(
            "utf-8"
          );

          const tree = parseMarkdownToTree(content);

          return {
            name: file.name,
            path: file.path,
            content,
            githubUrl: file.html_url,
            tree,
          };
        })
      );

      return markdownContents;
    } catch (error) {
      console.error(error);
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
}

export default GithubService;
