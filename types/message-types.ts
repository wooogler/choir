/**
 * CHOIR 메시지 타입 정의
 * 
 * 이 enum은 CHOIR 봇이 생성하는 모든 메시지의 유형을 분류하여
 * 대화 히스토리 처리, 메시지 필터링, 세션 관리 등에 활용됩니다.
 */
export enum CHOIRMessageType {
  // ===== 처리 상태 메시지 =====
  
  /** 
   * 로딩/처리 중 메시지
   * 사용자 요청 처리 시작 시 표시하는 상태 메시지
   * 예: "🤔 Let me think about...", "Searching relevant documents..."
   * 대화 히스토리에서 제외됨
   */
  LOADING = 'loading',
  
  /** 
   * 진행 상태 업데이트 메시지
   * 처리 과정 중 진행 상황을 알리는 중간 상태 메시지
   * 예: "Processing... (Buttons removed)", "✅ Got it! I've processed..."
   * 대화 히스토리에서 제외됨
   */
  STATUS_UPDATE = 'status_update',
  
  // ===== 핵심 응답 메시지 =====
  
  /** 
   * 일반 대화 응답 메시지
   * 질문이 아닌 일반 대화, 인사, 확인 등의 응답
   * 예: 일반 대화 응답, 확인 메시지
   * 대화 히스토리에 포함됨
   */
  RESPONSE = 'response',
  
  /**
   * 질문에 대한 답변 메시지
   * 사용자 질문에 대한 구체적인 답변 응답
   * 예: Q&A 답변, 정보 제공 응답
   * 대화 히스토리에 포함됨
   */
  ANSWER = 'answer',
  
  /** 
   * 작업 완료 확인 메시지
   * 문서 업데이트, GitHub 커밋 등 작업 성공 알림
   * 예: "🎉 Perfect! We've reviewed all...", "✅ Great news! I've successfully updated..."
   * 대화 히스토리에 포함됨
   */
  SUCCESS = 'success',
  
  /** 
   * 오류 및 실패 메시지
   * 처리 실패, 권한 오류, 시스템 문제 등 오류 상황 알림
   * 예: "Sorry, an error occurred...", "❌ Error processing document..."
   * 대화 히스토리에 포함됨
   */
  ERROR = 'error',
  
  // ===== 상호작용 메시지 =====
  
  /** 
   * 사용자 개별 도움말 메시지 (ephemeral)
   * 개인에게만 보이는 가이드, 버튼 옵션 등
   * 예: 팔로우업 액션 버튼, 개인 설정 관련 안내
   * 대화 히스토리에서 제외됨
   */
  EPHEMERAL_HELPER = 'ephemeral_helper',
  
  /** 
   * 문서 업데이트 제안 메시지
   * 문서 변경 사항 제안 및 diff 표시, 액션 버튼 포함
   * 예: GitHub diff 표시, "Apply Changes" 버튼이 있는 복잡한 블록
   * 대화 히스토리에 포함됨
   */
  DOCUMENT_SUGGESTION = 'document_suggestion',
  
  /** 
   * 알림 및 피드백 메시지
   * 사용자 액션에 대한 피드백, 워크플로우 상태 변경 알림
   * 예: "📝 user clarified this was a suggestion...", "🤔 user let me know this was actually a question..."
   * 대화 히스토리에 포함됨
   */
  NOTIFICATION = 'notification',
  
  /** 
   * 익명 질문 메시지
   * "Ask in Private"에서 "Share anonymously" 옵션으로 생성된 메시지
   * Manager들에게 익명으로 공유되는 Q&A 메시지
   * 대화 히스토리에서 제외됨 (thread replies에 CHOIR가 반응하지 않음)
   */
  ANONYMOUS_QUESTION = 'anonymous_question',

  /** 
   * Q&A 공유 메시지
   * 질문을 채널에 공유할 때의 인사말/소개 메시지
   * 예: "Hi, #채널명\n사용자가 질문했고 제가 답변했습니다"
   * 대화 히스토리에서 세션 구분점 역할 (이 메시지부터 새로운 세션 시작)
   */
  QA_SHARE_INTRO = 'qa_share_intro',
  
  // ===== 시스템 관리 메시지 =====
  
  /** 
   * 권한 및 접근 제어 메시지
   * 비인가 사용자 안내, 권한 관련 문제 알림
   * 예: 동의서 링크, CHOIR 사용자가 아닌 경우 안내
   * 대화 히스토리에서 제외됨
   */
  AUTHORIZATION = 'authorization',
  
