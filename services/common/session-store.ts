/**
 * session-store.ts
 *
 * 세션 데이터 저장소 구현
 * Slack API의 private_metadata 크기 제한(3001자)을 우회하기 위한 임시 저장소입니다.
 */
import { getDatabase } from 'services/db/connection';

// 세션 타입 열거형
export enum SessionType {
  DOCUMENT_UPDATE = 'document_update', // 문서 업데이트/지식 추출 세션
  NEW_SECTION = 'new_section', // 새 섹션 생성 세션
  ANONYMOUS_MESSAGE = 'anonymous_message', // Anonymous 질문 메시지 추적
  CREATE_FILE_MODAL = 'create_file_modal', // Create File Modal 데이터
  GENERAL_CONVERSATION = 'general_conversation', // General conversation correction buttons
}

const sessionTimers = new Map<string, NodeJS.Timeout>();

function getSessionKey(sessionId: string, sessionType: SessionType): string {
  return `${sessionType}:${sessionId}`;
}

function deleteSession(sessionId: string, sessionType: SessionType): boolean {
  const result = getDatabase()
    .prepare('DELETE FROM sessions WHERE session_type = ? AND session_id = ?')
    .run(sessionType, sessionId);
  return result.changes > 0;
}

function deserializeSessionData(dataJson: string): any {
  return JSON.parse(dataJson);
}

function getSessionRow(sessionId: string, sessionType: SessionType): any | null {
  const row = getDatabase()
    .prepare(`
      SELECT data_json AS dataJson, expires_at AS expiresAt
      FROM sessions
      WHERE session_type = ? AND session_id = ?
    `)
    .get(sessionType, sessionId) as { dataJson: string; expiresAt: number } | undefined;

  if (!row) {
    return null;
  }

  if (row.expiresAt <= Date.now()) {
    deleteSession(sessionId, sessionType);
    return null;
  }

  return deserializeSessionData(row.dataJson);
}

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
  expirationMs: number = 24 * 60 * 60 * 1000, // 24시간으로 연장
): void {
  const sessionKey = getSessionKey(sessionId, sessionType);

  // 기존 타이머가 있으면 제거
  const existingTimer = sessionTimers.get(sessionKey);
  if (existingTimer) {
    clearTimeout(existingTimer);
    sessionTimers.delete(sessionKey);
  }

  const now = Date.now();
  const expiresAt = now + expirationMs;

  // 만료 타이머 설정
  const timerId = setTimeout(() => {
    console.log(`세션 만료: ${sessionId} (${sessionType})`);
    deleteSession(sessionId, sessionType);
    sessionTimers.delete(sessionKey);
  }, expirationMs);
  sessionTimers.set(sessionKey, timerId);

  getDatabase()
    .prepare(`
      INSERT INTO sessions (session_type, session_id, data_json, expires_at, created_at, updated_at)
      VALUES (@sessionType, @sessionId, @dataJson, @expiresAt, @createdAt, @updatedAt)
      ON CONFLICT(session_type, session_id) DO UPDATE SET
        data_json = excluded.data_json,
        expires_at = excluded.expires_at,
        updated_at = excluded.updated_at
    `)
    .run({
      sessionType,
      sessionId,
      dataJson: JSON.stringify(data),
      expiresAt,
      createdAt: now,
      updatedAt: now,
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
  const session = getSessionRow(sessionId, sessionType);

  if (!session) {
    console.log(`존재하지 않는 세션: ${sessionId} (${sessionType})`);
    return null;
  }

  return session;
}

/**
 * 세션 데이터를 삭제합니다.
 * @param sessionId 세션 ID
 * @param sessionType 세션 타입 (DISCUSSION 또는 CONSULTATION)
 * @returns 삭제 성공 여부
 */
export function removeSessionData(sessionId: string, sessionType: SessionType = SessionType.DOCUMENT_UPDATE): boolean {
  const sessionKey = getSessionKey(sessionId, sessionType);
  const timer = sessionTimers.get(sessionKey);

  if (timer) {
    clearTimeout(timer);
    sessionTimers.delete(sessionKey);
  }

  return deleteSession(sessionId, sessionType);
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
  workspaceId = 'default',
): void {
  const key = `${workspaceId}_${channelId}_${messageTs}`;
  storeSessionData(
    key,
    {
      channelId,
      messageTs,
      originalQuestionerId,
      sessionId,
      workspaceId,
      isProcessed: false, // "Send Reply to Questioner" 버튼이 클릭되었는지 여부
    },
    SessionType.ANONYMOUS_MESSAGE,
    7 * 24 * 60 * 60 * 1000, // 7일 후 만료
  );
}

/**
 * 채널이 Anonymous 메시지 DM인지 확인합니다.
 * @param channelId 채널 ID
 * @returns Anonymous 메시지 정보 또는 null
 */
export function getAnonymousMessageInfo(channelId: string, workspaceId = 'default'): any {
  const rows = getDatabase()
    .prepare(`
      SELECT session_id AS sessionId, data_json AS dataJson, expires_at AS expiresAt
      FROM sessions
      WHERE session_type = ?
    `)
    .all(SessionType.ANONYMOUS_MESSAGE) as Array<{ sessionId: string; dataJson: string; expiresAt: number }>;

  // 해당 채널의 Anonymous 메시지 찾기
  for (const row of rows) {
    if (row.expiresAt <= Date.now()) {
      deleteSession(row.sessionId, SessionType.ANONYMOUS_MESSAGE);
      continue;
    }

    const data = deserializeSessionData(row.dataJson);
    if (data.channelId === channelId && data.workspaceId === workspaceId && !data.isProcessed) {
      return {
        messageTs: data.messageTs,
        originalQuestionerId: data.originalQuestionerId,
        sessionId: data.sessionId,
        isProcessed: data.isProcessed,
        key: row.sessionId,
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
  const session = getSessionRow(key, SessionType.ANONYMOUS_MESSAGE);

  if (session) {
    session.isProcessed = true;
    storeSessionData(key, session, SessionType.ANONYMOUS_MESSAGE, 7 * 24 * 60 * 60 * 1000);
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
export function getAnonymousThreadInfo(channelId: string, threadTs: string, workspaceId = 'default'): any {
  const key = `${workspaceId}_${channelId}_${threadTs}`;
  const session = getSessionRow(key, SessionType.ANONYMOUS_MESSAGE);

  if (session) {
    if (!session.isProcessed) {
      return {
        messageTs: session.messageTs,
        originalQuestionerId: session.originalQuestionerId,
        sessionId: session.sessionId,
        isProcessed: session.isProcessed,
        key,
      };
    }
  }

  return null;
}
