import { Logger } from 'services/common/logger';
import { clearFileSelectionState } from 'services/document/document-store';
import { answerQuestion } from 'services/llm/qa-service';
import { getRetrievalProvider } from 'services/retrieval';
import { getOrganizationDescription, getOrganizationName, getWorkspaceId } from 'services/slack';

export class QuestionProcessor {
  async processQuestion(userMessage: string, historyMessages: any[], client: any, logger: any, userId?: string) {
    try {
      Logger.info(
        `QuestionProcessor: Starting to process question: "${userMessage.substring(0, 50)}${userMessage.length > 50 ? '...' : ''}"`,
      );

      const workspaceId = await getWorkspaceId(client);

      // Q&A 답변 전 document update 캐시 무효화 (최신 정보로 답변하기 위해)
      if (userId) {
        Logger.info(
          `QuestionProcessor: Clearing document update cache for user ${userId} to ensure fresh search results`,
        );
        clearFileSelectionState(userId, workspaceId);
      }

      // Retrieval provider를 통해 관련 문서 가져오기
      const retrievalProvider = getRetrievalProvider();
      Logger.info(`QuestionProcessor: Using retrieval provider "${retrievalProvider.name}"`);

      const relevantDocs = await retrievalProvider.search({
        query: userMessage,
        limit: 5,
        workspaceId,
      });
      Logger.info(`QuestionProcessor: retrieval returned ${relevantDocs.length} documents`);

      // 워크스페이스 정보 가져오기
      let workspaceName = '';
      try {
        const teamInfo = await client.team.info();
        workspaceName = teamInfo.team?.name || '';
      } catch (error) {
        Logger.warn('Could not get workspace name', error as Error);
      }

      // Organization 정보 가져오기
      const organizationName = await getOrganizationName(workspaceId);
      const organizationDescription = await getOrganizationDescription(workspaceId);

      // 응답 생성
      const answerResult = await answerQuestion(
        userMessage,
        historyMessages || [],
        relevantDocs,
        client,
        workspaceName,
        organizationName || undefined,
        organizationDescription || undefined,
        workspaceId,
      );

      return {
        answerResult,
        relevantDocs,
        workspaceId,
        workspaceName,
        organizationName,
        organizationDescription,
      };
    } catch (error) {
      Logger.error('Error processing question', error as Error, {
        userMessage: userMessage.substring(0, 100),
      });
      throw error;
    }
  }
}
