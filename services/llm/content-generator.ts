import { createChatCompletion } from './completions';
// import { LLMService } from "./llmService"; // Assuming LLMService can be used or adapted

/**
 * Generates content for a new node that follows the existing nodeContent based on new knowledge.
 *
 * @param nodeContent The existing content that the new content should follow
 * @param knowledgeContent The new knowledge to incorporate into a new node
 * @returns A promise that resolves to the generated content for the new node
 */
export async function createNewContentFromKnowledge(nodeContent: string, knowledgeContent: string): Promise<string> {
  const response = await createChatCompletion(
    [
      {
        role: 'system',
        content: `You are a document content generator. Your task is to create NEW content that can be appended to existing content.

Key rules:
1. Return ONLY the new content to be added - DO NOT include the existing content
2. Use ONLY the provided knowledge content with minimal reformatting
3. The new content should complement the existing content without repeating it
4. Maintain the same style and tone as the existing content
5. Do NOT hallucinate or create new information beyond what's provided in the knowledge
6. Keep formatting consistent with the existing content style
7. Return ONLY the additional content that should be appended`,
      },
      {
        role: 'user',
        content: `Existing content:
${nodeContent}

Knowledge to incorporate:
${knowledgeContent}

Create NEW content to append based on the knowledge. Return ONLY the new content that should be added after the existing content - do NOT include the existing content in your response.`,
      },
    ],
    {
      model: process.env.OPENAI_MODEL_NAME || 'gpt-4o-mini',
      temperature: 0.1,
      max_tokens: 500,
      function_name: 'createNewContentFromKnowledge',
      debug: true,
    },
  );

  return response?.trim() || '';
}

export interface NewSectionSuggestion {
  sectionTitle: string;
  sectionContent: string;
  recommendedFile: string;
  reasoning: string;
}

export async function createNewSectionFromKnowledge(
  knowledgeContent: string,
  availableFiles: Array<{ fileName: string; githubUrl: string; description?: string }>,
): Promise<NewSectionSuggestion> {
  const filesDescription = availableFiles
    .map((file) => `- ${file.fileName}: ${file.description || 'No description'}`)
    .join('\n');

  const response = await createChatCompletion(
    [
      {
        role: 'system',
        content: `You are a documentation structure expert. Your task is to analyze knowledge content and suggest a new section that could be added to existing documentation.

Key rules:
1. Create a clear, descriptive but GENERAL section title (without # symbol) that could be relevant to many teams/contexts
2. For section content, use ONLY the provided knowledge content with minimal reformatting - do NOT add extra explanations or examples
3. Select the most appropriate file from the available files
4. Provide reasoning for your file selection
5. Return ONLY a valid JSON object with this exact structure:
{
  "sectionTitle": "string",
  "sectionContent": "string", 
  "recommendedFile": "string",
  "reasoning": "string"
}

The section title should be general enough to be applicable across different organizations (e.g., "Online Meeting Platform" rather than "Using Microsoft Teams for Online Meetings").
The section content should be primarily the knowledge content itself, not an expanded explanation.`,
      },
      {
        role: 'user',
        content: `Knowledge to turn into a new section:
${knowledgeContent}

Available files:
${filesDescription}

Analyze the knowledge and suggest a new section with appropriate title, content, and recommend which file it should be added to.`,
      },
    ],
    {
      model: process.env.OPENAI_MODEL_NAME || 'gpt-4o-mini',
      temperature: 0.3,
      max_tokens: 800,
      function_name: 'createNewSectionFromKnowledge',
      debug: false,
    },
  );

  try {
    const parsed = JSON.parse(response?.trim() || '{}');
    return {
      sectionTitle: parsed.sectionTitle || 'New Section',
      sectionContent: parsed.sectionContent || knowledgeContent,
      recommendedFile: parsed.recommendedFile || availableFiles[0]?.fileName || 'Unknown',
      reasoning: parsed.reasoning || 'Default selection',
    };
  } catch (error) {
    console.error('Failed to parse new section suggestion:', error);
    return {
      sectionTitle: 'New Section',
      sectionContent: knowledgeContent,
      recommendedFile: availableFiles[0]?.fileName || 'Unknown',
      reasoning: 'Failed to parse AI response, using defaults',
    };
  }
}
