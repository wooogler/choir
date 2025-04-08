import { DocumentTree } from "./markdown";
import { VectorStoreService } from "./vector/main-service";
import { WebClient } from "@slack/web-api";
import { SlackMessage, parseGithubUrl } from "./slack-utils";
import GithubService from "./github";
import { DocumentUpdate } from "./document-store";
import {
  updateDocTreeWithChanges,
  updateNodeContent,
  convertMarkdownToSlackText,
} from "./markdown";
import { createDiffBlock } from "./slack-diff";

export interface DocumentChangeResult {
  fileName: string;
  success: boolean;
  message: string;
}

export async function applyDocumentChanges({
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
}): Promise<DocumentChangeResult[]> {
  const nodesByFile = new Map<
    string,
    {
      nodeIds: string[];
      githubUrl: string;
      fileName: string;
      documentUpdates: DocumentUpdate[];
    }
  >();

  // 파일별로 노드 그룹화
  for (const nodeId of selectedNodeIds) {
    const update = documentUpdates.find((update) => update.nodeId === nodeId);
    if (update) {
      const fileName = update.fileName;
      const githubUrl = update.githubUrl;

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
    }
  }

  const results: DocumentChangeResult[] = [];
  const githubService = GithubService.getInstance();

  // 각 파일에 대한 변경사항 적용
  for (const [fileName, fileData] of nodesByFile.entries()) {
    try {
      const markdownFile = vectorStore.getMarkdownFile(fileName);
      if (!markdownFile) {
        results.push({
          fileName,
          success: false,
          message: `파일을 찾을 수 없습니다: ${fileName}`,
        });
        continue;
      }

      let docTree = markdownFile.tree;
      const githubInfo = parseGithubUrl(fileData.githubUrl);
      if (!githubInfo) {
        results.push({
          fileName,
          success: false,
          message: `유효한 GitHub URL이 아닙니다: ${fileData.githubUrl}`,
        });
        continue;
      }

      // 노드 내용 업데이트
      for (const update of fileData.documentUpdates) {
        docTree = updateNodeContent(
          docTree,
          update.nodeId,
          update.updatedNodeContent
        );
      }

      // 마크다운으로 변환
      const updatedMarkdown = updateDocTreeWithChanges(
        docTree,
        fileData.documentUpdates
      );

      // GitHub에 업데이트
      await githubService.updateMarkdownFile({
        owner: githubInfo.owner,
        repo: githubInfo.repo,
        path: fileName,
        content: updatedMarkdown,
      });

      results.push({
        fileName,
        success: true,
        message: `파일이 성공적으로 업데이트되었습니다: ${fileName}`,
      });
    } catch (error) {
      results.push({
        fileName,
        success: false,
        message: `파일 업데이트 중 오류 발생: ${error}`,
      });
    }
  }

  return results;
}

export function groupNodesByFile(
  selectedNodeIds: string[],
  documentUpdates: DocumentUpdate[]
): Map<
  string,
  {
    nodeIds: string[];
    githubUrl: string;
    fileName: string;
    documentUpdates: DocumentUpdate[];
  }
> {
  const nodesByFile = new Map();

  for (const nodeId of selectedNodeIds) {
    const update = documentUpdates.find((update) => update.nodeId === nodeId);
    if (update) {
      const fileName = update.fileName;
      const githubUrl = update.githubUrl;

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
    }
  }

  return nodesByFile;
}

export interface ProcessFileChangesResult {
  success: boolean;
  message: string;
  updatedMarkdown?: string;
  githubInfo?: {
    owner: string;
    repo: string;
  };
}

export async function processFileChanges(
  fileName: string,
  fileData: {
    nodeIds: string[];
    githubUrl: string;
    fileName: string;
    documentUpdates: DocumentUpdate[];
  },
  vectorStore: VectorStoreService
): Promise<ProcessFileChangesResult> {
  try {
    const markdownFile = vectorStore.getMarkdownFile(fileName);
    if (!markdownFile) {
      return {
        success: false,
        message: `파일을 찾을 수 없습니다: ${fileName}`,
      };
    }

    let docTree = markdownFile.tree;
    const githubInfo = parseGithubUrl(fileData.githubUrl);
    if (!githubInfo) {
      return {
        success: false,
        message: `유효한 GitHub URL이 아닙니다: ${fileData.githubUrl}`,
      };
    }

    // 노드 내용 업데이트
    for (const update of fileData.documentUpdates) {
      docTree = updateNodeContent(
        docTree,
        update.nodeId,
        update.updatedNodeContent
      );
    }

    // 마크다운으로 변환
    const updatedMarkdown = updateDocTreeWithChanges(
      docTree,
      fileData.documentUpdates
    );

    return {
      success: true,
      message: `파일이 성공적으로 처리되었습니다: ${fileName}`,
      updatedMarkdown,
      githubInfo,
    };
  } catch (error) {
    return {
      success: false,
      message: `파일 처리 중 오류 발생: ${error}`,
    };
  }
}

export interface DocumentDiff {
  nodeId: string;
  fileName: string;
  markdownSection: string;
  diffBlock: any;
  hasChanges: boolean;
}

export async function generateDocumentDiffs(
  documentUpdates: DocumentUpdate[]
): Promise<DocumentDiff[]> {
  const diffs: DocumentDiff[] = [];

  for (const update of documentUpdates) {
    try {
      // 마크다운을 Slack 텍스트로 변환
      const oldSlackText = await convertMarkdownToSlackText(update.nodeContent);
      const newSlackText = await convertMarkdownToSlackText(
        update.updatedNodeContent
      );

      // Diff 생성
      const diffBlock = createDiffBlock(oldSlackText, newSlackText);

      // 변경사항 있는지 확인
      const diffHasChanges = oldSlackText !== newSlackText;

      if (diffHasChanges) {
        diffs.push({
          nodeId: update.nodeId,
          fileName: update.fileName,
          markdownSection: update.markdownSection || "전체 문서",
          diffBlock,
          hasChanges: diffHasChanges,
        });
      }
    } catch (error) {
      console.error(`문서 diff 생성 중 오류 발생: ${error}`);
    }
  }

  return diffs;
}
