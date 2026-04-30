import type { Document } from '@langchain/core/documents';
import { Logger } from 'services/common/logger';
import type { DocumentTree } from 'services/document';
import { preprocessMarkdownForEmbedding } from 'services/document/markdown';
import { createDocumentsFromTree } from 'services/llm';
import type { MarkdownFile } from '../github';
import type { DocumentMetadata } from './types';

export class DocumentProcessor {
  async prepareDocuments(files: MarkdownFile[]): Promise<Document<DocumentMetadata>[]> {
    try {
      Logger.info(`Preparing documents from ${files.length} markdown files`);

      if (!files || files.length === 0) {
        return [];
      }

      let allDocuments: Document<DocumentMetadata>[] = [];

      for (const file of files) {
        if (!file.tree) {
          Logger.warn(`File ${file.name} has no tree structure, skipping`);
          continue;
        }

        const fileDocuments = createDocumentsFromTree(file.tree, file.name, file.githubUrl);

        if (fileDocuments.length > 0) {
          allDocuments = allDocuments.concat(fileDocuments);
        }
      }

      Logger.info(`Total documents prepared: ${allDocuments.length}`);
      return allDocuments;
    } catch (error) {
      Logger.error('Error preparing documents', error as Error);
      return [];
    }
  }

  prepareTextsForEmbedding(documents: Document<DocumentMetadata>[]): string[] {
    return documents.map((doc) => preprocessMarkdownForEmbedding(doc.pageContent));
  }

  collectDocumentTrees(markdownFiles: MarkdownFile[]): Map<string, DocumentTree> {
    const documentTrees = new Map<string, DocumentTree>();
    for (const file of markdownFiles) {
      if (file.tree) {
        documentTrees.set(file.name, file.tree);
      }
    }
    return documentTrees;
  }
}
