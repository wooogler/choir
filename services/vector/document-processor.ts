import type { Document } from '@langchain/core/documents';
import { Logger } from 'services/common/logger';
import type { DocumentTree } from 'services/document';
import { preprocessMarkdownForEmbedding } from 'services/document/markdown';
import { createDocumentsFromTree } from 'services/llm';
import { DocumentEnhancer } from 'services/web-content/document-enhancer';
import type { MarkdownFile } from '../github';
import type { DocumentMetadata } from './types';

export class DocumentProcessor {
  /**
   * 마크다운 파일에서 문서 준비
   */
  async prepareDocuments(files: MarkdownFile[]): Promise<Document<DocumentMetadata>[]> {
    try {
      Logger.info(`Preparing documents from ${files.length} markdown files`);

      if (!files || files.length === 0) {
        Logger.debug('No markdown files to process');
        return [];
      }

      let allDocuments: Document<DocumentMetadata>[] = [];

      for (const file of files) {
        if (!file.tree) {
          Logger.warn(`File ${file.name} has no tree structure, skipping`);
          continue;
        }

        Logger.info(`Processing file: ${file.name}`);

        const fileDocuments = createDocumentsFromTree(file.tree, file.name, file.githubUrl);

        if (fileDocuments.length > 0) {
          Logger.info(`Created ${fileDocuments.length} documents from ${file.name}`);
          allDocuments = allDocuments.concat(fileDocuments);
        } else {
          Logger.warn(`No documents generated from ${file.name}`);
        }
      }

      Logger.info(`Total documents prepared: ${allDocuments.length}`);

      // 웹 콘텐츠로 문서 향상
      try {
        const isWebContentEnabled =
          process.env.ENABLE_WEB_CONTENT === 'true';

        if (!isWebContentEnabled) {
          Logger.info(
            `Skipping web content enhancement (NODE_ENV: ${process.env.NODE_ENV}, ENABLE_WEB_CONTENT: ${process.env.ENABLE_WEB_CONTENT})`,
          );
          return allDocuments;
        }

        Logger.info('Starting document enhancement with web content...');
        const enhancer = DocumentEnhancer.getInstance();

        Logger.info(`Documents before enhancement: ${allDocuments.length}`);

        const docsWithUrls = allDocuments.filter(
          (doc) => doc.pageContent && doc.pageContent.match(/https?:\/\/[^\s<>"']+/g),
        );
        Logger.info(`Documents with URLs found: ${docsWithUrls.length}`);

        if (docsWithUrls.length > 0) {
          Logger.info('Sample documents with URLs:');
          docsWithUrls.slice(0, 3).forEach((doc, i) => {
            const urls = doc.pageContent.match(/https?:\/\/[^\s<>"']+/g) || [];
            Logger.info(`  ${i + 1}. ${doc.metadata.nodeId}: ${urls.join(', ')}`);
          });
        }

        const enhancedDocuments = await enhancer.enhanceDocuments(allDocuments);
        Logger.info(`Documents enhanced with web content: ${enhancedDocuments.length} total`);

        const enhancedDocsWithWebContent = enhancedDocuments.filter(
          (doc) => doc.metadata.webSources && doc.metadata.webSources.length > 0,
        );
        Logger.info(`Documents with web content added: ${enhancedDocsWithWebContent.length}`);

        return enhancedDocuments;
      } catch (error) {
        Logger.error('Error enhancing documents with web content', error as Error);
        Logger.info('Proceeding with original documents without web enhancement');
        return allDocuments;
      }
    } catch (error) {
      Logger.error('Error preparing documents', error as Error);
      return [];
    }
  }

  /**
   * 단일 파일에서 문서 생성
   */
  async prepareDocumentsFromSingleFile(file: MarkdownFile): Promise<Document<DocumentMetadata>[]> {
    try {
      if (!file.tree) {
        Logger.warn(`No document tree found for file: ${file.name}`);
        return [];
      }

      const documents = createDocumentsFromTree(file.tree, file.githubUrl, file.name);
      Logger.info(`Generated ${documents.length} documents from ${file.name}`);

      return documents;
    } catch (error) {
      Logger.error(`Error preparing documents from file ${file.name}`, error as Error);
      return [];
    }
  }

  /**
   * 문서들을 임베딩용 텍스트로 변환
   */
  prepareTextsForEmbedding(documents: Document<DocumentMetadata>[]): string[] {
    return documents.map((doc) => {
      const preprocessedContent = preprocessMarkdownForEmbedding(doc.pageContent);
      return preprocessedContent;
    });
  }

  /**
   * 문서 트리 수집
   */
  collectDocumentTrees(markdownFiles: MarkdownFile[]): Map<string, DocumentTree> {
    const documentTrees = new Map<string, DocumentTree>();
    markdownFiles.forEach((file) => {
      if (file.tree) {
        documentTrees.set(file.name, file.tree);
      }
    });
    Logger.info(`Collected ${documentTrees.size} document trees for caching`);
    return documentTrees;
  }
}