  /** 
   * 시스템 상태 점검 메시지
   * 벡터 스토어 문제, 진단 정보 등 시스템 관련 알림
   * 예: "⚠️ 벡터 스토어에 문제가 발견되었습니다...", 진단 정보 + 액션 버튼
   * 대화 히스토리에서 제외됨
   */
  HEALTH_CHECK = 'health_check',
  
  // ===== 특수 작업 메시지 =====
  
  /** 
   * 메시지 업데이트 (chat.update)
   * 기존 메시지 내용 변경 시 사용
   * 예: 로딩 메시지를 최종 응답으로 업데이트
   * 원본 메시지 타입에 따라 히스토리 포함 여부 결정
   */
  MESSAGE_UPDATE = 'message_update',
  
  /** 
   * 메시지 삭제 (chat.delete)
   * 임시 메시지 삭제 등
   * 대화 히스토리에서 제외됨
   */
  MESSAGE_DELETE = 'message_delete'
}

/**
 * 대화 히스토리에서 제외할 메시지 타입들
 */
export const EXCLUDE_FROM_HISTORY: CHOIRMessageType[] = [
  CHOIRMessageType.LOADING,
  CHOIRMessageType.STATUS_UPDATE,
  CHOIRMessageType.EPHEMERAL_HELPER,
  CHOIRMessageType.AUTHORIZATION,
  CHOIRMessageType.HEALTH_CHECK,
  CHOIRMessageType.MESSAGE_DELETE,
  CHOIRMessageType.NOTIFICATION, // 공유/알림 메시지도 제외
  CHOIRMessageType.ERROR,
];

/**
 * 세션 종료를 나타내는 메시지 타입들
 */
export const SESSION_END_TYPES: CHOIRMessageType[] = [
  
  CHOIRMessageType.RESPONSE,
  CHOIRMessageType.SUCCESS,
];

/**
 * 세션 시작을 나타내는 메시지 타입들
 * 해당 메시지부터 (포함하여) 새로운 세션이 시작됨
 */
export const SESSION_START_TYPES: CHOIRMessageType[] = [
  CHOIRMessageType.ANONYMOUS_QUESTION, // 익명 질문이 새로운 세션의 시작
  CHOIRMessageType.QA_SHARE_INTRO,     // Q&A 공유 인사말이 새로운 세션의 시작
  CHOIRMessageType.DOCUMENT_SUGGESTION,
];

/**
 * 메시지 메타데이터 인터페이스
 */
export interface CHOIRMessageMetadata {
  messageType?: CHOIRMessageType;
  sessionId?: string;
  userId?: string;
  timestamp?: number;
}

/**
 * CHOIR 메시지 타입을 block_id로 생성하는 헬퍼 함수
 */
export function createCHOIRBlockId(messageType: CHOIRMessageType, suffix?: string): string {
  const timestamp = Date.now();
  return `choir_${messageType}${suffix ? `_${suffix}` : ''}_${timestamp}`;
}

/**
 * block_id에서 CHOIR 메시지 타입을 추출하는 헬퍼 함수
 */
export function extractCHOIRMessageType(blockId: string): CHOIRMessageType | null {
  const match = blockId.match(/^choir_([a-z_]+)(?:_.*)?_\d+$/);
  if (!match) {
    console.log(`⚠️ [DEBUG] Invalid block_id format: ${blockId}`);
    return null;
  }
  
  const typeString = match[1];
  const isValidType = Object.values(CHOIRMessageType).includes(typeString as CHOIRMessageType);
  
  if (!isValidType) {
    console.log(`⚠️ [DEBUG] Invalid message type extracted: ${typeString} from ${blockId}`);
    return null;
  }
  
  return typeString as CHOIRMessageType;
}

/**
 * 메시지의 blocks에서 CHOIR 메시지 타입을 추출하는 헬퍼 함수
 */
export function getCHOIRMessageTypeFromBlocks(blocks: any[]): CHOIRMessageType | null {
  if (!blocks || blocks.length === 0) return null;
  
  for (const block of blocks) {
    if (block.block_id && block.block_id.startsWith('choir_')) {
      const messageType = extractCHOIRMessageType(block.block_id);
      if (messageType) return messageType;
      // 디버깅: CHOIR block_id가 있는데 타입 추출 실패
      else {
        console.log(`⚠️ [DEBUG] Failed to extract type from block_id: ${block.block_id}`);
      }
    }
  }
  
  return null;
}