import { Logger } from 'services/common/logger';
import { answerQuestion } from 'services/llm/qa-service';
import { getOrganizationDescription, getOrganizationName, getWorkspaceId } from 'services/slack';
import { VectorStoreService } from 'services/vector/main-service';
import { DocumentEnhancer } from 'services/web-content/document-enhancer';

export class QuestionProcessor {
  async processQuestion(userMessage: string, historyMessages: any[], client: any, logger: any) {
    try {
      Logger.info(`QuestionProcessor: Starting to process question: "${userMessage.substring(0, 50)}${userMessage.length > 50 ? '...' : ''}"`);
      
      // 벡터 스토어에서 관련 문서 가져오기
      const vectorStore = VectorStoreService.getInstance();
      Logger.info('QuestionProcessor: Got VectorStoreService instance, calling similaritySearch...');
      
      let relevantDocs = await vectorStore.similaritySearch(userMessage, 5);
      Logger.info(`QuestionProcessor: similaritySearch returned ${relevantDocs.length} documents`);

      // 웹 콘텐츠가 있는 문서들의 pageContent를 확장
      relevantDocs = relevantDocs.map((doc) => {
        if (doc.metadata.webContent && doc.metadata.webContent.length > 0) {
          const enhancedContent = DocumentEnhancer.getFullContentForSearch(doc);
          return {
            ...doc,
            pageContent: enhancedContent,
          };
        }
        return doc;
      });

      // 워크스페이스 정보 가져오기
      let workspaceName = '';
      try {
        const teamInfo = await client.team.info();
        workspaceName = teamInfo.team?.name || '';
      } catch (error) {
        Logger.warn('Could not get workspace name', error as Error);
      }

      // Organization 정보 가져오기
      const workspaceId = await getWorkspaceId(client);
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
