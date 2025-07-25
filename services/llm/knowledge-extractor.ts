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
export async function extractKnowledgeFromMessages(
  messages: SlackMessage[],
  context?: OrganizationalContext,
  client?: WebClient,
): Promise<KnowledgeExtractionResult> {
  try {
    // Use processMessageHistory to format messages with proper anonymization
    const processedMessages = await processMessageHistory(messages, client);

    // Format messages with numbered references for source tracking
    const formattedMessages = processedMessages.map((msg, index) => `[${index + 1}] ${msg.content}`).join('\n');

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

    const prompt = `You are an experienced knowledge curator named CHOIR analyzing a team conversation to identify what should be documented.

Read this conversation and understand the context and flow. What organizational knowledge is being shared or confirmed that would be valuable to document?
${contextSection}

**Your task:** Extract organizational knowledge in this conversation:

PRIORITIZE new organizational knowledge shared by human team members, especially information mentioned towards the end of the conversation. Focus on fresh insights rather than CHOIR's responses, suggestions, or confirmations of existing policies.

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
