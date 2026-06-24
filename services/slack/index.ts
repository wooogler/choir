export * from './slack-diff';
export type { SlackMessage } from './conversation-history';

// User Management
export {
  isManager,
  getManagers,
  getManagerText,
  addManager,
  removeManager,
  setupInitialManager,
  getUserName,
  isWorkspaceOwner,
  isBotUser,
  getWorkspaceId,
  clearWorkspaceIdCache,
  promoteToManagerWithPassword,
  getCHOIRUsers,
  setCHOIRUsers,
  isCHOIRUser,
  resolveUserNames,
  getNonUserResponseMessage,
  getOrInitBotUserId,
} from './user-management';

// Message Utils
export {
  storeMessage,
  getMessage,
  removeMessage,
  getStoredMessages,
  extractKeysFromMessages,
  createSlackMessageWithName,
  formatSlackMessageBlock,
  replaceUserMentions,
  convertUserIdsToNames,
  replaceMentionsInText,
  removeDuplicateMessages,
  formatTimestampToDateString,
  formatSlackMessageSection,
} from './message-store';

// Repository Management
export {
  storeGithubRepo,
  getGithubRepo,
  parseGithubUrl,
} from '../github/repository-management';

// Q&A Channel
export {
  setQAChannel,
  getQAChannel,
  getChannelName,
  createQAChannelMessage,
  createQAChannelPreview,
  createPrivateMessage,
  createPrivateMessagePreview,
} from './qa-channel';

// Organization
export {
  setOrganizationName,
  getOrganizationName,
  setOrganizationDescription,
  getOrganizationDescription,
} from './organization';

// Utils
export {
  createGitbookSectionLink,
  isDM,
  isDMByAPI,
  is1to1DM,
  isGroupDM,
  classifyChannel,
  ChannelType,
  type ChannelClassification,
} from './utils';

// Conversation History
export {
  gatherExtractionCandidates,
  getFilteredConversationHistory,
  isUserInCHOIRList,
} from './conversation-history';

// Rate Limit Handling
export {
  withRateLimit,
  createRateLimitNotificationText,
  safeSlackCall,
  isRateLimitError,
} from './rate-limit-handler';
