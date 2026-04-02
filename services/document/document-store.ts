import type { Document } from '@langchain/core/documents';
import type { SlackMessage } from '../slack';
import type { DocumentMetadata } from '../vector/types';
import type { UpdateAnchor } from './update-anchor';

export interface DocumentUpdate {
  index: number;
  fileName: string;
  githubUrl: string;
  markdownSection: string;
  headingPath?: string; // 섹션 계층 경로 (UI 표시용)
  hasChanges: boolean;
  nodeContent: string; // 원본 노드 내용 (APPEND의 경우 마지막 노드 내용으로 간주될 수 있음)
  updatedNodeContent: string; // UPDATE 시 LLM이 변경한 전체 내용, APPEND 시에는 추가된 내용이 여기에 포함될 수도, 혹은 별도 필드.
  diffBlock: any; // TODO: Define proper type for diffBlock
  nodeId: string;
  oldContent: string; // Slack 미리보기용 원본
  newContent: string; // Slack 미리보기용 변경/추가된 내용
  messages: SlackMessage[];
  timestamp: string;
  knowledgeContent?: string; // knowledge extraction에서 나온 내용
  originalChannelId?: string; // 지식 출처 채널 ID
  originalThreadTs?: string; // 지식 출처 스레드 TS

  // For APPEND suggestion type
  suggestionType: 'UPDATE' | 'APPEND';
  originalLastNodeContent?: string; // APPEND 시 원본 마지막 노드 내용 (마크다운)
  appendedNodeContent?: string; // APPEND 시 새로 생성된/추가될 노드 내용 (마크다운)
  updateAnchor?: UpdateAnchor;
}

// 새로운 파일 선택 상태 관리를 위한 인터페이스
export interface FileSelectionState {
  isFileSelected: boolean;
  selectedFile?: string;
  initialSearchResults: Document<DocumentMetadata>[];
  fileSpecificResults: Document<DocumentMetadata>[];
  appliedSuggestions: Set<string>; // applied된 nodeId들
  maxSuggestions: number; // 최대 suggestion 수 (기본 5개)
  currentSuggestionCount: number; // 현재까지 보여준 suggestion 수
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

// 파일 선택 상태를 저장하기 위한 Map (userId -> FileSelectionState)
const fileSelectionStateStorage = new Map<string, FileSelectionState>();

// 검색 결과 캐시 제거됨 - 항상 최신 벡터 스토어 상태를 반영하기 위해

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
  channel_id?: string,
): void => {
  const existing = storedDocumentUpdates.get(userId) || { documentUpdates: [] };

  storedDocumentUpdates.set(userId, {
    documentUpdates: updates,
    thread_ts: thread_ts || existing.thread_ts,
    channel_id: channel_id || existing.channel_id,
  });
};

// 사용자의 thread 정보 저장하기
export const storeThreadInfo = (userId: string, thread_ts: string, channel_id: string): void => {
  const existing = storedDocumentUpdates.get(userId);

  if (existing) {
    storedDocumentUpdates.set(userId, {
      ...existing,
      thread_ts,
      channel_id,
    });
  }
};

