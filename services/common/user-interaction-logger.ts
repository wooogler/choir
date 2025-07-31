import * as fs from 'fs';
import * as path from 'path';
import type { WebClient } from '@slack/web-api';
import { WorkspaceStore } from 'services/workspace/workspace-store';
import { getAllCachedNames } from './name-cache';

export interface UserInteractionLog {
  timestamp: string;
  userId: string;
  userName?: string;
  workspaceId: string;
  workspaceName?: string;
  interactionType: 'message' | 'button_click' | 'modal_submit' | 'app_home_button_click' | 'app_home_modal_submit' | 'command' | 'error';
  action: string;
  channelId: string;
  channelName?: string;
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
  modalContent?: string;
  buttonContent?: string;
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
  public async logInteraction(
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
    names?: {
      userName?: string;
      workspaceName?: string;
      channelName?: string;
    },
  ): Promise<void> {
    try {
      // Check if logging is enabled for this workspace
      const workspaceStore = new WorkspaceStore();
      const loggingEnabled = await workspaceStore.getLoggingEnabled(workspaceId);

      if (!loggingEnabled) {
        return; // Skip logging if disabled
      }

      this.updateCurrentDate();

      const logEntry: UserInteractionLog = {
        timestamp: new Date().toISOString(),
        interactionType,
        action,
        userId,
        userName: names?.userName,
        workspaceId,
        workspaceName: names?.workspaceName,
        channelId,
        channelName: names?.channelName,
        channelType,
        isThread,
        processingTime,
        success,
        messageContent,
        metadata,
      };

      const logLine = JSON.stringify(logEntry) + '\n';
      const logFilePath = this.getLogFilePath();
      console.log(`[DEBUG] Writing log to file: ${logFilePath}, action: ${logEntry.action}`);
      fs.appendFileSync(logFilePath, logLine);
    } catch (error) {
      console.error('Failed to log user interaction:', error);
    }
  }

  /**
   * 메시지 처리 로그
   */
  public async logMessageProcessing(
    userId: string,
    workspaceId: string,
    channelId: string,
    channelType: UserInteractionLog['channelType'],
    isThread: boolean,
    processingTime: number,
    success: boolean,
    messageContent: string,
    action: string,
    additionalMetadata: LogMetadata = {},
    client?: WebClient,
  ): Promise<void> {
    try {
      if (client) {
        const names = await getAllCachedNames(userId, workspaceId, channelId, client);
        await this.logInteraction(
          userId,
          workspaceId,
          'message',
          action,
          channelId,
          channelType,
          isThread,
          processingTime,
          success,
          messageContent,
          additionalMetadata,
          names,
        );
      } else {
        await this.logInteraction(
          userId,
          workspaceId,
          'message',
          action,
          channelId,
          channelType,
          isThread,
          processingTime,
          success,
          messageContent,
          additionalMetadata,
        );
      }
    } catch (error) {
      console.warn('Error getting names for message processing logging, falling back to basic logging:', error);
      await this.logInteraction(
        userId,
        workspaceId,
        'message',
        action,
        channelId,
        channelType,
        isThread,
        processingTime,
        success,
        messageContent,
        additionalMetadata,
      );
    }
  }

