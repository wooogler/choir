import { createChatCompletion } from './completions';

export interface NewSectionSuggestion {
  sectionTitle: string;
  sectionContent: string;
  recommendedFile: string;
  reasoning: string;
}

export interface NewFileDefaults {
  fileName: string;
  initialContent: string;
}

export async function generateNewFileDefaults(
  knowledgeContent: string,
  existingFiles: Array<{ name: string; path: string }>,
): Promise<NewFileDefaults> {
  const existingFileNames = existingFiles.map(file => file.name).join('\n');

  const response = await createChatCompletion(
    [
      {
        role: 'system',
        content: `You are a documentation file naming expert. Your task is to suggest a good file name and initial markdown content for new documentation based on knowledge content.

Key rules:
1. Suggest a descriptive but concise file name ending with .md
2. File name should be in kebab-case (lowercase with hyphens)
3. Avoid conflicts with existing files
4. Create initial markdown content with a proper title and the knowledge content
5. Return ONLY a valid JSON object with this exact structure:
{
  "fileName": "string",
  "initialContent": "string"
}

The initial content should start with a markdown header and include the knowledge content in a well-structured format.`,
      },
      {
        role: 'user',
        content: `Knowledge content to create a new file for:
${knowledgeContent}

Existing files (avoid conflicts):
${existingFileNames}

Generate a suitable file name and initial markdown content.`,
      },
    ],
    {
      model: process.env.OPENAI_MODEL_NAME || 'gpt-4o-mini',
      temperature: 0,
      max_tokens: 600,
      function_name: 'generateNewFileDefaults',
      debug: true,
    },
  );

  try {
    const parsed = JSON.parse(response?.trim() || '{}');
    return {
      fileName: parsed.fileName || 'new-document.md',
      initialContent: parsed.initialContent || `# New Document\n\n${knowledgeContent}`,
    };
  } catch (error) {
    console.error('Failed to parse new file defaults:', error);
    return {
      fileName: 'new-document.md',
      initialContent: `# New Document\n\n${knowledgeContent}`,
    };
  }
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

CONSTRAINTS:
- Use ONLY information from the knowledge - no external details, links, or assumptions
- Create a clear, descriptive but GENERAL section title (without # symbol) that could be relevant to many teams/contexts
- For section content, write as multiple paragraphs or multiple list items (no headings, subheadings, or complex structure)
- Keep content concise and directly relevant to the section context
- Never include user names or identifiers
- Always preserve any URLs from the knowledge as they contain valuable reference information
- If knowledge is insufficient to create a meaningful section, return empty sectionContent
- Select the most appropriate file from the available files
- Provide clear reasoning for your file selection

Return ONLY a valid JSON object with this exact structure:
{
  "reasoning": "string",
  "sectionTitle": "string",
  "sectionContent": "string", 
  "recommendedFile": "string"
}

The section title should be general enough to be applicable across different organizations (e.g., "Online Meeting Platform" rather than "Using Microsoft Teams for Online Meetings").
The section content should use only the provided knowledge without additional explanations or examples.`,
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
      temperature: 0,
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
