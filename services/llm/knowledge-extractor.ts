import type { WebClient } from '@slack/web-api';
import { anonymizeText } from 'services/common/name-cache';
import type { SlackMessage } from 'services/slack';
import { processMessageHistory } from 'services/slack/conversation-history';
import { type ChatCompletionOptions, createChatCompletion } from './completions';

interface ExtractedKnowledge {
  content: string;
  source: number[];
}

interface KnowledgeExtractionResult {
  cleanContent: string;
  detailedContent: string;
  knowledgeItem: ExtractedKnowledge | null;
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

    const prompt = `Extract knowledge from this Slack conversation to update team documentation.

IMPORTANT: You must specify which message numbers contain this knowledge using the [number] references.
${contextSection}

**What to extract:**
Look for NEW information shared by team members that should be documented, such as:
- New decisions, policies, or process changes
- Tips, best practices, or lessons learned  
- Technical information or configurations
- Important clarifications or exceptions to existing policies

**What to IGNORE:**
- CHOIR's responses (these are just existing documentation being quoted)
- General discussion without actionable information
- Personal actions or individual-specific information

**Priority order:**
1. **Human team members' statements** - Always prioritize what humans say over CHOIR responses
2. **New information** - Focus on what's being newly shared or decided
3. **Manager/leadership input** - Especially important for policy decisions
4. **Most recent information** - Latest statements in the conversation

**Example:**
If CHOIR says "According to documentation, X is the policy" but then a human says "Actually, in practice we also do Y", extract the human's addition about Y, not CHOIR's statement about X.

Format your response as a JSON object:
{
  "content": "Clear statement of the organizational knowledge to document",
  "source": [message_numbers]
}

Conversation:
${formattedMessages}

Extract the most important NEW knowledge shared by humans:`;

    const extractedKnowledge = await createChatCompletion(
      [
        {
          role: 'system',
          content:
            'You are CHOIR, a helpful knowledge curator who extracts organizational knowledge from team conversations for documentation purposes. Focus on decisions, processes, and standards that represent what the organization or team does, rather than individual actions. Always write from an organizational perspective and provide source message numbers.',
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
      {
        model: 'gpt-4o',
        temperature: 0.3,
        max_tokens: 1000,
        function_name: 'extractKnowledgeFromMessages',
        debug: true,
        response_format: { type: 'json_object' },
      } as ChatCompletionOptions,
    );

    if (!extractedKnowledge || extractedKnowledge.trim() === '') {
      throw new Error('No knowledge could be extracted from the messages');
    }

    // Parse the JSON response and format it as a single string
    try {
      let jsonString = extractedKnowledge.trim();

      // Remove markdown code block markers if present
      if (jsonString.startsWith('```json')) {
        jsonString = jsonString.replace(/^```json\s*/, '').replace(/\s*```$/, '');
      } else if (jsonString.startsWith('```')) {
        jsonString = jsonString.replace(/^```\s*/, '').replace(/\s*```$/, '');
      }

      const knowledgeItem: ExtractedKnowledge = JSON.parse(jsonString.trim());

      // Validate the structure
      if (
        !knowledgeItem ||
        typeof knowledgeItem.content !== 'string' ||
        knowledgeItem.content.trim() === '' ||
        !Array.isArray(knowledgeItem.source) ||
        knowledgeItem.source.length === 0
      ) {
        throw new Error('Invalid knowledge structure');
      }

      // Create clean content (just the knowledge without source references)
      const cleanContent = knowledgeItem.content;

      // Create detailed content (with source references)
      const sourceRefs = knowledgeItem.source.map((num) => `[${num}]`).join(', ');
      const detailedContent = `${knowledgeItem.content}\n📍 Sources: ${sourceRefs}`;

      return {
        cleanContent,
        detailedContent,
        knowledgeItem,
        processedMessages,
      };
    } catch (parseError) {
      console.warn('Failed to parse JSON response, returning raw text:', parseError);
      console.warn('Raw response:', extractedKnowledge);

      // Fallback to raw response if JSON parsing fails
      const fallbackContent = extractedKnowledge.trim();
      return {
        cleanContent: fallbackContent,
        detailedContent: fallbackContent,
        knowledgeItem: null,
        processedMessages,
      };
    }
  } catch (error) {
    console.error('Error extracting knowledge from messages:', error);
    throw new Error(`Failed to extract knowledge: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}
