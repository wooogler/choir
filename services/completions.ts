import OpenAI from "openai";
import dotenv from "dotenv";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { SlackMessage } from "./slack-utils";

dotenv.config();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// System prompt definition
const SYSTEM_PROMPT = `You are an AI assistant that provides answers based on the lab's documentation.
Please refer to the following document content to answer user questions.

When answering, please follow these guidelines:
1. Cite and explain the relevant parts of the documentation you're referencing.
2. If the information is not found in the documents, respond with "I cannot find this information in the documentation."
3. Keep your answers concise and clear.
4. Include document sources when necessary.
5. Format code examples using markdown syntax.`;

// Format context from documents
const formatContext = (docs: any[]) => {
  return docs
    .map((doc) => `File: ${doc.metadata.fileName}\nContent: ${doc.pageContent}`)
    .join("\n\n");
};

// Process message history
const processMessageHistory = (messages: any[]) => {
  return messages
    .filter((msg) => msg.text && !msg.subtype)
    .reverse()
    .map((msg) => ({
      role: msg.bot_id ? "assistant" : "user",
      content: msg.text,
    }));
};

// Generate completion with context
export const generateCompletion = async (
  userMessage: string,
  messageHistory: any[],
  relevantDocs: any[]
) => {
  const context = formatContext(relevantDocs);
  const messages = processMessageHistory(messageHistory);

  const completion = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      {
        role: "system",
        content: `${SYSTEM_PROMPT}\n\nDocument content to reference:\n${context}`,
      },
      ...(messages as ChatCompletionMessageParam[]),
    ],
    temperature: 0.2,
    max_tokens: 1000,
  });

  return completion.choices[0].message.content;
};

export async function editMarkdownWithUserMessages(
  markdown: string,
  userMessages: SlackMessage[]
) {
  const completion = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      {
        role: "system",
        content: `You edit markdown based on conversation content.

CRITICAL RULES:
- Only update with new information or correct factual errors from the conversation
- Preserve original sentence structure and formatting
- Change only necessary keywords, not entire sentences
- Do not fix grammar or style unless explicitly requested
- Return only the raw markdown with no code blocks, annotations, or explanations.
- NEVER include <markdown> tags in your response.`,
      },
      {
        role: "user",
        content: `<markdown>${markdown}</markdown>
<conversation>${userMessages
          .map(
            (message) =>
              `<${message.username}>${message.text}</${message.username}>`
          )
          .join("\n")}</conversation>`,
      },
    ],
  });

  let responseContent = completion.choices[0].message.content ?? markdown;
  
  // Remove any markdown tags from the response
  responseContent = responseContent.replace(/<\/?markdown>/g, '');
  
  console.log(responseContent);

  return responseContent;
}
