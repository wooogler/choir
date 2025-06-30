import * as fs from 'fs';
import * as path from 'path';

export interface UserInteractionLog {
  timestamp: string;
  userId: string;
  workspaceId: string;
  interactionType: 'message' | 'button_click' | 'modal_submit' | 'command' | 'error';
  action: string;
  channelId: string;
  channelType: 'public' | 'private' | 'dm';
  isThread: boolean;
  processingTime: number;
  success: boolean;
  messageContent?: string;
  metadata: Record<string, any>;
}

export interface LogMetadata {
  messageIntent?: string;
  searchResults?: number;
  canAnswer?: boolean;
  buttonClicked?: string;
  modalAction?: string;
  errorMessage?: string;
  extractedKnowledge?: string;
  managersNotified?: number;
  updateApplied?: boolean;
  sessionId?: string;
  [key: string]: any;
}

class UserInteractionLogger {
  private logDir: string;
  private currentDate: string;

  constructor() {
    this.logDir = path.join(process.cwd(), 'data', 'logs');
    this.currentDate = new Date().toISOString().split('T')[0];
    this.ensureLogDirectory();
  }

  private ensureLogDirectory(): void {
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
  }

  private getLogFilePath(): string {
    return path.join(this.logDir, `user-interactions-${this.currentDate}.jsonl`);
  }

  private updateCurrentDate(): void {
    const today = new Date().toISOString().split('T')[0];
    if (today !== this.currentDate) {
      this.currentDate = today;
    }
  }

  /**
   * 사용자 인터랙션 로그를 저장합니다.
   */
  public logInteraction(
    userId: string,
    workspaceId: string,
    interactionType: UserInteractionLog['interactionType'],
    action: string,
    channelId: string,
    channelType: UserInteractionLog['channelType'],
    isThread: boolean,
    processingTime: number,
    success: boolean,
    messageContent?: string,
    metadata: LogMetadata = {},
  ): void {
    try {
      this.updateCurrentDate();

      const logEntry: UserInteractionLog = {
        timestamp: new Date().toISOString(),
        userId,
        workspaceId,
        interactionType,
        action,
        channelId,
        channelType,
        isThread,
        processingTime,
        success,
        messageContent,
        metadata,
      };

      const logLine = JSON.stringify(logEntry) + '\n';
      fs.appendFileSync(this.getLogFilePath(), logLine);
    } catch (error) {
      console.error('Failed to log user interaction:', error);
    }
  }

  /**
   * 메시지 처리 로그
   */
  public logMessageProcessing(
    userId: string,
    workspaceId: string,
    channelId: string,
    channelType: UserInteractionLog['channelType'],
    isThread: boolean,
    processingTime: number,
    success: boolean,
    messageContent: string,
    messageIntent?: string,
    additionalMetadata: LogMetadata = {},
  ): void {
    this.logInteraction(
      userId,
      workspaceId,
      'message',
      'process_message',
      channelId,
      channelType,
      isThread,
      processingTime,
      success,
      messageContent,
      {
        messageIntent,
        ...additionalMetadata,
      },
    );
  }

  /**
   * 질문 처리 로그
   */
  public logQuestionProcessing(
    userId: string,
    workspaceId: string,
    channelId: string,
    channelType: UserInteractionLog['channelType'],
    isThread: boolean,
    processingTime: number,
    success: boolean,
    messageContent: string,
    searchResults: number,
    canAnswer: boolean,
    additionalMetadata: LogMetadata = {},
  ): void {
    this.logInteraction(
      userId,
      workspaceId,
      'message',
      'process_question',
      channelId,
      channelType,
      isThread,
      processingTime,
      success,
      messageContent,
      {
        messageIntent: 'question',
        searchResults,
        canAnswer,
        ...additionalMetadata,
      },
    );
  }

  /**
   * 업데이트 요청 처리 로그
   */
  public logUpdateRequestProcessing(
    userId: string,
    workspaceId: string,
    channelId: string,
    channelType: UserInteractionLog['channelType'],
    isThread: boolean,
    processingTime: number,
    success: boolean,
    messageContent: string,
    extractedKnowledge: string,
    additionalMetadata: LogMetadata = {},
  ): void {
    this.logInteraction(
      userId,
      workspaceId,
      'message',
      'process_update_request',
      channelId,
      channelType,
      isThread,
      processingTime,
      success,
      messageContent,
      {
        messageIntent: 'update_request',
        extractedKnowledge,
        ...additionalMetadata,
      },
    );
  }

  /**
   * 버튼 클릭 로그
   */
  public logButtonClick(
    userId: string,
    workspaceId: string,
    channelId: string,
    channelType: UserInteractionLog['channelType'],
    buttonAction: string,
    processingTime: number,
    success: boolean,
    additionalMetadata: LogMetadata = {},
  ): void {
    this.logInteraction(
      userId,
      workspaceId,
      'button_click',
      buttonAction,
      channelId,
      channelType,
      false, // 버튼 클릭은 스레드가 아님
      processingTime,
      success,
      undefined,
      {
        buttonClicked: buttonAction,
        ...additionalMetadata,
      },
    );
  }

  /**
   * 모달 제출 로그
   */
  public logModalSubmit(
    userId: string,
    workspaceId: string,
    modalAction: string,
    processingTime: number,
    success: boolean,
    additionalMetadata: LogMetadata = {},
  ): void {
    this.logInteraction(
      userId,
      workspaceId,
      'modal_submit',
      modalAction,
      'modal', // 채널 ID 대신 'modal' 사용
      'dm', // 모달은 DM과 유사
      false,
      processingTime,
      success,
      undefined,
      {
        modalAction,
        ...additionalMetadata,
      },
    );
  }

