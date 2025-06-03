import { SlackMessage } from "services/slack";
import { WebClient } from "@slack/web-api";
import { createChatCompletion } from "./completions";
import { processMessageText } from "./qa-service";

export async function editMarkdownWithUserMessages(
  markdown: string,
  userMessages: SlackMessage[],
  client: WebClient
) {
  // Anonymize users by replacing usernames with generic identifiers
  const userMap = new Map<string, string>();
  let userCounter = 1;

  // Process message texts to handle mentions
  const processedMessages = await Promise.all(
    userMessages.map(async (message) => {
      const processedText = await processMessageText(message.text, client);
      
      if (!userMap.has(message.username)) {
        userMap.set(message.username, `User${userCounter++}`);
      }
      
      return {
        anonUser: userMap.get(message.username) || "Unknown",
        text: processedText
      };
    })
  );

  const responseContent = await createChatCompletion([
      {
        role: "system",
      content: `As a document editor, modify this markdown document with information from the conversation.

Key rules:
1. Update information: Directly modify existing content when needed and only add important new information
2. Keep it concise: Make minimal edits while maintaining the document's original style and tone
3. When conversation mentions contradict existing content, replace the existing content with new information
4. Never include user identifiers or names
5. Return only the edited markdown without explanations or tags`,
      },
      {
        role: "user",
        content: `<markdown>${markdown}</markdown>
<conversation>
${processedMessages
          .map(
            (message) =>
            `${message.anonUser}: ${message.text}`
          )
        .join("\n")}
</conversation>`,
      },
  ], {
    model: "gpt-4o-mini",
    temperature: 0,
    function_name: "editMarkdownWithUserMessages",
    debug: true,
  });
  
  // Remove any markdown tags from the response
  return responseContent?.replace(/<\/?markdown>/g, '') ?? markdown;
}

export async function editMarkdownWithKnowledge(
  markdown: string,
  knowledgeContent: string
) {
  const responseContent = await createChatCompletion([
      {
        role: "system",
      content: `As a document editor, modify this markdown document with the provided knowledge.

Key rules:
1. Update information: Directly modify existing content when needed and only add important new information
2. Keep it concise: Make minimal edits while maintaining the document's original style and tone
3. When knowledge contradicts existing content, completely replace the conflicting content with the new information (do not keep both)
4. If the knowledge is already covered or adds no new value, return the original document unchanged (do not add redundant content)
5. Never include user identifiers or names
6. Return only the edited markdown without explanations or tags
7. Focus on incorporating the knowledge into the most relevant section of the document`,
      },
      {
        role: "user",
        content: `<markdown>${markdown}</markdown>
<knowledge>
${knowledgeContent}
</knowledge>`,
      },
  ], {
    model: "gpt-4o-mini",
    temperature: 0,
    function_name: "editMarkdownWithKnowledge",
    debug: true,
  });
  
  // Remove any markdown tags from the response
  return responseContent?.replace(/<\/?markdown>/g, '') ?? markdown;
}

export async function classifyMessageIntent(message: string): Promise<"question" | "update_request"> {
  const result = await createChatCompletion([
      {
        role: "system",
        content: "Classify the user message as either a 'question' (asking for information) or 'update_request' (asking to save/store information). Respond with only 'question' or 'update_request'."
      },
      {
        role: "user",
        content: message
      }
  ], {
    temperature: 0.1,
    max_tokens: 10,
    function_name: "classifyMessageIntent",
  });

  return result?.trim().toLowerCase() === "update_request" ? "update_request" : "question";
} 