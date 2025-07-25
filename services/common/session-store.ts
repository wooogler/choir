/**
 * session-store.ts
 *
 * 세션 데이터 저장소 구현
 * Slack API의 private_metadata 크기 제한(3001자)을 우회하기 위한 임시 저장소입니다.
 */

// 세션 타입 열거형
export enum SessionType {
  DOCUMENT_UPDATE = 'document_update', // 문서 업데이트/지식 추출 세션
  NEW_SECTION = 'new_section', // 새 섹션 생성 세션
  ANONYMOUS_MESSAGE = 'anonymous_message', // Anonymous 질문 메시지 추적
}

// 세션 타입별 데이터를 저장할 Map (메모리 기반 저장소)
const sessionStores = {
  [SessionType.DOCUMENT_UPDATE]: new Map<string, any>(),
  [SessionType.NEW_SECTION]: new Map<string, any>(),
  [SessionType.ANONYMOUS_MESSAGE]: new Map<string, any>(),
};

/**
 * 세션 데이터를 저장합니다.
 * @param sessionId 세션 ID
 * @param data 저장할 데이터 객체
 * @param sessionType 세션 타입 (DISCUSSION 또는 CONSULTATION)
 * @param expirationMs 세션 만료 시간 (밀리초, 기본값 1시간)
 */
export function storeSessionData(
  sessionId: string,
  data: any,
  sessionType: SessionType = SessionType.DOCUMENT_UPDATE,
  expirationMs: number = 60 * 60 * 1000, // 1시간으로 연장
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

  console.log(`세션 저장: ${sessionId} (${sessionType}), 만료 시간: ${expirationMs}ms`);
}

/**
 * 저장된 세션 데이터를 가져옵니다.
 * @param sessionId 세션 ID
 * @param sessionType 세션 타입 (DISCUSSION 또는 CONSULTATION)
 * @returns 저장된 데이터 객체, 없으면 null
 */
export function getSessionData(sessionId: string, sessionType: SessionType = SessionType.DOCUMENT_UPDATE): any {
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
export function removeSessionData(sessionId: string, sessionType: SessionType = SessionType.DOCUMENT_UPDATE): boolean {
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
export function generateSessionId(prefix = 'session'): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 10);
  return `${prefix}_${timestamp}_${random}`;
}

/**
 * Anonymous 메시지를 추적합니다.
 * @param channelId DM 채널 ID
 * @param messageTs 메시지 timestamp
 * @param originalQuestionerId 원래 질문자 ID
 * @param sessionId 세션 ID
 */
export function trackAnonymousMessage(
  channelId: string,
  messageTs: string,
  originalQuestionerId: string,
  sessionId: string,
): void {
  const key = `${channelId}_${messageTs}`;
  storeSessionData(
    key,
    {
      channelId,
      messageTs,
      originalQuestionerId,
      sessionId,
      isProcessed: false, // "Send Reply to Questioner" 버튼이 클릭되었는지 여부
    },
    SessionType.ANONYMOUS_MESSAGE,
    60 * 60 * 1000, // 1시간 후 만료
  );
}

/**
 * 채널이 Anonymous 메시지 DM인지 확인합니다.
 * @param channelId 채널 ID
 * @returns Anonymous 메시지 정보 또는 null
 */
export function getAnonymousMessageInfo(channelId: string): any {
  const store = sessionStores[SessionType.ANONYMOUS_MESSAGE];

  // 해당 채널의 Anonymous 메시지 찾기
  for (const [key, session] of store.entries()) {
    // 내부 프로퍼티 제외하고 데이터 추출
    const { _timerId, _createdAt, ...data } = session;
    if (data.channelId === channelId && !data.isProcessed) {
      return {
        messageTs: data.messageTs,
        originalQuestionerId: data.originalQuestionerId,
        sessionId: data.sessionId,
        isProcessed: data.isProcessed,
        key,
      };
    }
  }

  return null;
}

/**
 * Anonymous 메시지를 처리됨으로 표시합니다.
 * @param key Anonymous 메시지 키
 */
export function markAnonymousMessageProcessed(key: string): void {
  const store = sessionStores[SessionType.ANONYMOUS_MESSAGE];
  const session = store.get(key);

  if (session) {
    session.isProcessed = true;
    console.log(`Anonymous message marked as processed: ${key}`);
  } else {
    console.log(`Anonymous message not found for key: ${key}`);
  }
}

/**
 * Thread message가 Anonymous 메시지의 thread인지 확인합니다.
 * @param channelId 채널 ID
 * @param threadTs Thread timestamp (root message timestamp)
 * @returns Anonymous 메시지 정보 또는 null
 */
export function getAnonymousThreadInfo(channelId: string, threadTs: string): any {
  const store = sessionStores[SessionType.ANONYMOUS_MESSAGE];
  const key = `${channelId}_${threadTs}`;

  const session = store.get(key);
  if (session) {
    // 내부 프로퍼티 제외하고 데이터 추출
    const { _timerId, _createdAt, ...data } = session;
    if (!data.isProcessed) {
      return {
        messageTs: data.messageTs,
        originalQuestionerId: data.originalQuestionerId,
        sessionId: data.sessionId,
        isProcessed: data.isProcessed,
        key,
      };
    }
  }

  return null;
}
