/**
 * session-store.ts
 *
 * 세션 데이터 저장소 구현
 * Slack API의 private_metadata 크기 제한(3001자)을 우회하기 위한 임시 저장소입니다.
 */

// 세션 타입 열거형
export enum SessionType {
  DISCUSSION = "discussion",
  CONSULTATION = "consultation",
}

// 세션 타입별 데이터를 저장할 Map (메모리 기반 저장소)
const sessionStores = {
  [SessionType.DISCUSSION]: new Map<string, any>(),
  [SessionType.CONSULTATION]: new Map<string, any>(),
};

/**
 * 세션 데이터를 저장합니다.
 * @param sessionId 세션 ID
 * @param data 저장할 데이터 객체
 * @param sessionType 세션 타입 (DISCUSSION 또는 CONSULTATION)
 * @param expirationMs 세션 만료 시간 (밀리초, 기본값 30분)
 */
export function storeSessionData(
  sessionId: string,
  data: any,
  sessionType: SessionType = SessionType.DISCUSSION,
  expirationMs: number = 30 * 60 * 1000
): void {
  const sessionStore = sessionStores[sessionType];

  // 기존 타이머가 있으면 제거
  const existingSession = sessionStore.get(sessionId);
  if (existingSession && existingSession._timerId) {
    clearTimeout(existingSession._timerId);
  }

  // 만료 타이머 설정
  const timerId = setTimeout(() => {
    console.log(`세션 만료: ${sessionId} (${sessionType})`);
    sessionStore.delete(sessionId);
  }, expirationMs);

  // 데이터와 타이머 ID 저장
  sessionStore.set(sessionId, {
    ...data,
    _timerId: timerId,
    _createdAt: Date.now(),
  });

  console.log(
    `세션 저장: ${sessionId} (${sessionType}), 만료 시간: ${expirationMs}ms`
  );
}

/**
 * 저장된 세션 데이터를 가져옵니다.
 * @param sessionId 세션 ID
 * @param sessionType 세션 타입 (DISCUSSION 또는 CONSULTATION)
 * @returns 저장된 데이터 객체, 없으면 null
 */
export function getSessionData(
  sessionId: string,
  sessionType: SessionType = SessionType.DISCUSSION
): any {
  const sessionStore = sessionStores[sessionType];
  const session = sessionStore.get(sessionId);

  if (!session) {
    console.log(`존재하지 않는 세션: ${sessionId} (${sessionType})`);
    return null;
  }

  // 내부 프로퍼티 제외하고 반환
  const { _timerId, _createdAt, ...data } = session;
  return data;
}

/**
 * 세션 데이터를 삭제합니다.
 * @param sessionId 세션 ID
 * @param sessionType 세션 타입 (DISCUSSION 또는 CONSULTATION)
 * @returns 삭제 성공 여부
 */
export function removeSessionData(
  sessionId: string,
  sessionType: SessionType = SessionType.DISCUSSION
): boolean {
  const sessionStore = sessionStores[sessionType];
  const session = sessionStore.get(sessionId);

  if (session && session._timerId) {
    clearTimeout(session._timerId);
  }

  return sessionStore.delete(sessionId);
}

/**
 * 새로운 고유 세션 ID를 생성합니다.
 * @param prefix 세션 ID 접두사 (기본값: 'session')
 * @returns 생성된 세션 ID
 */
export function generateSessionId(prefix: string = "session"): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 10);
  return `${prefix}_${timestamp}_${random}`;
}
