/**
 * 메시지 타임스탬프 관리 서비스
 * 여러 핸들러 간에 메시지 타임스탬프를 공유하기 위한 중앙 관리 시스템
 */

// 사용자별 마지막 메시지 타임스탬프 저장
const lastMessageTimestamps = new Map<string, string>();

// 사용자별 진행 중 메시지 타임스탬프 저장 (로딩 메시지 등)
const progressMessageTimestamps = new Map<string, string>();

/**
 * 사용자의 마지막 메시지 타임스탬프 설정
 */
export function setLastMessageTimestamp(userId: string, timestamp: string): void {
  lastMessageTimestamps.set(userId, timestamp);
}

/**
 * 사용자의 마지막 메시지 타임스탬프 가져오기
 */
export function getLastMessageTimestamp(userId: string): string | undefined {
  return lastMessageTimestamps.get(userId);
}

/**
 * 사용자의 마지막 메시지 타임스탬프 삭제
 */
export function deleteLastMessageTimestamp(userId: string): void {
  lastMessageTimestamps.delete(userId);
}

/**
 * 사용자의 진행 중 메시지 타임스탬프 설정
 */
export function setProgressMessageTimestamp(userId: string, timestamp: string): void {
  progressMessageTimestamps.set(userId, timestamp);
}

/**
 * 사용자의 진행 중 메시지 타임스탬프 가져오기
 */
export function getProgressMessageTimestamp(userId: string): string | undefined {
  return progressMessageTimestamps.get(userId);
}

/**
 * 사용자의 진행 중 메시지 타임스탬프 삭제
 */
export function deleteProgressMessageTimestamp(userId: string): void {
  progressMessageTimestamps.delete(userId);
}

/**
 * 사용자의 모든 타임스탬프 정리
 */
export function clearUserTimestamps(userId: string): void {
  lastMessageTimestamps.delete(userId);
  progressMessageTimestamps.delete(userId);
} 