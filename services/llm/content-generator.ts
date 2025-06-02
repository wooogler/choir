import { createChatCompletion } from "./completions";
// import { LLMService } from "./llmService"; // Assuming LLMService can be used or adapted

/**
 * Generates content for a new node that follows the existing nodeContent based on new knowledge.
 * 
 * @param nodeContent The existing content that the new content should follow
 * @param knowledgeContent The new knowledge to incorporate into a new node
 * @returns A promise that resolves to the generated content for the new node
 */
export async function createNewContentFromKnowledge(
  nodeContent: string,
  knowledgeContent: string
): Promise<string> {
  const response = await createChatCompletion([
    {
      role: "system",
      content: `You are a document content generator. Your task is to create new content that naturally follows existing content.

Key rules:
1. Generate new content that would logically follow the provided existing content
2. Incorporate the given knowledge into this new content naturally
3. The new content should be independent and self-contained
4. Maintain the same style and tone as the existing content
5. Return only the new content without explanations or formatting tags
6. Keep the new content concise but informative`
    },
    {
      role: "user", 
      content: `Existing content:
${nodeContent}

Knowledge to incorporate:
${knowledgeContent}

Generate new content that would naturally follow the existing content and incorporates the knowledge.`
    }
  ], {
    model: "gpt-4o-mini",
    temperature: 0.3,
    max_tokens: 500,
    function_name: "createNewContentFromKnowledge",
    debug: true
  });

  return response?.trim() || "";
}