import type { WebClient } from '@slack/web-api';
import { anonymizeText } from 'services/common/name-cache';
import type { SlackMessage } from 'services/slack';
import { processMessageHistory } from 'services/slack/conversation-history';
import { CHOIRMessageType, getCHOIRMessageTypeFromBlocks } from 'types/message-types';
import { type ChatCompletionOptions, createChatCompletion } from './completions';

interface KnowledgeExtractionResult {
  cleanContent: string;
  processedMessages: Array<{ role: string; content: string }>; // Add processed messages for View Messages
}

interface OrganizationalContext {
  organizationName?: string;
  organizationDescription?: string;
  isUserManager?: boolean;
  managerText?: string;
  channelType?: string;
  extractorName?: string;
}

/**
 * Extract knowledge from a collection of Slack messages
 */

// Extract user comment text from USER_COMMENT blocks
function extractUserCommentFromBlocks(blocks: any[]): string | null {
  if (!blocks || blocks.length === 0) return null;

  for (const block of blocks) {
    if (block.block_id?.includes('user_comment') && block.type === 'section' && block.text?.text) {
      return block.text.text;
    }
  }

  return null;
}

// Helper function to extract the most recent Q&A pair from regular CHOIR answers
function extractLatestCHOIRAnswer(
  messages: SlackMessage[],
  processedMessages: Array<{ role: string; content: string }>,
): { question: string; answer: string; source: 'choir_answer' } | null {
  // Search from the end to find the most recent CHOIR answer
  for (let i = messages.length - 1; i >= 0; i--) {
    const originalMsg = messages[i];
    const processedMsg = processedMessages[i];

    // Check if this is a CHOIR answer message
    const messageType = getCHOIRMessageTypeFromBlocks(originalMsg.blocks || []) || originalMsg.metadata?.messageType;

    if (messageType === CHOIRMessageType.ANSWER && processedMsg.role === 'CHOIR') {
      // Look for the preceding user question
      for (let j = i - 1; j >= 0; j--) {
        const prevProcessedMsg = processedMessages[j];
        if (prevProcessedMsg.role !== 'CHOIR') {
          // Found a user message before the CHOIR answer
          const question = prevProcessedMsg.content.replace('@CHOIR', '').trim();
          const answer = processedMsg.content.trim();

          return {
            question,
            answer,
            source: 'choir_answer',
          };
        }
      }
    }
  }

  return null;
}

// Helper function to extract Q&A content from QA_SHARE_INTRO messages
function extractQAContent(
  messageText: string,
  canAnswer: boolean,
): { question: string; answer: string | null; canAnswer: boolean } | null {
  // Updated regex to handle both old format (with ```) and new format (without ```)
  const questionMatch = messageText.match(/\*Question:\*\s*(?:```([^`]+)```|([^\n]+(?:\n(?!\*)[^\n]*)*?))/);

  if (questionMatch) {
    const question = (questionMatch[1] || questionMatch[2] || '').trim();

    if (canAnswer) {
      // For answered questions, extract the response - also handle both formats
      const responseMatch = messageText.match(/\*My response:\*\s*(?:```([^`]+)```|([^\n]+(?:\n(?!\*)[^\n]*)*?))/);
      if (responseMatch) {
        return {
          question,
          answer: (responseMatch[1] || responseMatch[2] || '').trim(),
          canAnswer: true,
        };
      }
    } else {
      // For unanswered questions, no response expected
      return {
        question,
        answer: null,
        canAnswer: false,
      };
    }
  }

  return null;
}

