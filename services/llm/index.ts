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

// Azure OpenAI configuration
export { validateAzureOpenAIConfig, getAzureOpenAIConfig, isAzureOpenAIEnabled } from './azure-config';
