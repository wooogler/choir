import OpenAI from "openai";
import dotenv from "dotenv";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { SlackMessage } from "services/slack";
import { WebClient } from "@slack/web-api";
import { getUserName, isBotUser } from "services/slack";

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

// Process message text to handle user and bot mentions
export async function processMessageText(text: string, client: WebClient): Promise<string> {
  // Regular expression to find all user/bot mentions like <@U089Q1VAB3J>
  const mentionRegex = /<@([A-Z0-9]+)>/g;
  let matches;
  let processedText = text;
  
  // Collect all unique user IDs mentioned in the text
  const mentionedIds = new Set<string>();
  while ((matches = mentionRegex.exec(text)) !== null) {
    mentionedIds.add(matches[1]);
  }
  
  // Process each unique user ID
  for (const userId of mentionedIds) {
    const isBot = await isBotUser(userId, client);
    
    if (isBot) {
      // Remove bot mentions completely
      processedText = processedText.replace(new RegExp(`<@${userId}>`, 'g'), '');
    } else {
      // Replace user mentions with their names
      const userName = await getUserName(userId, client);
      processedText = processedText.replace(new RegExp(`<@${userId}>`, 'g'), userName);
    }
  }
  
  return processedText.trim();
}

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
