import dotenv from 'dotenv';
import { AzureOpenAI, OpenAI } from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { getAIProvider, getAzureOpenAIConfig, getOpenAIConfig } from './llm-config';

dotenv.config();

let azureOpenAI: AzureOpenAI | null = null;
let openAI: OpenAI | null = null;

function initializeClients() {
  const provider = getAIProvider();
  
  if (provider === 'azure') {
    const config = getAzureOpenAIConfig();
    azureOpenAI = new AzureOpenAI({
      apiKey: config.apiKey,
      endpoint: config.endpoint,
      apiVersion: config.apiVersion,
      deployment: config.deploymentName,
    });
  } else {
    const config = getOpenAIConfig();
    openAI = new OpenAI({
      apiKey: config.apiKey,
    });
  }
}

initializeClients();

export interface ChatCompletionOptions {
  model?: string;
  temperature?: number;
  max_tokens?: number;
  function_name?: string;
  debug?: boolean;
  response_format?: { type: 'text' | 'json_object' };
}

// Create chat completion with Azure OpenAI or OpenAI
export const createChatCompletion = async (
  messages: ChatCompletionMessageParam[],
  options: ChatCompletionOptions = {},
) => {
  const {
    model,
    temperature = 0.2,
    max_tokens = 1000,
    function_name = 'None',
    debug = false,
    response_format,
  } = options;

  const provider = getAIProvider();
  let completion;

  if (provider === 'azure') {
    if (!azureOpenAI) {
      throw new Error('Azure OpenAI client not initialized');
    }
    const config = getAzureOpenAIConfig();
    completion = await azureOpenAI.chat.completions.create({
      model: (model || config.deploymentName) as string,
      messages,
      temperature,
      max_tokens,
      ...(response_format && { response_format }),
    });
  } else {
    if (!openAI) {
      throw new Error('OpenAI client not initialized');
    }
    const config = getOpenAIConfig();
    completion = await openAI.chat.completions.create({
      model: (model || config.model) as string,
      messages,
      temperature,
      max_tokens,
      ...(response_format && { response_format }),
    });
  }

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
