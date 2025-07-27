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
// Helper function to extract Q&A content from QA_SHARE_INTRO messages
function extractQAContent(messageText: string, canAnswer: boolean): { question: string; answer: string | null; canAnswer: boolean } | null {
  const questionMatch = messageText.match(/\*Question:\*\s*```([^`]+)```/);
  
  if (questionMatch) {
    const question = questionMatch[1].trim();
    
    if (canAnswer) {
      // For answered questions, extract the response
      const responseMatch = messageText.match(/\*My response:\*\s*```([^`]+)```/);
      if (responseMatch) {
        return {
          question,
          answer: responseMatch[1].trim(),
          canAnswer: true
        };
      }
    } else {
      // For unanswered questions, no response expected
      return {
        question,
        answer: null,
        canAnswer: false
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
      const isQAShareAnswered = originalMsg.metadata?.messageType === 'qa_share_intro_answered' ||
        (originalMsg.blocks && originalMsg.blocks.some((block: any) => 
          block.block_id && block.block_id.includes('qa_share_intro_answered')));
      
      const isQAShareUnanswered = originalMsg.metadata?.messageType === 'qa_share_intro_unanswered' ||
        (originalMsg.blocks && originalMsg.blocks.some((block: any) => 
          block.block_id && block.block_id.includes('qa_share_intro_unanswered')));
      
      if ((isQAShareAnswered || isQAShareUnanswered) && msg.role === 'CHOIR') {
        const canAnswer = isQAShareAnswered;
        const extracted = extractQAContent(msg.content, canAnswer);
        if (extracted) {
          qaContent.push(extracted);
          continue; // Skip adding to conversation
        }
      }
      
      conversationMessages.push(msg);
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
        qaContextSection += `\n\n**Existing Q&A from Current Documentation**:\nQ: ${qa.question}\nA: ${qa.answer}\n\nFocus on identifying NEW information that goes beyond what's already documented in the Q&A above.`;
      } else {
        qaContextSection += `\n\n**Question Not Covered by Current Documentation**:\n- ${qa.question}\n\nLook for team knowledge that could help answer this question or establish relevant policies.`;
      }
    }

    const prompt = `You are an experienced knowledge curator named CHOIR analyzing a team conversation to identify what should be documented.

Read this conversation and understand the context and flow. What organizational knowledge is being shared or confirmed that would be valuable to document?
${contextSection}${qaContextSection}

**Your task:** Extract organizational knowledge in this conversation:

PRIORITIZE organizational knowledge shared by human team members (not CHOIR's responses). Look for decisions, processes, tools, standards, policies, or practices that the organization uses. Include any information about what the team does, how they work, or what tools/methods they use.

**Think about what the requester likely wants documented based on the conversation flow.**

If you find organizational knowledge worth documenting, respond with the complete knowledge statement as plain text. Include all relevant details, examples, and reference URLs to preserve the full context and value of the information.

Conversation:
${formattedMessages}

What organizational knowledge should be documented from this conversation?`;

    const extractedKnowledge = await createChatCompletion(
      [
        {
          role: 'system',
          content:
            'You are CHOIR, a helpful knowledge curator who extracts organizational knowledge from team conversations for documentation purposes. Focus on decisions, processes, and standards that represent what the organization or team does, rather than individual actions.',
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
      {
        model: 'gpt-4o',
        temperature: 0.3,
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
