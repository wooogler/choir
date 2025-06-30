import dotenv from 'dotenv';
import { AzureOpenAI } from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

dotenv.config();

const azureOpenAI = new AzureOpenAI({
  apiKey: process.env.AZURE_OPENAI_API_KEY,
  endpoint: process.env.AZURE_OPENAI_ENDPOINT,
  apiVersion: process.env.AZURE_OPENAI_API_VERSION || '2024-10-21',
  deployment: process.env.AZURE_OPENAI_DEPLOYMENT_NAME,
});

export interface ChatCompletionOptions {
  model?: string;
  temperature?: number;
  max_tokens?: number;
  function_name?: string;
  debug?: boolean;
  response_format?: { type: 'text' | 'json_object' };
}

// Create chat completion with Azure OpenAI
export const createChatCompletion = async (
  messages: ChatCompletionMessageParam[],
  options: ChatCompletionOptions = {},
) => {
  const {
    model = process.env.AZURE_OPENAI_DEPLOYMENT_NAME || 'gpt-4o-mini', // Azure에서는 deployment name 사용
    temperature = 0.2,
    max_tokens = 1000,
    function_name = 'None',
    debug = false,
    response_format,
  } = options;

  const completion = await azureOpenAI.chat.completions.create({
    model, // Azure에서는 deployment name
    messages,
    temperature,
    max_tokens,
    ...(response_format && { response_format }),
  });

  const response = completion.choices[0].message.content;
  if (debug) {
    console.log('function: ', function_name);
    console.log('messages: ');
    messages.forEach((message) => {
      console.log(`${message.role}: ${message.content}`);
    });
    console.log('--------------------------------');
    console.log('response: ', response);
  }

  return response;
};
