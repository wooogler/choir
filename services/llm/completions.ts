import OpenAI from "openai";
import dotenv from "dotenv";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

dotenv.config();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

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
