import type { Document } from '@langchain/core/documents';
import { getDatabase } from 'services/db/connection';
import type { NewSectionSuggestion } from 'services/llm/content-generator';
import type { DocumentMetadata } from '../file-registry/types';
import type { SlackMessage } from '../slack';
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

// 검색 결과 캐시 제거됨 - 항상 최신 벡터 스토어 상태를 반영하기 위해

const getScopedUserKey = (userId: string, workspaceId?: string): string =>
  workspaceId ? `${workspaceId}:${userId}` : userId;

function getStateKey(stateType: string, userId: string, workspaceId?: string): string {
  return `${stateType}:${getScopedUserKey(userId, workspaceId)}`;
}

function getAppState<T>(stateType: string, userId: string, workspaceId?: string): T | null {
  const row = getDatabase()
    .prepare('SELECT data_json AS dataJson FROM app_state WHERE state_key = ?')
    .get(getStateKey(stateType, userId, workspaceId)) as { dataJson: string } | undefined;

  return row ? (JSON.parse(row.dataJson) as T) : null;
}

function setAppState(stateType: string, userId: string, value: unknown, workspaceId?: string): void {
  getDatabase()
    .prepare(`
      INSERT INTO app_state (state_key, state_type, data_json, updated_at)
      VALUES (@stateKey, @stateType, @dataJson, @updatedAt)
      ON CONFLICT(state_key) DO UPDATE SET
        state_type = excluded.state_type,
        data_json = excluded.data_json,
        updated_at = excluded.updated_at
    `)
    .run({
      stateKey: getStateKey(stateType, userId, workspaceId),
      stateType,
      dataJson: JSON.stringify(value),
      updatedAt: Date.now(),
    });
}

function deleteAppState(stateType: string, userId: string, workspaceId?: string): void {
  getDatabase()
    .prepare('DELETE FROM app_state WHERE state_key = ?')
    .run(getStateKey(stateType, userId, workspaceId));
}

export function purgeWorkspaceAppState(workspaceId: string): number {
  const result = getDatabase().prepare('DELETE FROM app_state WHERE state_key LIKE ?').run(`%:${workspaceId}:%`);
  return result.changes;
}

function serializeFileSelectionState(state: FileSelectionState): Omit<FileSelectionState, 'appliedSuggestions'> & {
  appliedSuggestions: string[];
} {
  return {
    ...state,
    appliedSuggestions: Array.from(state.appliedSuggestions),
  };
}

function deserializeFileSelectionState(data: any): FileSelectionState {
  return {
    ...data,
    appliedSuggestions: new Set<string>(data.appliedSuggestions || []),
  };
}

// 사용자의 documentUpdates 가져오기
export const getStoredDocumentUpdates = (userId: string, workspaceId?: string): DocumentUpdate[] => {
  return (
    getAppState<{ documentUpdates: DocumentUpdate[]; thread_ts?: string; channel_id?: string }>(
      'document_updates',
      userId,
      workspaceId,
    )?.documentUpdates || []
  );
};

// 사용자의 documentUpdates 저장하기
export const storeDocumentUpdates = (
  userId: string,
  updates: DocumentUpdate[],
  thread_ts?: string,
  channel_id?: string,
  workspaceId?: string,
): void => {
  const existing = getAppState<{ documentUpdates: DocumentUpdate[]; thread_ts?: string; channel_id?: string }>(
    'document_updates',
    userId,
    workspaceId,
  ) || { documentUpdates: [] };

  setAppState(
    'document_updates',
    userId,
    {
      documentUpdates: updates,
      thread_ts: thread_ts || existing.thread_ts,
      channel_id: channel_id || existing.channel_id,
    },
    workspaceId,
  );
};

// 특정 문서 업데이트의 updatedNodeContent 수정하기
export const updateDocumentContent = (
  userId: string,
  index: number,
  newContent: string,
  workspaceId?: string,
): boolean => {
  const userUpdates = getAppState<{ documentUpdates: DocumentUpdate[]; thread_ts?: string; channel_id?: string }>(
    'document_updates',
    userId,
    workspaceId,
  );

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
  setAppState('document_updates', userId, userUpdates, workspaceId);

  return true;
};

// 검색 결과 캐시 관련 함수들 - 다시 활성화
export function storeSearchResults(
  userId: string,
  searchResults: Document<DocumentMetadata>[],
  workspaceId?: string,
): void {
  setAppState('search_results', userId, searchResults, workspaceId);
}

// 검색 결과 가져오기 - 캐시된 결과 반환
export function getSearchResults(userId: string, workspaceId?: string): Document<DocumentMetadata>[] {
  return getAppState<Document<DocumentMetadata>[]>('search_results', userId, workspaceId) || [];
}

// 특정 문서 업데이트 삭제하기
export const removeDocumentUpdate = (userId: string, index: number, workspaceId?: string): boolean => {
  const userUpdates = getAppState<{ documentUpdates: DocumentUpdate[]; thread_ts?: string; channel_id?: string }>(
    'document_updates',
    userId,
    workspaceId,
  );

  if (!userUpdates || !userUpdates.documentUpdates[index]) {
    return false;
  }

  // index 위치의 업데이트 제거
  userUpdates.documentUpdates.splice(index, 1);

  // 업데이트된 배열 저장
  setAppState('document_updates', userId, userUpdates, workspaceId);

  return true;
};

