export * from './langchain';

// Core completion functionality
export { createChatCompletion } from './completions';
export { createStructuredResponse } from './completions';
export type { ChatCompletionOptions, StructuredResponseOptions } from './completions';

// Q&A related functions
export { answerQuestion } from './qa-service';

// Document editing functions
export {
  editMarkdownWithKnowledge,
  classifyMessageIntent,
} from './document-editor';

// LLM configuration
export {
  validateOpenAIConfig,
  getOpenAIConfig,
  isOpenAIEnabled,
  getAIProvider,
  validateCurrentProvider,
} from './llm-config';