export async function extractKnowledgeFromMessages(
  messages: SlackMessage[],
  context?: OrganizationalContext,
  client?: WebClient,
  workspaceId?: string,
): Promise<KnowledgeExtractionResult> {
  try {
    // Use processMessageHistory to format messages with user names (anonymization applied later in completions.ts)
    const processedMessages = await processMessageHistory(messages, client);

    // Separate Q&A content from regular conversation
    const qaContent: Array<{ question: string; answer: string | null; canAnswer: boolean }> = [];
    const conversationMessages: Array<{ role: string; content: string }> = [];

    // Extract the most recent CHOIR answer for context
    const latestCHOIRAnswer = extractLatestCHOIRAnswer(messages, processedMessages);

    // Find the index of the latest CHOIR answer message to exclude it and preceding messages
    let conversationStartIndex = 0;
    if (latestCHOIRAnswer) {
      // Find the index of the CHOIR answer message
      for (let i = messages.length - 1; i >= 0; i--) {
        const originalMsg = messages[i];
        const messageType =
          getCHOIRMessageTypeFromBlocks(originalMsg.blocks || []) || originalMsg.metadata?.messageType;

        if (messageType === CHOIRMessageType.ANSWER && processedMessages[i].role === 'CHOIR') {
          conversationStartIndex = i + 1; // Start after the CHOIR answer
          break;
        }
      }
    }

    for (let i = 0; i < processedMessages.length; i++) {
      const msg = processedMessages[i];
      const originalMsg = messages[i];

      // Check if this is a QA_SHARE_INTRO message (answered or unanswered)
      const isQAShareAnswered =
        originalMsg.metadata?.messageType === 'qa_share_intro_answered' ||
        originalMsg.blocks?.some((block: any) => block.block_id?.includes('qa_share_intro_answered'));

      const isQAShareUnanswered =
        originalMsg.metadata?.messageType === 'qa_share_intro_unanswered' ||
        originalMsg.blocks?.some((block: any) => block.block_id?.includes('qa_share_intro_unanswered'));

      // Check if this message has a USER_COMMENT block
      const hasUserComment = originalMsg.blocks?.some((block: any) => block.block_id?.includes('user_comment'));

      // Handle Q&A SHARE messages (these should be excluded from conversation)
      if ((isQAShareAnswered || isQAShareUnanswered) && msg.role === 'CHOIR') {
        // Extract Q&A content for context
        const canAnswer = isQAShareAnswered;
        const extracted = extractQAContent(msg.content, canAnswer);
        if (extracted) {
          qaContent.push(extracted);
        }

        // If there's also a user comment in this message, extract it using block content
        if (hasUserComment && originalMsg.blocks) {
          const userCommentText = extractUserCommentFromBlocks(originalMsg.blocks);
          if (userCommentText) {
            const commentMatch = userCommentText.match(/\*(.+?) added:\*\n([\s\S]*)/);
            if (commentMatch) {
              // Remove any markdown formatting from username (e.g., *Bob* -> Bob)
              const userName = commentMatch[1].replace(/^\*|\*$/g, '');
              const comment = commentMatch[2].trim();
              if (comment) {
                // Only add if comment is not empty
                conversationMessages.push({
                  role: 'user',
                  content: `${userName}: ${comment}`, // Format same as other user messages
                });
              }
            } else {
              // Debug: log when comment pattern doesn't match
              console.log('DEBUG: User comment block found but pattern did not match');
              console.log('User comment block text:', userCommentText);
            }
          }
        }

        // Skip adding the Q&A share message itself to conversation
        continue;
      }

      // Only include messages after the latest CHOIR answer in conversation
      if (i >= conversationStartIndex) {
        conversationMessages.push(msg);
      }
    }

    // Format conversation messages with numbered references for source tracking
    const formattedMessages = conversationMessages.map((msg, index) => `[${index + 1}] ${msg.content}`).join('\n');

    // Build organizational context section
    let contextSection = '';
    if (context) {
      contextSection = '\n**Organizational Context**:\n';
      if (context.organizationName) {
        contextSection += `- Organization: ${context.organizationName}\n`;
      }
      if (context.managerText) {
        // Anonymize manager names and format properly
        const anonymizedManagerText = anonymizeText(context.managerText);
        contextSection += `- Managers: ${anonymizedManagerText}\n`;
      }
      if (context.isUserManager !== undefined) {
        contextSection += `- Extraction requested by: ${context.isUserManager ? 'Manager' : 'Team Member'}\n`;
      }
      contextSection += '\n';
    }

    // Add Q&A context (there can only be one Q&A per conversation due to SESSION_START_TYPES)
    let qaContextSection = '';
    if (qaContent.length > 0) {
      const qa = qaContent[0]; // Only one Q&A possible

      if (qa.canAnswer) {
        qaContextSection += `\n\n**Existing Q&A from Current Documentation**:\n**Team Member Question:** ${qa.question}\n**CHOIR Response:** ${qa.answer}\n\nFocus on identifying NEW information that goes beyond what's already documented in the Q&A above.`;
      } else {
        qaContextSection += `\n\n**Question Not Covered by Current Documentation**:\n**Team Member Question:** ${qa.question}\n\nLook for team knowledge that could help answer this question or establish relevant policies.`;
      }
    } else if (latestCHOIRAnswer) {
      // If no qa_share_intro but there's a regular CHOIR answer, use it as context
      qaContextSection += `\n\n**CHOIR's Recent Answer (Current Documentation State)**:\n**Team Member Question:** ${latestCHOIRAnswer.question}\n**CHOIR Answer:** ${latestCHOIRAnswer.answer}\n\nThe above shows what CHOIR knows from existing documentation. Use it to resolve references in follow-up change requests. For example, if the follow-up says to change a value that appears in CHOIR's recent answer, treat it as a policy change or correction to that documented fact. Focus on identifying NEW information, policy changes, or corrections mentioned in the conversation.`;
    }

    const prompt = `Extract knowledge from this conversation. Base your response directly on what is mentioned in the messages.
${contextSection}${qaContextSection}

Conversation:
${formattedMessages}

What information is shared in the conversation that should be documented?`;

    const extractedKnowledge = await createChatCompletion(
      [
        {
          role: 'system',
          content: `You are CHOIR, a documentation specialist. Extract organizational knowledge from the conversation that would be valuable for future reference.

Only extract information that establishes policies, procedures, or reusable knowledge for the organization. Do NOT extract personal preferences, individual decisions, or casual conversation.

Start with a descriptive markdown section title (# [Topic Name]), then write the information in natural paragraph format. Only include facts that are directly stated in the conversation or in the provided current-documentation context. Do not add explanations, interpretations, or implications.

When CHOIR's recent answer is provided, treat it as the current documentation state. If a manager or authorized requester says to change, replace, update, increase, decrease, or correct a specific value from that recent answer, document the resulting updated fact using the subject from the recent answer.

Do not attribute information to specific people in your output. Always preserve any URLs mentioned.

If no documentable knowledge is found, respond with exactly: No organizational knowledge found`,
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
      {
        workspaceId,
        purpose: 'document-update',
        temperature: 0,
        max_tokens: 2000,
        function_name: 'extractKnowledgeFromMessages',
      } as ChatCompletionOptions,
    );

    if (!extractedKnowledge || extractedKnowledge.trim() === '') {
      throw new Error('No knowledge could be extracted from the messages');
    }

    // Clean up the response text
    let cleanContent = extractedKnowledge.trim();

    // Remove markdown code block markers if present
    if (cleanContent.startsWith('```')) {
      cleanContent = cleanContent.replace(/^```.*?\n/, '').replace(/\n```$/, '');
    }

    // Check if no knowledge was found
    if (cleanContent === 'No organizational knowledge found' || cleanContent === '') {
      cleanContent = '';
    }

    return {
      cleanContent,
      processedMessages,
    };
  } catch (error) {
    console.error('Error extracting knowledge from messages:', error);
    throw new Error(`Failed to extract knowledge: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}