  /**
   * 에러 로그
   */
  public logError(
    userId: string,
    workspaceId: string,
    channelId: string,
    channelType: UserInteractionLog['channelType'],
    errorMessage: string,
    processingTime: number,
    additionalMetadata: LogMetadata = {},
  ): void {
    this.logInteraction(
      userId,
      workspaceId,
      'error',
      'error_occurred',
      channelId,
      channelType,
      false,
      processingTime,
      false,
      undefined,
      {
        errorMessage,
        ...additionalMetadata,
      },
    );
  }

  /**
   * 지식 추출 로그
   */
  public logKnowledgeExtraction(
    userId: string,
    workspaceId: string,
    channelId: string,
    channelType: UserInteractionLog['channelType'],
    isThread: boolean,
    processingTime: number,
    success: boolean,
    extractedKnowledge: string,
    sourceMessageCount: number,
    additionalMetadata: LogMetadata = {},
  ): void {
    this.logInteraction(
      userId,
      workspaceId,
      'message',
      'extract_knowledge',
      channelId,
      channelType,
      isThread,
      processingTime,
      success,
      undefined,
      {
        extractedKnowledge,
        sourceMessageCount,
        ...additionalMetadata,
      },
    );
  }

  /**
   * 매니저 알림 로그
   */
  public logManagerNotification(
    userId: string,
    workspaceId: string,
    channelId: string,
    channelType: UserInteractionLog['channelType'],
    isThread: boolean,
    processingTime: number,
    success: boolean,
    managersNotified: number,
    sessionId: string,
    additionalMetadata: LogMetadata = {},
  ): void {
    this.logInteraction(
      userId,
      workspaceId,
      'button_click',
      'notify_managers',
      channelId,
      channelType,
      isThread,
      processingTime,
      success,
      undefined,
      {
        managersNotified,
        sessionId,
        ...additionalMetadata,
      },
    );
  }

  /**
   * 문서 업데이트 로그
   */
  public logDocumentUpdate(
    userId: string,
    workspaceId: string,
    channelId: string,
    channelType: UserInteractionLog['channelType'],
    isThread: boolean,
    processingTime: number,
    success: boolean,
    updateApplied: boolean,
    filesUpdated: string[],
    sessionId: string,
    additionalMetadata: LogMetadata = {},
  ): void {
    this.logInteraction(
      userId,
      workspaceId,
      'button_click',
      'apply_document_update',
      channelId,
      channelType,
      isThread,
      processingTime,
      success,
      undefined,
      {
        updateApplied,
        filesUpdated,
        sessionId,
        ...additionalMetadata,
      },
    );
  }

  /**
   * 로그 파일 읽기 (분석용)
   */
  public readLogs(date?: string): UserInteractionLog[] {
    try {
      const targetDate = date || this.currentDate;
      const logFilePath = path.join(this.logDir, `user-interactions-${targetDate}.jsonl`);

      if (!fs.existsSync(logFilePath)) {
        return [];
      }

      const logContent = fs.readFileSync(logFilePath, 'utf-8');
      return logContent
        .trim()
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line));
    } catch (error) {
      console.error('Failed to read logs:', error);
      return [];
    }
  }

  /**
   * 특정 사용자의 로그 조회
   */
  public getUserLogs(userId: string, date?: string): UserInteractionLog[] {
    const allLogs = this.readLogs(date);
    return allLogs.filter((log) => log.userId === userId);
  }

  /**
   * 특정 액션의 로그 조회
   */
  public getActionLogs(action: string, date?: string): UserInteractionLog[] {
    const allLogs = this.readLogs(date);
    return allLogs.filter((log) => log.action === action);
  }

  /**
   * 성공/실패 통계
   */
  public getSuccessStats(date?: string): { success: number; failure: number; total: number } {
    const allLogs = this.readLogs(date);
    const success = allLogs.filter((log) => log.success).length;
    const failure = allLogs.filter((log) => !log.success).length;

    return {
      success,
      failure,
      total: allLogs.length,
    };
  }

  /**
   * 평균 처리 시간
   */
  public getAverageProcessingTime(date?: string): number {
    const allLogs = this.readLogs(date);
    if (allLogs.length === 0) return 0;

    const totalTime = allLogs.reduce((sum, log) => sum + log.processingTime, 0);
    return totalTime / allLogs.length;
  }
}

// 싱글톤 인스턴스 생성
export const userInteractionLogger = new UserInteractionLogger();

// 편의 함수들
export const logMessageProcessing = userInteractionLogger.logMessageProcessing.bind(userInteractionLogger);
export const logQuestionProcessing = userInteractionLogger.logQuestionProcessing.bind(userInteractionLogger);
export const logUpdateRequestProcessing = userInteractionLogger.logUpdateRequestProcessing.bind(userInteractionLogger);
export const logButtonClick = userInteractionLogger.logButtonClick.bind(userInteractionLogger);
export const logModalSubmit = userInteractionLogger.logModalSubmit.bind(userInteractionLogger);
export const logError = userInteractionLogger.logError.bind(userInteractionLogger);
export const logKnowledgeExtraction = userInteractionLogger.logKnowledgeExtraction.bind(userInteractionLogger);
export const logManagerNotification = userInteractionLogger.logManagerNotification.bind(userInteractionLogger);
export const logDocumentUpdate = userInteractionLogger.logDocumentUpdate.bind(userInteractionLogger);
