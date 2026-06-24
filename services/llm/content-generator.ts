import { createStructuredResponse } from './completions';

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
  workspaceId?: string,
): Promise<NewFileDefaults> {
  const existingFileNames = existingFiles.map((file) => file.name).join('\n');

  try {
    return await createStructuredResponse<NewFileDefaults>(
      [
        {
          role: 'system',
          content: `You are a documentation assistant. Suggest a file name and initial markdown content for a new documentation file.

Rules:
- File name: descriptive, concise, kebab-case, ending with .md (the file name stays in English). Avoid conflicts with existing files.
- Initial content: start with a markdown title (#), then present the knowledge as a markdown bullet list (one "-" item per fact).
- Use ONLY information from the provided knowledge. Do NOT invent overviews, summaries, examples, checklists, extra sections, or any detail not explicitly stated in the knowledge.
- Write the initial content in the same language as the knowledge.
- Keep it concise and do not pad. If the knowledge is short, the document is short.`,
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
        workspaceId,
        purpose: 'document-update',
        temperature: 0,
        max_tokens: 600,
        function_name: 'generateNewFileDefaults',
        schemaName: 'new_file_defaults',
        schemaDescription: 'A file name and initial markdown content for a new documentation file',
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            fileName: {
              type: 'string',
              minLength: 1,
            },
            initialContent: {
              type: 'string',
              minLength: 1,
            },
          },
          required: ['fileName', 'initialContent'],
        },
      },
    );
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
  workspaceId?: string,
): Promise<NewSectionSuggestion> {
  const filesDescription = availableFiles
    .map((file) => `- ${file.fileName}: ${file.description || 'No description'}`)
    .join('\n');

  try {
    return await createStructuredResponse<NewSectionSuggestion>(
      [
        {
          role: 'system',
          content: `You are a documentation assistant. Analyze knowledge content and suggest a new section for existing documentation.

Rules:
- Use ONLY information from the provided knowledge — no external details or assumptions
- Write the section title and content in the same language as the knowledge
- Section title: clear, general (e.g., "Online Meeting Platform" not "Using Microsoft Teams for Online Meetings"), without # symbol
- Section content: a markdown bullet list — one "-" item per fact (no headings or nested structure)
- Never include user names or identifiers
- Preserve any URLs from the knowledge
- Select the most appropriate file and provide reasoning for the choice
- If knowledge is insufficient, return empty sectionContent`,
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
        workspaceId,
        purpose: 'document-update',
        temperature: 0,
        max_tokens: 800,
        function_name: 'createNewSectionFromKnowledge',
        schemaName: 'new_section_suggestion',
        schemaDescription: 'A new documentation section suggestion and the best file to place it in',
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            reasoning: {
              type: 'string',
              minLength: 1,
            },
            sectionTitle: {
              type: 'string',
              minLength: 1,
            },
            sectionContent: {
              type: 'string',
            },
            recommendedFile: {
              type: 'string',
              minLength: 1,
            },
          },
          required: ['reasoning', 'sectionTitle', 'sectionContent', 'recommendedFile'],
        },
      },
    );
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
