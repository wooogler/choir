import { SlackMessage } from "./slack-utils";

export interface DocumentUpdate {
  index: number;
  fileName: string;
  githubUrl: string;
  markdownSection: string;
  hasChanges: boolean;
  nodeContent: string;
  updatedNodeContent: string;
  diffBlock: any; // TODO: Define proper type for diffBlock
  nodeId: string;
  oldContent: string;
  newContent: string;
  messages: SlackMessage[];
  timestamp: string;
}

// documentUpdates를 저장하기 위한 Map (userId -> { documentUpdates, thread_ts })
const storedDocumentUpdates = new Map<
  string,
  { documentUpdates: DocumentUpdate[]; thread_ts?: string }
>();

// 선택된 문서 ID를 저장하기 위한 Map (userId -> Set<string>)
const selectedNodeIds = new Map<string, Set<string>>();

// 사용자의 documentUpdates 가져오기
export const getStoredDocumentUpdates = (userId: string): DocumentUpdate[] => {
  return storedDocumentUpdates.get(userId)?.documentUpdates || [];
};

// 사용자의 thread_ts 가져오기
export const getStoredThreadTs = (userId: string): string | undefined => {
  return storedDocumentUpdates.get(userId)?.thread_ts;
};

// 사용자의 documentUpdates 저장하기
export const storeDocumentUpdates = (
  userId: string,
  updates: DocumentUpdate[],
  thread_ts?: string
): void => {
  storedDocumentUpdates.set(userId, { documentUpdates: updates, thread_ts });
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
