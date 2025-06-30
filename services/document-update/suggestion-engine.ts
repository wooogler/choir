import { Logger } from 'services/common/logger';
import { type ProcessedDocument, processDocument } from 'services/document/update-processor';
import type { SlackMessage } from 'services/slack';
import { checkVectorStoreHealth } from 'services/vector/health-check';
import { VectorStoreService } from 'services/vector/main-service';

export class SuggestionEngine {
  async processDocumentSuggestion(
    knowledgeContent: string,
    validMessages: SlackMessage[],
    currentIndex: number,
    searchResults: any[],
    client: any,
    currentDmChannelId: string,
  ): Promise<{ processedDoc: ProcessedDocument | null; shouldStop: boolean }> {
    try {
      // 벡터 스토어 건강 상태 확인
      const healthCheckResult = await checkVectorStoreHealth(client, currentDmChannelId);
      if (!healthCheckResult.isHealthy) {
        if (healthCheckResult.blocks) {
          await client.chat.postMessage({
            channel: currentDmChannelId,
            blocks: healthCheckResult.blocks,
          });
        } else if (healthCheckResult.message) {
          await client.chat.postMessage({
            channel: currentDmChannelId,
            text: healthCheckResult.message,
          });
        }
        return { processedDoc: null, shouldStop: true };
      }

      // 검색 결과가 없는 경우
      if (currentIndex >= searchResults.length) {
        await client.chat.postMessage({
          channel: currentDmChannelId,
          text: "🎉 Perfect! We've reviewed all the relevant documents. Thanks for working with me to keep your documentation up-to-date! \n\nIf you have more knowledge to share later, just mention me and I'll be happy to help review and update the docs again. Have a great day! 👋",
          unfurl_links: false,
          unfurl_media: false,
        });
        return { processedDoc: null, shouldStop: true };
      }

      const vectorStore = VectorStoreService.getInstance();
      const currentDoc = searchResults[currentIndex];
      const processedDoc: ProcessedDocument | null = await processDocument(
        currentDoc,
        knowledgeContent,
        validMessages,
        client,
        vectorStore,
      );

      if (!processedDoc) {
        await client.chat.postMessage({
          channel: currentDmChannelId,
          text: '❌ Error processing document. Skipping to next.',
        });
        return { processedDoc: null, shouldStop: true };
      }

      Logger.info('Document suggestion processed successfully', {
        fileName: processedDoc.fileName,
        hasChanges: processedDoc.hasChanges,
        suggestionType: processedDoc.suggestionType,
      });

      return { processedDoc, shouldStop: false };
    } catch (error) {
      Logger.error('Error processing document suggestion', error as Error);
      return { processedDoc: null, shouldStop: true };
    }
  }

  async performInitialSearch(knowledgeContent: string, currentDmChannelId: string, client: any): Promise<any[]> {
    try {
      const vectorStore = VectorStoreService.getInstance();
      const searchResults = await vectorStore.similaritySearch(knowledgeContent, 5);

      if (!searchResults || searchResults.length === 0) {
        await client.chat.postMessage({
          channel: currentDmChannelId,
          text: 'No relevant documents found for the extracted knowledge. Please try with different knowledge or contact an administrator.',
        });
        return [];
      }

      Logger.info(`Found ${searchResults.length} relevant documents for suggestion`);
      return searchResults;
    } catch (error) {
      Logger.error('Error performing initial search', error as Error);
      return [];
    }
  }
}
