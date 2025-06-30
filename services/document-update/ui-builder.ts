import type { Block, KnownBlock } from '@slack/web-api';
import { SessionType, getSessionData, storeSessionData } from 'services/common';
import { Logger } from 'services/common/logger';
import { formatSectionPathWithLinks } from 'services/document/section-utils';
import type { ProcessedDocument } from 'services/document/update-processor';
import type { DocumentMetadata } from 'services/vector/types';

export class UIBuilder {
  buildSuggestionBlocks(
    processedDoc: ProcessedDocument,
    currentIndex: number,
    isFirstSuggestion: boolean,
    knowledgeContent: string,
    sessionId?: string,
    knowledgeSourceChannelId?: string,
    knowledgeSourceThreadTs?: string,
    userId?: string,
  ): (KnownBlock | Block)[] {
    const blocks: (KnownBlock | Block)[] = [];

    if (isFirstSuggestion) {
      const headerText = 'Document Update';
      blocks.push({
        type: 'header',
        text: { type: 'plain_text', text: headerText, emoji: true },
      });

      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `*Content:*\n\`\`\`${knowledgeContent}\`\`\`` },
      });

      // 원본 토론 링크 추가
      if (knowledgeSourceChannelId && sessionId) {
        const sessionDataForLink = getSessionData(sessionId, SessionType.DOCUMENT_UPDATE) as any;
        const messageLink = sessionDataForLink?.originalMessageLink;

        if (messageLink) {
          try {
            blocks.push({
              type: 'section',
              text: { type: 'mrkdwn', text: `📍 <${messageLink}|View original discussion> for context` },
            });
          } catch (linkError) {
            Logger.warn('Error adding original discussion link', linkError as Error);
          }
        }
      }
      blocks.push({ type: 'divider' });
    }

    const suggestionNumber = currentIndex + 1;
    const sectionInfo = formatSectionPathWithLinks({
      headingPath: processedDoc.headingPath,
      sectionName: processedDoc.sectionName,
      githubUrl: processedDoc.githubUrl,
    } as DocumentMetadata);

    const suggestionTitleText = `📝 *Update Suggestion ${suggestionNumber}* : <${processedDoc.githubUrl}|${processedDoc.fileName}> - ${sectionInfo}`;

    // CHOIR의 작업별 설명 메시지
    let explanationText = '';
    if (processedDoc.suggestionType === 'APPEND') {
      if (processedDoc.hasChanges) {
        explanationText = `🔍 I found a section that could benefit from additional content based on your knowledge. I'm suggesting we *append new information* to the existing content rather than replacing it, since the current content is still valuable.`;

        if (processedDoc.newSectionSuggestion) {
          explanationText += `\n\n💡 *Bonus idea:* I also think your knowledge would make a great standalone section! If you'd like, I can suggest creating a completely new section instead of appending to the existing one. Just click the "Create New Section" button to see my recommendation!`;
        }
      } else {
        explanationText = `✅ I reviewed this section and it looks good! The existing content already covers what you mentioned, so no changes are needed here.`;

        if (processedDoc.newSectionSuggestion) {
          explanationText += `\n\n💡 *But here's a thought:* Even though this section is already complete, your knowledge might deserve its own dedicated section! I can suggest where and how to create a new section for your content. Check out the "Create New Section" option below!`;
        }
      }
    } else {
      if (processedDoc.hasChanges) {
        explanationText = `📝 I found some content that could be *updated* to better reflect your knowledge. I'm showing you the specific changes I'd recommend - you can see exactly what would be modified.`;
      } else {
        explanationText = `✅ Great news! This section is already up-to-date with your knowledge. I'm showing you the current content so you can verify it covers what you intended.`;
      }
    }

    blocks.push(
      { type: 'section', text: { type: 'mrkdwn', text: suggestionTitleText } },
      { type: 'section', text: { type: 'mrkdwn', text: explanationText } },
      processedDoc.diffBlock,
    );

    return blocks;
  }

  buildActionButtons(
    processedDoc: ProcessedDocument,
    currentIndex: number,
    sessionId?: string,
    knowledgeSourceChannelId?: string,
    knowledgeSourceThreadTs?: string,
    userId?: string,
  ) {
    const editButtonValue = {
      index: currentIndex,
      nodeId: processedDoc.nodeId,
      fileName: processedDoc.fileName,
      suggestionType: processedDoc.suggestionType,
      originalChannelId: knowledgeSourceChannelId,
      originalThreadTs: knowledgeSourceThreadTs,
      sessionId: sessionId,
      ...(processedDoc.suggestionType === 'UPDATE' && {
        nodeContent: processedDoc.nodeContent,
        updatedNodeContent: processedDoc.updatedNodeContent,
      }),
      ...(processedDoc.suggestionType === 'APPEND' && {
        originalLastNodeContent: processedDoc.originalLastNodeContent,
        appendedNodeContent: processedDoc.appendedNodeContent,
      }),
    };

    const updateButtonValue = {
      index: currentIndex + 1,
      action: 'keep',
      sessionId: sessionId,
      currentNodeId: processedDoc.nodeId,
    };

    const cancelButtonValue = {
      userId: userId,
      originalChannelId: knowledgeSourceChannelId,
      originalThreadTs: knowledgeSourceThreadTs,
      index: currentIndex,
      isFirstSuggestion: currentIndex === 0,
      sessionId: sessionId,
      suggestionType: processedDoc.suggestionType,
    };

    const actionButtons = [
      {
        type: 'button' as const,
        text: { type: 'plain_text' as const, text: 'Edit This', emoji: true },
        action_id: 'edit_update',
        value: JSON.stringify(editButtonValue),
      },
      {
        type: 'button' as const,
        text: {
          type: 'plain_text' as const,
          text: processedDoc.hasChanges ? '✅ Apply Changes' : '✅ Looks Good',
          emoji: true,
        },
        style: 'primary' as const,
        action_id: 'suggest_updates',
        value: JSON.stringify(updateButtonValue),
      },
      ...(processedDoc.suggestionType === 'APPEND' && processedDoc.newSectionSuggestion
        ? [
            {
              type: 'button' as const,
              text: { type: 'plain_text' as const, text: '💡 Create New Section', emoji: true },
              action_id: 'create_new_section',
              value: JSON.stringify(
                (() => {
                  const newSectionSessionId = `new_section_${userId}_${Date.now()}`;
                  storeSessionData(
                    newSectionSessionId,
                    {
                      sectionTitle: processedDoc.newSectionSuggestion!.sectionTitle,
                      sectionContent: processedDoc.newSectionSuggestion!.sectionContent,
                      recommendedFile: processedDoc.newSectionSuggestion!.recommendedFile,
                      reasoning: processedDoc.newSectionSuggestion!.reasoning,
                      githubUrl: processedDoc.githubUrl,
                      originalChannelId: knowledgeSourceChannelId,
                      originalThreadTs: knowledgeSourceThreadTs,
                      sessionId: sessionId,
                    },
                    SessionType.NEW_SECTION,
                  );

                  return {
                    newSectionSessionId,
                    userId,
                  };
                })(),
              ),
            },
          ]
        : []),
      {
        type: 'button' as const,
        text: { type: 'plain_text' as const, text: 'Stop Review', emoji: false },
        style: 'danger' as const,
        action_id: 'cancel_document_updates',
        value: JSON.stringify(cancelButtonValue),
      },
    ];

    return actionButtons;
  }
}
