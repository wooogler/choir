import dotenv from 'dotenv';
import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { ResponseInput, ResponseInputContent } from 'openai/resources/responses/responses';
import { anonymizeText, deAnonymizeText } from 'services/common/name-cache';
import { getOpenAIConfig } from './llm-config';

dotenv.config();

let openAI: OpenAI | null = null;

function initializeClient() {
  const config = getOpenAIConfig();
  openAI = new OpenAI({
    apiKey: config.apiKey,
  });
}

initializeClient();

const MIN_RESPONSE_OUTPUT_TOKENS = 16;

export interface ChatCompletionOptions {
  model?: string;
  temperature?: number;
  max_tokens?: number;
  function_name?: string;
  debug?: boolean;
  response_format?: { type: 'text' | 'json_object' };
}

export interface StructuredResponseOptions extends Omit<ChatCompletionOptions, 'response_format'> {
  schemaName: string;
  schema: Record<string, unknown>;
  schemaDescription?: string;
}

function normalizeMessageContent(content: ChatCompletionMessageParam['content']): string {
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if ('text' in part && typeof part.text === 'string') {
          return part.text;
        }

        return JSON.stringify(part);
      })
      .join('\n');
  }

  return content ? JSON.stringify(content) : '';
}

function toResponseInput(messages: ChatCompletionMessageParam[]): ResponseInput {
  return messages.map((message) => {
    const role = message.role === 'tool' ? 'user' : message.role;
    const normalizedRole = role === 'function' ? 'assistant' : role;

    return {
      type: 'message',
      role: (normalizedRole === 'system' || normalizedRole === 'assistant' || normalizedRole === 'user'
        ? normalizedRole
        : 'user'),
      content: normalizeMessageContent(message.content) as string | ResponseInputContent[],
    };
  });
}

function logDebugOutput(params: {
  functionName: string;
  messages: ChatCompletionMessageParam[];
  rawResponse: string | undefined;
  response: string;
}) {
  console.log('function: ', params.functionName);
  console.log('messages: \n');
  params.messages.forEach((message) => {
    console.log(`${message.role}: ${normalizeMessageContent(message.content)}`);
  });
  console.log('--------------------------------');
  console.log('raw response (before de-anonymization): \n', params.rawResponse);
  console.log('--------------------------------');
  console.log('response (after de-anonymization): \n', params.response);
}

function normalizeMaxOutputTokens(maxTokens: number | undefined): number {
  return Math.max(MIN_RESPONSE_OUTPUT_TOKENS, maxTokens ?? 1000);
}

async function createResponseText(
  messages: ChatCompletionMessageParam[],
  options: ChatCompletionOptions = {},
): Promise<string> {
  const {
    model,
    temperature = 0,
    max_tokens = 1000,
    function_name = 'None',
    debug = false,
    response_format,
  } = options;

  if (!openAI) {
    throw new Error('OpenAI client not initialized');
  }

  const config = getOpenAIConfig();
  const processedMessages: ChatCompletionMessageParam[] = messages.map((message) => ({
    ...message,
    content: anonymizeText(normalizeMessageContent(message.content)),
  })) as ChatCompletionMessageParam[];

  const response = await openAI.responses.create({
    model: model || config.responsesModel,
    input: toResponseInput(processedMessages),
    temperature,
    max_output_tokens: normalizeMaxOutputTokens(max_tokens),
    text: response_format
      ? {
          format:
            response_format.type === 'json_object'
              ? { type: 'json_object' }
              : { type: 'text' },
        }
      : undefined,
  });

  const rawResponse = response.output_text;
  const finalResponse = deAnonymizeText(rawResponse || '');

  if (debug) {
    logDebugOutput({
      functionName: function_name,
      messages,
      rawResponse,
      response: finalResponse,
    });
  }

  return finalResponse;
}

export async function createStructuredResponse<T>(
  messages: ChatCompletionMessageParam[],
  options: StructuredResponseOptions,
): Promise<T> {
  const {
    model,
    temperature = 0,
    max_tokens = 1000,
    function_name = 'None',
    debug = false,
    schemaName,
    schema,
    schemaDescription,
  } = options;

  if (!openAI) {
    throw new Error('OpenAI client not initialized');
  }

  const config = getOpenAIConfig();
  const processedMessages: ChatCompletionMessageParam[] = messages.map((message) => ({
    ...message,
    content: anonymizeText(normalizeMessageContent(message.content)),
  })) as ChatCompletionMessageParam[];

  const response = await openAI.responses.create({
    model: model || config.responsesModel,
    input: toResponseInput(processedMessages),
    temperature,
    max_output_tokens: normalizeMaxOutputTokens(max_tokens),
    text: {
      format: {
        type: 'json_schema',
        name: schemaName,
        schema,
        strict: true,
        ...(schemaDescription ? { description: schemaDescription } : {}),
      },
    },
  });

  const rawResponse = response.output_text;
  const finalResponse = deAnonymizeText(rawResponse || '');

  if (debug) {
    logDebugOutput({
      functionName: function_name,
      messages,
      rawResponse,
      response: finalResponse,
    });
  }

  return JSON.parse(finalResponse) as T;
}

export const createChatCompletion = async (
  messages: ChatCompletionMessageParam[],
  options: ChatCompletionOptions = {},
) => await createResponseText(messages, options);
