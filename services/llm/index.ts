export * from './langchain';

// Core completion functionality
export { createChatCompletion } from './completions';
export type { ChatCompletionOptions } from './completions';

// Q&A related functions
export { answerQuestion } from './qa-service';

// Document editing functions
export {
  editMarkdownWithKnowledge,
  classifyMessageIntent,
} from './document-editor';

// LLM configuration (Azure OpenAI and OpenAI)
export {
  validateAzureOpenAIConfig,
  getAzureOpenAIConfig,
  isAzureOpenAIEnabled,
  validateOpenAIConfig,
  getOpenAIConfig,
  isOpenAIEnabled,
  getAIProvider,
  validateCurrentProvider,
} from './llm-config';
