import { SlackMessage } from "../slack";
import { Document } from "@langchain/core/documents";
import { DocumentMetadata } from "../vector/types";

export interface DocumentUpdate {
  index: number;
  fileName: string;
  githubUrl: string;
  markdownSection: string;
  headingPath?: string[]; // 섹션 계층 경로
  hasChanges: boolean;
  nodeContent: string;
  updatedNodeContent: string;
  diffBlock: any; // TODO: Define proper type for diffBlock
  nodeId: string;
  oldContent: string;
  newContent: string;
  messages: SlackMessage[];
  timestamp: string;
  knowledgeContent?: string; // knowledge extraction에서 나온 내용
}

// documentUpdates를 저장하기 위한 Map (userId -> { documentUpdates, thread_ts, channel_id })
const storedDocumentUpdates = new Map<
  string,
  { documentUpdates: DocumentUpdate[]; thread_ts?: string; channel_id?: string }
>();

// 선택된 문서 ID를 저장하기 위한 Map (userId -> Set<string>)
const selectedNodeIds = new Map<string, Set<string>>();

// 검색 결과를 저장하기 위한 Map (userId -> Document<DocumentMetadata>[])
const searchResultsStorage = new Map<string, Document<DocumentMetadata>[]>();

// Store user search results
const userSearchResults = new Map<string, Document<DocumentMetadata>[]>();

// 사용자의 documentUpdates 가져오기
export const getStoredDocumentUpdates = (userId: string): DocumentUpdate[] => {
  return storedDocumentUpdates.get(userId)?.documentUpdates || [];
};

// 사용자의 thread_ts 가져오기
export const getStoredThreadTs = (userId: string): string | undefined => {
  return storedDocumentUpdates.get(userId)?.thread_ts;
};

// 사용자의 channel_id 가져오기
export const getStoredChannelId = (userId: string): string | undefined => {
  return storedDocumentUpdates.get(userId)?.channel_id;
};

// 사용자의 documentUpdates 저장하기
export const storeDocumentUpdates = (
  userId: string,
  updates: DocumentUpdate[],
  thread_ts?: string,
  channel_id?: string
): void => {
  const existing = storedDocumentUpdates.get(userId) || { documentUpdates: [] };
  
  storedDocumentUpdates.set(userId, { 
    documentUpdates: updates, 
    thread_ts: thread_ts || existing.thread_ts,
    channel_id: channel_id || existing.channel_id
  });
};

// 사용자의 thread 정보 저장하기
export const storeThreadInfo = (
  userId: string,
  thread_ts: string,
  channel_id: string
): void => {
  const existing = storedDocumentUpdates.get(userId);
  
  if (existing) {
    storedDocumentUpdates.set(userId, { 
      ...existing, 
      thread_ts, 
      channel_id 
    });
  }
};

// 특정 문서 업데이트의 updatedNodeContent 수정하기
export const updateDocumentContent = (
  userId: string,
  index: number,
  newContent: string
): boolean => {
  const userUpdates = storedDocumentUpdates.get(userId);
  
  if (!userUpdates || !userUpdates.documentUpdates[index]) {
    console.log(`[Error] Failed to find document update for user ${userId}, index ${index}`);
    return false;
  }
  
  // 기존 업데이트 가져오기
  const update = userUpdates.documentUpdates[index];
  
  // 업데이트된 콘텐츠 변경
  update.updatedNodeContent = newContent;
  update.newContent = newContent; // newContent 필드도 함께 업데이트
  
  console.log("=== Document Store Update ===");
  console.log(`File: ${update.fileName}`);
  console.log(`Section: ${update.markdownSection}`);
  console.log("Content updated successfully");
  console.log("=== End Document Store Update ===");
  
  return true;
};

// 사용자의 선택된 문서 ID 가져오기
export const getSelectedNodeIds = (userId: string): string[] => {
  return Array.from(selectedNodeIds.get(userId) || new Set<string>());
};

// 사용자의 선택된 문서 ID 초기화
export const clearSelectedNodeIds = (userId: string): void => {
  selectedNodeIds.set(userId, new Set<string>());
};

// 사용자의 선택된 문서 ID 추가
export const addSelectedNodeId = (userId: string, nodeId: string): void => {
  if (!selectedNodeIds.has(userId)) {
    selectedNodeIds.set(userId, new Set<string>());
  }
  selectedNodeIds.get(userId)!.add(nodeId);
};

// 사용자의 선택된 문서 ID 제거
export const removeSelectedNodeId = (userId: string, nodeId: string): void => {
  if (selectedNodeIds.has(userId)) {
    selectedNodeIds.get(userId)!.delete(nodeId);
  }
};

// 사용자의 선택된 문서 ID 설정
export const setSelectedNodeIds = (userId: string, nodeIds: string[]): void => {
  selectedNodeIds.set(userId, new Set<string>(nodeIds));
};

// 검색 결과 저장하기
export function storeSearchResults(userId: string, searchResults: Document<DocumentMetadata>[]): void {
  userSearchResults.set(userId, searchResults);
}

// 검색 결과 가져오기
export function getSearchResults(userId: string): Document<DocumentMetadata>[] {
  return userSearchResults.get(userId) || [];
}

// 검색 결과 삭제하기
export function clearSearchResults(userId: string) {
  userSearchResults.delete(userId);
}

// 특정 문서 업데이트 삭제하기
export const removeDocumentUpdate = (
  userId: string,
  index: number
): boolean => {
  const userUpdates = storedDocumentUpdates.get(userId);
  
  if (!userUpdates || !userUpdates.documentUpdates[index]) {
    return false;
  }
  
  // index 위치의 업데이트 제거
  userUpdates.documentUpdates.splice(index, 1);
  
  // 업데이트된 배열 저장
  storedDocumentUpdates.set(userId, userUpdates);
  
  return true;
};

export function updateSearchResultDocument(userId: string, updatedDocument: Document<DocumentMetadata>): void {
  const searchResults = getSearchResults(userId);
  const docIndex = searchResults.findIndex(
    doc => doc.metadata?.nodeId === updatedDocument.metadata?.nodeId
  );
  
  if (docIndex !== -1) {
    searchResults[docIndex] = updatedDocument;
    storeSearchResults(userId, searchResults);
    console.info(`Updated search result document for node: ${updatedDocument.metadata?.nodeId}`);
  }
}

export function updateSearchResultsForFile(userId: string, updatedFile: any): void {
  // 이 함수는 현재 벡터 스토어 업데이트로 충분하므로 빈 구현
  console.info(`Search results will be updated through vector store for file: ${updatedFile.name}`);
}
