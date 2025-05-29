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

// Process message history with filtering and mention processing
const processMessageHistory = async (messages: any[], client?: WebClient) => {
  const filteredMessages = messages.filter((msg) => {
    // Basic filters
    if (!msg.text || msg.subtype) return false;
    
    // Filter out loading and temporary messages
    const loadingPatterns = [
      "Searching relevant documents",
      "Preparing document update suggestions",
      "Processing knowledge and generating",
      ":mag:",
      ":brain:",
      "Extracting knowledge from",
      "Analyzing conversation"
    ];
    
    // Check if message contains any loading patterns
    const isLoadingMessage = loadingPatterns.some(pattern => 
      msg.text.includes(pattern)
    );
    
    return !isLoadingMessage;
  });

  // Process mentions if client is provided
  const processedMessages = client 
    ? await Promise.all(
        filteredMessages.map(async (msg) => ({
          ...msg,
          text: await processMessageText(msg.text, client)
        }))
      )
    : filteredMessages;

  return processedMessages
    .reverse()
    .map((msg) => ({
      role: msg.bot_id ? "assistant" : "user",
      content: msg.text,
    }));
};

export interface ChatCompletionOptions {
  model?: string;
  temperature?: number;
  max_tokens?: number;
  function_name?: string;
  debug?: boolean;
  response_format?: { type: "text" | "json_object" };
}

// Create chat completion with OpenAI
export const createChatCompletion = async (
  messages: ChatCompletionMessageParam[],
  options: ChatCompletionOptions = {}
) => {
  const {
    model = "gpt-4o-mini",
    temperature = 0.2,
    max_tokens = 1000,
    function_name = "None",
    debug = false,
    response_format,
  } = options;

  const completion = await openai.chat.completions.create({
    model,
    messages,
    temperature,
    max_tokens,
    ...(response_format && { response_format }),
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

// Process message text to handle user and bot mentions
export async function processMessageText(text: string, client: WebClient): Promise<string> {
  // Regular expression to find all user/bot mentions like <@U089Q1VAB3J>
  const mentionRegex = /<@([A-Z0-9]+)>/g;
  let matches;
  let processedText = text;
  
  // Get current bot user ID
  const authResult = await client.auth.test();
  const currentBotId = authResult.user_id;
  
  // Collect all unique user IDs mentioned in the text
  const mentionedIds = new Set<string>();
  while ((matches = mentionRegex.exec(text)) !== null) {
    mentionedIds.add(matches[1]);
  }
  
  // Process each unique user ID
  for (const userId of mentionedIds) {
    const isBot = await isBotUser(userId, client);
    
    if (isBot) {
      if (userId === currentBotId) {
        // Replace current chatbot mention with @CHOIR
        processedText = processedText.replace(new RegExp(`<@${userId}>`, 'g'), '@CHOIR');
      } else {
        // Remove other bot mentions completely
        processedText = processedText.replace(new RegExp(`<@${userId}>`, 'g'), '');
      }
    } else {
      // Replace user mentions with their names
      const userName = await getUserName(userId, client);
      processedText = processedText.replace(new RegExp(`<@${userId}>`, 'g'), userName);
    }
  }
  
  return processedText.trim();
}

// Generate completion with context
export const answerQuestion = async (
  userMessage: string,
  messageHistory: any[],
  relevantDocs: any[],
  client?: WebClient,
  workspaceName?: string
) => {
  const context = formatContext(relevantDocs);
  const messages = await processMessageHistory(messageHistory, client);
  
  // Get today's date
  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });

  const response = await createChatCompletion([
      {
        role: "system",
      content: `You are CHOIR, a helpful AI assistant for the lab/organization. Think of yourself as a knowledgeable senior student or friendly professor who's always ready to help with questions.

I have access to the organization's documentation and knowledge base, so I can help you find information and provide guidance based on what we have documented.

Context Information:
- Today's date: ${today}
${workspaceName ? `- Workspace: ${workspaceName}` : ''}

When answering, please follow these guidelines:
1. Be friendly, approachable, and helpful - like a senior colleague who genuinely wants to help
2. Provide clear and practical answers based on the documentation
3. If multiple documents contain conflicting information, prioritize the first document in the list
4. If I can't find the information in our documentation, I'll let you know honestly: "I couldn't find this information in our current documentation"
5. When users mention @CHOIR, that's me! Feel free to be conversational
6. Use a warm, academic tone - professional but not overly formal

Here's the relevant documentation I can reference:
${context}`,
      },
      ...(messages as ChatCompletionMessageParam[]),
  ], {debug: true});

  return response;
};

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
