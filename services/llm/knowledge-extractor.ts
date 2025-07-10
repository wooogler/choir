import { anonymizeText } from 'services/common/name-cache';
import type { SlackMessage } from 'services/slack';
import { type ChatCompletionOptions, createChatCompletion } from './completions';

interface ExtractedKnowledge {
  content: string;
  source: number[];
}

interface KnowledgeExtractionResult {
  cleanContent: string;
  detailedContent: string;
  knowledgeItem: ExtractedKnowledge | null;
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
): Promise<KnowledgeExtractionResult> {
  try {
    // Format messages for the prompt with numbered references and anonymization
    const formattedMessages = messages
      .map((msg, index) => {
        const timestamp = new Date(Number(msg.ts) * 1000).toLocaleString();
        const anonymizedUsername = msg.username ? anonymizeText(msg.username) : 'User';
        const anonymizedText = anonymizeText(msg.text || '');
        return `[${index + 1}] ${anonymizedUsername} (${timestamp}): ${anonymizedText}`;
      })
      .join('\n');

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

    const prompt = `Analyze the following numbered Slack conversation and extract the single most important piece of knowledge that should be documented for organizational purposes.

IMPORTANT: You must specify which message numbers contain this knowledge using the [number] references.
${contextSection}
**Context**: This knowledge will be used to update team documentation, so focus on organizational decisions, processes, and standards rather than individual actions.

**Writing Guidelines**:
- Write from the organization's perspective when appropriate
- Focus on knowledge that would be valuable for the team to remember
- Use natural language that fits the organizational context
- Avoid including personal names or individual references

Focus on the most valuable information from these categories:
1. **Decisions & Agreements**: Choices made, tools selected, or agreements reached
2. **Process & Methodology**: How things are done or should be done
3. **Technical Information**: Tools, technologies, specifications, or configurations
4. **Action Items**: Tasks, next steps, or assignments
5. **Insights & Learnings**: Important realizations or discoveries
6. **Preferences & Standards**: Team preferences, standards, or guidelines

Extract the single most important knowledge that:
- Provides the most useful information for the team
- Could be referenced later in documentation
- Represents the key decision, preference, or important information
- Would help someone understand the organizational standard or decision
- Is written from an organizational perspective

Format your response as a JSON object with this structure:
{
  "content": "Clear statement of the most important organizational knowledge",
  "source": [1, 3, 5]
}

Conversation:
${formattedMessages}

Extract the most important organizational knowledge as JSON:`;

    const extractedKnowledge = await createChatCompletion(
      [
        {
          role: 'system',
          content:
            'You are a helpful knowledge curator who extracts organizational knowledge from team conversations for documentation purposes. Focus on decisions, processes, and standards that represent what the organization or team does, rather than individual actions. Always write from an organizational perspective and provide source message numbers.',
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
      };
    }
  } catch (error) {
    console.error('Error extracting knowledge from messages:', error);
    throw new Error(`Failed to extract knowledge: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}
