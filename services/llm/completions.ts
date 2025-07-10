import dotenv from 'dotenv';
import { AzureOpenAI, OpenAI } from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { getAIProvider, getAzureOpenAIConfig, getOpenAIConfig } from './llm-config';
import { anonymizeText, deAnonymizeText } from 'services/common/name-cache';

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
  
  // Apply anonymization for all providers
  const processedMessages: ChatCompletionMessageParam[] = messages.map(msg => ({
    ...msg,
    content: typeof msg.content === 'string' ? anonymizeText(msg.content) : msg.content
  })) as ChatCompletionMessageParam[];

  let completion;

  if (provider === 'azure') {
    if (!azureOpenAI) {
      throw new Error('Azure OpenAI client not initialized');
    }
    const config = getAzureOpenAIConfig();
    completion = await azureOpenAI.chat.completions.create({
      model: (model || config.deploymentName) as string,
      messages: processedMessages,
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
      messages: processedMessages,
      temperature,
      max_tokens,
      ...(response_format && { response_format }),
    });
  }

  let response = completion.choices[0].message.content;
  const rawResponse = response; // Save raw response before de-anonymization
  
  // Apply de-anonymization for all responses
  if (response) {
    response = deAnonymizeText(response);
  }

  if (debug) {
    console.log('function: ', function_name);
    console.log('messages: \n');
    messages.forEach((message) => {
      console.log(`${message.role}: ${message.content}`);
    });
    console.log('--------------------------------');
    console.log('raw response (before de-anonymization): \n', rawResponse);
    console.log('--------------------------------');
    console.log('response (after de-anonymization): \n', response);
  }

  return response;
};
