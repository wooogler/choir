import OpenAI from "openai";
import dotenv from "dotenv";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { SlackMessage } from "services/slack";

dotenv.config();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

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

interface ChatCompletionOptions {
  model?: string;
  temperature?: number;
  max_tokens?: number;
  function_name?: string;
  debug?: boolean;
}

// Create chat completion with OpenAI
const createChatCompletion = async (
  messages: ChatCompletionMessageParam[],
  options: ChatCompletionOptions = {}
) => {
  const {
    model = "gpt-4o",
    temperature = 0.2,
    max_tokens = 1000,
    function_name = "None",
    debug = false,
  } = options;

  const completion = await openai.chat.completions.create({
    model,
    messages,
    temperature,
    max_tokens,
  });

  const response = completion.choices[0].message.content;
  if (debug) {
    console.log("function: ", function_name);
    console.log("messages: ");
    messages.forEach((message) => {
      console.log(`${message.role}: ${message.content}`);
    });
    console.log("--------------------------------");
    console.log("response: ", response);
  }

  return response;
};

// Generate completion with context
export const generateCompletion = async (
  userMessage: string,
  messageHistory: any[],
  relevantDocs: any[]
) => {
  const context = formatContext(relevantDocs);
  const messages = processMessageHistory(messageHistory);

  return createChatCompletion([
    {
      role: "system",
      content: `You are an AI assistant that provides answers based on the lab's documentation.
Please refer to the following document content to answer user questions.

When answering, please follow these guidelines:
1. Cite and explain the relevant parts of the documentation you're referencing.
2. If the information is not found in the documents, respond with "I cannot find this information in the documentation."
3. Keep your answers concise and clear.
4. Include document sources when necessary.
5. Format code examples using markdown syntax.

Document content to reference:\n${context}`,
    },
    ...(messages as ChatCompletionMessageParam[]),
  ]);
};

export async function editMarkdownWithUserMessages(
  markdown: string,
  userMessages: SlackMessage[]
) {
  const responseContent = await createChatCompletion([
    {
      role: "system",
      content: `You're editing a collaborative document based on conversation insights.

KEY PRINCIPLES:
- Blend new information naturally into existing sentences and paragraphs
- DO NOT create new paragraphs unless absolutely necessary
- Keep the document compact by modifying existing content rather than adding separate sections
- Preserve the original flow, tone, and structure
- Subtle integration is preferred over obvious additions
- When adding information, connect it to related existing points with transitions like "but," "however," "additionally," etc.
- Return only the edited markdown with no explanations or tags`,
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
  ], {
    model: "gpt-4o",
    temperature: 0,
    function_name: "editMarkdownWithUserMessages",
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
