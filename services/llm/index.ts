export * from './langchain';

// Core completion functionality
export { createChatCompletion } from './completions';
export type { ChatCompletionOptions } from './completions';

// Q&A related functions
export { answerQuestion, processMessageText } from './qa-service';

// Document editing functions
export {
  editMarkdownWithUserMessages,
  editMarkdownWithKnowledge,
  classifyMessageIntent,
} from './document-editor';

// Content generation functions
export { createNewContentFromKnowledge } from './content-generator';

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
