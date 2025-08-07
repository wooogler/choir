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
} from './message-utils';

// Repository Management
export {
  storeGithubRepo,
  getGithubRepo,
  parseGithubUrl,
} from './repository-management';

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

// Home Screen
export { HomeScreenService } from './home-screen';

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
  getFilteredConversationHistory,
  isCHOIRUser as isCHOIRUserFromHistory,
} from './conversation-history';

// Rate Limit Handling
export {
  withRateLimit,
  notifyRateLimit,
  safeSlackCall,
  isRateLimitError,
} from './rate-limit-handler';