// ===== 새 섹션 제안 캐시 =====
// createNewSectionFromKnowledge 는 현재 문서가 아니라 knowledgeContent + 파일 목록에만
// 의존하므로, 같은 리뷰 세션(동일 knowledgeContent)에서는 한 번만 계산해 재사용한다.

interface CachedNewSection {
  knowledgeContent: string;
  suggestion: NewSectionSuggestion;
}

export function getCachedNewSectionSuggestion(
  userId: string,
  knowledgeContent: string,
  workspaceId?: string,
): NewSectionSuggestion | null {
  const cached = getAppState<CachedNewSection>('new_section_cache', userId, workspaceId);
  return cached && cached.knowledgeContent === knowledgeContent ? cached.suggestion : null;
}

export function setCachedNewSectionSuggestion(
  userId: string,
  knowledgeContent: string,
  suggestion: NewSectionSuggestion,
  workspaceId?: string,
): void {
  setAppState('new_section_cache', userId, { knowledgeContent, suggestion }, workspaceId);
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
  fileSpecificResults: Document<DocumentMetadata>[] = [],
  workspaceId?: string,
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

  setAppState('file_selection_state', userId, serializeFileSelectionState(state), workspaceId);
  console.info(
    `Initialized file selection state for user ${userId}: fileSelected=${isFileSelected}, file=${selectedFile}`,
  );
}

/**
 * 파일 선택 상태 가져오기
 */
export function getFileSelectionState(userId: string, workspaceId?: string): FileSelectionState | null {
  const state = getAppState<any>('file_selection_state', userId, workspaceId);
  return state ? deserializeFileSelectionState(state) : null;
}

/**
 * Apply Changes 후 파일 선택 상태 초기화 (suggestion count 보존)
 */
export function resetFileSelectionAfterApply(
  userId: string,
  initialSearchResults: Document<DocumentMetadata>[],
  workspaceId?: string,
): void {
  const currentState = getFileSelectionState(userId, workspaceId);
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

  setAppState('file_selection_state', userId, serializeFileSelectionState(state), workspaceId);
  console.info(
    `Reset file selection state after Apply Changes for user ${userId}: preserving count=${state.currentSuggestionCount}`,
  );
}

/**
 * suggestion을 applied로 마킹
 */
export function markSuggestionAsApplied(userId: string, nodeId: string, workspaceId?: string): boolean {
  const state = getFileSelectionState(userId, workspaceId);
  if (!state) {
    console.warn(`No file selection state found for user ${userId}`);
    return false;
  }

  state.appliedSuggestions.add(nodeId);
  setAppState('file_selection_state', userId, serializeFileSelectionState(state), workspaceId);
  console.info(`Marked suggestion ${nodeId} as applied for user ${userId}`);
  return true;
}

/**
 * 현재 suggestion 카운트 증가
 */
export function incrementSuggestionCount(userId: string, workspaceId?: string): void {
  const state = getFileSelectionState(userId, workspaceId);
  if (state) {
    state.currentSuggestionCount++;
    setAppState('file_selection_state', userId, serializeFileSelectionState(state), workspaceId);
  }
}

/**
 * 최대 suggestion 수에 도달했는지 확인
 */
export function isMaxSuggestionsReached(userId: string, workspaceId?: string): boolean {
  const state = getFileSelectionState(userId, workspaceId);
  if (!state) return false;

  return state.currentSuggestionCount >= state.maxSuggestions;
}

/**
 * 동적 순서 계산 - 새로운 로직의 핵심
 * Apply된 suggestions에 따라 순서를 동적으로 재계산
 */
export function calculateDynamicOrder(userId: string, workspaceId?: string): Document<DocumentMetadata>[] {
  const state = getFileSelectionState(userId, workspaceId);
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
  const fileSpecificNodeIds = new Set(state.fileSpecificResults.map((doc) => doc.metadata?.nodeId));
  const filteredInitialResults = state.initialSearchResults.filter(
    (doc) =>
      !fileSpecificNodeIds.has(doc.metadata?.nodeId) && !state.appliedSuggestions.has(doc.metadata?.nodeId || ''),
  );

  result.push(...filteredInitialResults);

  console.info(
    `Calculated dynamic order for user ${userId}: ${result.length} documents, ${state.appliedSuggestions.size} applied`,
  );
  return result;
}

/**
 * 다음 suggestion 가져오기
 */
export function getNextSuggestion(userId: string, workspaceId?: string): Document<DocumentMetadata> | null {
  const dynamicOrder = calculateDynamicOrder(userId, workspaceId);
  const state = getFileSelectionState(userId, workspaceId);

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
export function clearFileSelectionState(userId: string, workspaceId?: string): void {
  deleteAppState('file_selection_state', userId, workspaceId);
  deleteAppState('new_section_cache', userId, workspaceId);
  console.info(`Cleared file selection state for user ${userId}`);
}