  /**
   * 질문 처리 로그
   */
  public async logQuestionProcessing(
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
    client?: WebClient,
  ): Promise<void> {
    try {
      if (client) {
        const names = await getAllCachedNames(userId, workspaceId, channelId, client);
        await this.logInteraction(
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
          names,
        );
      } else {
        await this.logInteraction(
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
    } catch (error) {
      console.warn('Error getting names for question processing logging, falling back to basic logging:', error);
      await this.logInteraction(
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
  }

  /**
   * 업데이트 요청 처리 로그
   */
  public async logUpdateRequestProcessing(
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
    client?: WebClient,
  ): Promise<void> {
    try {
      if (client) {
        const names = await getAllCachedNames(userId, workspaceId, channelId, client);
        await this.logInteraction(
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
          names,
        );
      } else {
        await this.logInteraction(
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
    } catch (error) {
      console.warn('Error getting names for update request processing logging, falling back to basic logging:', error);
      await this.logInteraction(
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
  }

  /**
   * 버튼 클릭 로그
   */
  public async logButtonClick(
    userId: string,
    workspaceId: string,
    channelId: string,
    channelType: UserInteractionLog['channelType'],
    buttonAction: string,
    processingTime: number,
    success: boolean,
    additionalMetadata: LogMetadata = {},
    client?: WebClient,
  ): Promise<void> {
    console.log(`[DEBUG] logButtonClick called:`, { userId, workspaceId, buttonAction, success });
    try {
      if (client) {
        const names = await getAllCachedNames(userId, workspaceId, channelId, client);
        await this.logInteraction(
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
          names,
        );
      } else {
        await this.logInteraction(
          userId,
          workspaceId,
          'button_click',
          buttonAction,
          channelId,
          channelType,
          false,
          processingTime,
          success,
          undefined,
          {
            buttonClicked: buttonAction,
            ...additionalMetadata,
          },
        );
      }
    } catch (error) {
      console.warn('Error getting names for button click logging, falling back to basic logging:', error);
      await this.logInteraction(
        userId,
        workspaceId,
        'button_click',
        buttonAction,
        channelId,
        channelType,
        false,
        processingTime,
        success,
        undefined,
        {
          buttonClicked: buttonAction,
          ...additionalMetadata,
        },
      );
    }
  }

  /**
   * 모달 제출 로그
   */
  public async logModalSubmit(
    userId: string,
    workspaceId: string,
    modalAction: string,
    processingTime: number,
    success: boolean,
    additionalMetadata: LogMetadata = {},
    client?: WebClient,
    channelId?: string,
    channelType?: UserInteractionLog['channelType'],
  ): Promise<void> {
    try {
      const actualChannelId = channelId || 'modal';
      const actualChannelType = channelType || 'dm';

      if (client) {
        const names = await getAllCachedNames(userId, workspaceId, actualChannelId, client);
        await this.logInteraction(
          userId,
          workspaceId,
          'modal_submit',
          modalAction,
          actualChannelId,
          actualChannelType,
          false,
          processingTime,
          success,
          undefined,
          {
            modalAction,
            ...additionalMetadata,
          },
          names,
        );
      } else {
        await this.logInteraction(
          userId,
          workspaceId,
          'modal_submit',
          modalAction,
          actualChannelId,
          actualChannelType,
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
    } catch (error) {
      console.warn('Error getting names for modal submit logging, falling back to basic logging:', error);
      const actualChannelId = channelId || 'modal';
      const actualChannelType = channelType || 'dm';
      await this.logInteraction(
        userId,
        workspaceId,
        'modal_submit',
        modalAction,
        actualChannelId,
        actualChannelType,
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
  }

  /**
   * 에러 로그
   */
  public async logError(
    userId: string,
    workspaceId: string,
    channelId: string,
    channelType: UserInteractionLog['channelType'],
    errorMessage: string,
    processingTime: number,
    additionalMetadata: LogMetadata = {},
    client?: WebClient,
  ): Promise<void> {
    try {
      if (client) {
        const names = await getAllCachedNames(userId, workspaceId, channelId, client);
        await this.logInteraction(
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
          names,
        );
      } else {
        await this.logInteraction(
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
    } catch (error) {
      console.warn('Error getting names for error logging, falling back to basic logging:', error);
      await this.logInteraction(
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
  }

  /**
   * 지식 추출 로그
   */
  public async logKnowledgeExtraction(
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
    client?: WebClient,
  ): Promise<void> {
    try {
      if (client) {
        const names = await getAllCachedNames(userId, workspaceId, channelId, client);
        await this.logInteraction(
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
          names,
        );
      } else {
        await this.logInteraction(
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
    } catch (error) {
      console.warn('Error getting names for knowledge extraction logging, falling back to basic logging:', error);
      await this.logInteraction(
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
  }

  /**
   * 매니저 알림 로그
   */
  public async logManagerNotification(
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
    client?: WebClient,
  ): Promise<void> {
    try {
      if (client) {
        const names = await getAllCachedNames(userId, workspaceId, channelId, client);
        await this.logInteraction(
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
          names,
        );
      } else {
        await this.logInteraction(
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
    } catch (error) {
      console.warn('Error getting names for manager notification logging, falling back to basic logging:', error);
      await this.logInteraction(
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
  }

  /**
   * 문서 업데이트 로그
   */
  public async logDocumentUpdate(
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
    client?: WebClient,
  ): Promise<void> {
    try {
      if (client) {
        const names = await getAllCachedNames(userId, workspaceId, channelId, client);
        await this.logInteraction(
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
          names,
        );
      } else {
        await this.logInteraction(
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
    } catch (error) {
      console.warn('Error getting names for document update logging, falling back to basic logging:', error);
      await this.logInteraction(
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
  }

  /**
   * App Home 버튼 클릭 로그 (content 포함)
   */
  public async logAppHomeButtonClick(
    userId: string,
    workspaceId: string,
    buttonAction: string,
    processingTime: number,
    success: boolean,
    buttonContent?: string,
    additionalMetadata: LogMetadata = {},
    client?: WebClient,
  ): Promise<void> {
    console.log(`[DEBUG] logAppHomeButtonClick called:`, { userId, workspaceId, buttonAction, success });
    try {
      if (client) {
        const names = await getAllCachedNames(userId, workspaceId, 'app_home', client);
        await this.logInteraction(
          userId,
          workspaceId,
          'app_home_button_click',
          buttonAction,
          'app_home',
          'dm',
          false,
          processingTime,
          success,
          undefined,
          {
            buttonClicked: buttonAction,
            buttonContent,
            ...additionalMetadata,
          },
          names,
        );
      } else {
        await this.logInteraction(
          userId,
          workspaceId,
          'app_home_button_click',
          buttonAction,
          'app_home',
          'dm',
          false,
          processingTime,
          success,
          undefined,
          {
            buttonClicked: buttonAction,
            buttonContent,
            ...additionalMetadata,
          },
        );
      }
    } catch (error) {
      console.warn('Error getting names for app home button click logging, falling back to basic logging:', error);
      await this.logInteraction(
        userId,
        workspaceId,
        'app_home_button_click',
        buttonAction,
        'app_home',
        'dm',
        false,
        processingTime,
        success,
        undefined,
        {
          buttonClicked: buttonAction,
          buttonContent,
          ...additionalMetadata,
        },
      );
    }
  }

  /**
   * App Home 모달 제출 로그 (content 포함)
   */
  public async logAppHomeModalSubmit(
    userId: string,
    workspaceId: string,
    modalAction: string,
    processingTime: number,
    success: boolean,
    modalContent?: string,
    additionalMetadata: LogMetadata = {},
    client?: WebClient,
  ): Promise<void> {
    try {
      if (client) {
        const names = await getAllCachedNames(userId, workspaceId, 'app_home', client);
        await this.logInteraction(
          userId,
          workspaceId,
          'app_home_modal_submit',
          modalAction,
          'app_home',
          'dm',
          false,
          processingTime,
          success,
          undefined,
          {
            modalAction,
            modalContent,
            ...additionalMetadata,
          },
          names,
        );
      } else {
        await this.logInteraction(
          userId,
          workspaceId,
          'app_home_modal_submit',
          modalAction,
          'app_home',
          'dm',
          false,
          processingTime,
          success,
          undefined,
          {
            modalAction,
            modalContent,
            ...additionalMetadata,
          },
        );
      }
    } catch (error) {
      console.warn('Error getting names for app home modal submit logging, falling back to basic logging:', error);
      await this.logInteraction(
        userId,
        workspaceId,
        'app_home_modal_submit',
        modalAction,
        'app_home',
        'dm',
        false,
        processingTime,
        success,
        undefined,
        {
          modalAction,
          modalContent,
          ...additionalMetadata,
        },
      );
    }
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

// 편의 함수들 (기존 호환성)
export const logMessageProcessing = userInteractionLogger.logMessageProcessing.bind(userInteractionLogger);
export const logQuestionProcessing = userInteractionLogger.logQuestionProcessing.bind(userInteractionLogger);
export const logUpdateRequestProcessing = userInteractionLogger.logUpdateRequestProcessing.bind(userInteractionLogger);
export const logButtonClick = userInteractionLogger.logButtonClick.bind(userInteractionLogger);
export const logModalSubmit = userInteractionLogger.logModalSubmit.bind(userInteractionLogger);
export const logError = userInteractionLogger.logError.bind(userInteractionLogger);
export const logKnowledgeExtraction = userInteractionLogger.logKnowledgeExtraction.bind(userInteractionLogger);
export const logManagerNotification = userInteractionLogger.logManagerNotification.bind(userInteractionLogger);
export const logDocumentUpdate = userInteractionLogger.logDocumentUpdate.bind(userInteractionLogger);

// App Home 전용 로깅 함수들
export const logAppHomeButtonClick = userInteractionLogger.logAppHomeButtonClick.bind(userInteractionLogger);
export const logAppHomeModalSubmit = userInteractionLogger.logAppHomeModalSubmit.bind(userInteractionLogger);

// 새로운 캐시된 이름 포함 로깅 함수들
export const logInteractionWithNames = userInteractionLogger.logInteraction.bind(userInteractionLogger);
