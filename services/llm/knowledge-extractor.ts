import type { WebClient } from '@slack/web-api';
import { anonymizeText } from 'services/common/name-cache';
import type { SlackMessage } from 'services/slack';
import { processMessageHistory } from 'services/slack/conversation-history';
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
    if (block.block_id && block.block_id.includes('user_comment') && 
        block.type === 'section' && block.text?.text) {
      return block.text.text;
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
): Promise<KnowledgeExtractionResult> {
  try {
    // Use processMessageHistory to format messages with proper anonymization
    const processedMessages = await processMessageHistory(messages, client);

    // Separate Q&A content from regular conversation
    const qaContent: Array<{ question: string; answer: string | null; canAnswer: boolean }> = [];
    const conversationMessages: Array<{ role: string; content: string }> = [];

    for (let i = 0; i < processedMessages.length; i++) {
      const msg = processedMessages[i];
      const originalMsg = messages[i];

      // Check if this is a QA_SHARE_INTRO message (answered or unanswered)
      const isQAShareAnswered =
        originalMsg.metadata?.messageType === 'qa_share_intro_answered' ||
        (originalMsg.blocks &&
          originalMsg.blocks.some(
            (block: any) => block.block_id && block.block_id.includes('qa_share_intro_answered'),
          ));

      const isQAShareUnanswered =
        originalMsg.metadata?.messageType === 'qa_share_intro_unanswered' ||
        (originalMsg.blocks &&
          originalMsg.blocks.some(
            (block: any) => block.block_id && block.block_id.includes('qa_share_intro_unanswered'),
          ));

      // Check if this message has a USER_COMMENT block
      const hasUserComment = originalMsg.blocks && 
        originalMsg.blocks.some((block: any) => 
          block.block_id && block.block_id.includes('user_comment'));

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

      // Add all other messages to conversation, but exclude CHOIR messages from regular conversation
      // (Q&A content is already handled separately above)
      if (msg.role !== 'CHOIR') {
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
      if (context.organizationDescription) {
        contextSection += `- About: ${context.organizationDescription}\n`;
      }
      if (context.channelType) {
        contextSection += `- Channel Type: ${context.channelType}\n`;
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
          content: `You are CHOIR, a documentation specialist. Extract organizational knowledge and policies from the conversation that would be valuable for future reference. Focus on actionable information, procedures, policies, or insights that go beyond personal opinions or individual experiences. Start with a descriptive markdown section title (# [Topic Name]) that reflects the organizational knowledge, then write the information in natural paragraph format - avoid lists or bullet points. Do not include personal conversation details like who said what. Always preserve any URLs mentioned.`,
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
      {
        model: 'gpt-4o',
        temperature: 0,
        max_tokens: 2000,
        function_name: 'extractKnowledgeFromMessages',
        debug: true,
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