// 특정 문서 업데이트의 updatedNodeContent 수정하기
export const updateDocumentContent = (userId: string, index: number, newContent: string): boolean => {
  const userUpdates = storedDocumentUpdates.get(userId);

  if (!userUpdates || !userUpdates.documentUpdates[index]) {
    console.log(`[Error] Failed to find document update for user ${userId}, index ${index}`);
    return false;
  }

  // 기존 업데이트 가져오기
  const update = userUpdates.documentUpdates[index];

  // 통일된 UPDATE 방식으로 처리
  update.updatedNodeContent = newContent;
  update.newContent = newContent;

  console.log('=== Document Store Update ===');
  console.log(`File: ${update.fileName}`);
  console.log(`Section: ${update.markdownSection}`);
  console.log(`Suggestion Type: ${update.suggestionType}`);
  console.log('Content updated successfully');
  console.log('=== End Document Store Update ===');

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

// 검색 결과 캐시 관련 함수들 - 다시 활성화
export function storeSearchResults(userId: string, searchResults: Document<DocumentMetadata>[]): void {
  searchResultsStorage.set(userId, searchResults);
}

// 검색 결과 가져오기 - 캐시된 결과 반환
export function getSearchResults(userId: string): Document<DocumentMetadata>[] {
  return searchResultsStorage.get(userId) || [];
}

// 검색 결과 삭제하기
export function clearSearchResults(userId: string) {
  searchResultsStorage.delete(userId);
}

// 특정 문서 업데이트 삭제하기
export const removeDocumentUpdate = (userId: string, index: number): boolean => {
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
  const docIndex = searchResults.findIndex((doc) => doc.metadata?.nodeId === updatedDocument.metadata?.nodeId);

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

// ===== 새로운 파일 선택 상태 관리 함수들 =====

/**
 * 파일 선택 상태 초기화
 */
export function initializeFileSelectionState(
  userId: string,
  isFileSelected: boolean,
  selectedFile?: string,
  initialSearchResults: Document<DocumentMetadata>[] = [],
  fileSpecificResults: Document<DocumentMetadata>[] = []
): void {
  const state: FileSelectionState = {
    isFileSelected,
    selectedFile,
    initialSearchResults,
    fileSpecificResults,
    appliedSuggestions: new Set(),
    maxSuggestions: 5,
    currentSuggestionCount: 0,
  };
  
  fileSelectionStateStorage.set(userId, state);
  console.info(`Initialized file selection state for user ${userId}: fileSelected=${isFileSelected}, file=${selectedFile}`);
}

/**
 * 파일 선택 상태 가져오기
 */
export function getFileSelectionState(userId: string): FileSelectionState | null {
  return fileSelectionStateStorage.get(userId) || null;
}

/**
 * Apply Changes 후 파일 선택 상태 초기화 (suggestion count 보존)
 */
export function resetFileSelectionAfterApply(
  userId: string,
  initialSearchResults: Document<DocumentMetadata>[]
): void {
  const currentState = getFileSelectionState(userId);
  if (!currentState) return;

  const state: FileSelectionState = {
    isFileSelected: false,
    selectedFile: undefined,
    initialSearchResults,
    fileSpecificResults: [],
    appliedSuggestions: currentState.appliedSuggestions, // 기존 적용된 제안들 유지
    maxSuggestions: currentState.maxSuggestions,
    currentSuggestionCount: currentState.currentSuggestionCount, // suggestion count 보존
  };
  
  fileSelectionStateStorage.set(userId, state);
  console.info(`Reset file selection state after Apply Changes for user ${userId}: preserving count=${state.currentSuggestionCount}`);
}

/**
 * suggestion을 applied로 마킹
 */
export function markSuggestionAsApplied(userId: string, nodeId: string): boolean {
  const state = fileSelectionStateStorage.get(userId);
  if (!state) {
    console.warn(`No file selection state found for user ${userId}`);
    return false;
  }
  
  state.appliedSuggestions.add(nodeId);
  fileSelectionStateStorage.set(userId, state);
  console.info(`Marked suggestion ${nodeId} as applied for user ${userId}`);
  return true;
}

/**
 * 현재 suggestion 카운트 증가
 */
export function incrementSuggestionCount(userId: string): void {
  const state = fileSelectionStateStorage.get(userId);
  if (state) {
    state.currentSuggestionCount++;
    fileSelectionStateStorage.set(userId, state);
  }
}

/**
 * 최대 suggestion 수에 도달했는지 확인
 */
export function isMaxSuggestionsReached(userId: string): boolean {
  const state = fileSelectionStateStorage.get(userId);
  if (!state) return false;
  
  return state.currentSuggestionCount >= state.maxSuggestions;
}

/**
 * 동적 순서 계산 - 새로운 로직의 핵심
 * Apply된 suggestions에 따라 순서를 동적으로 재계산
 */
export function calculateDynamicOrder(userId: string): Document<DocumentMetadata>[] {
  const state = fileSelectionStateStorage.get(userId);
  if (!state) {
    console.warn(`No file selection state found for user ${userId}`);
    return [];
  }
  
  // 파일이 선택되지 않은 경우: initial search 결과만 사용
  if (!state.isFileSelected) {
    return state.initialSearchResults;
  }
  
  // 파일이 선택된 경우: 동적 순서 계산
  const result: Document<DocumentMetadata>[] = [];
  
  // file-specific 결과에서 아직 applied되지 않은 것들을 순서대로 추가
  for (const doc of state.fileSpecificResults) {
    if (!state.appliedSuggestions.has(doc.metadata?.nodeId || '')) {
      result.push(doc);
    }
  }
  
  // initial search 결과에서 중복 제거하고 추가
  const fileSpecificNodeIds = new Set(state.fileSpecificResults.map(doc => doc.metadata?.nodeId));
  const filteredInitialResults = state.initialSearchResults.filter(doc => 
    !fileSpecificNodeIds.has(doc.metadata?.nodeId) && 
    !state.appliedSuggestions.has(doc.metadata?.nodeId || '')
  );
  
  result.push(...filteredInitialResults);
  
  console.info(`Calculated dynamic order for user ${userId}: ${result.length} documents, ${state.appliedSuggestions.size} applied`);
  return result;
}

/**
 * 다음 suggestion 가져오기
 */
export function getNextSuggestion(userId: string): Document<DocumentMetadata> | null {
  const dynamicOrder = calculateDynamicOrder(userId);
  const state = fileSelectionStateStorage.get(userId);
  
  if (!state || dynamicOrder.length === 0) {
    return null;
  }
  
  // 최대 suggestion 수 체크 (파일 선택된 경우만)
  if (state.isFileSelected && state.currentSuggestionCount >= state.maxSuggestions) {
    return null;
  }
  
  // 현재 suggestion 카운트에 맞는 document 반환 (0-based index)
  const currentIndex = state.currentSuggestionCount;
  if (currentIndex >= dynamicOrder.length) {
    return null;
  }
  
  return dynamicOrder[currentIndex] || null;
}

/**
 * 파일 선택 상태 정리
 */
export function clearFileSelectionState(userId: string): void {
  fileSelectionStateStorage.delete(userId);
  console.info(`Cleared file selection state for user ${userId}`);
}
