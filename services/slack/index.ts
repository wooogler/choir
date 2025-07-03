export * from './slack-diff';
export * from './types';

// User Management
export {
  isManager,
  getManagers,
  addManager,
  removeManager,
  setupInitialManager,
  getUserName,
  isWorkspaceOwner,
  isBotUser,
  getWorkspaceId,
  promoteToManagerWithPassword,
  getCHOIRUsers,
  setCHOIRUsers,
  isCHOIRUser,
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
export { createGitbookSectionLink } from './utils';

// Conversation History
export {
  getFilteredConversationHistory,
  isCHOIRUser as isCHOIRUserFromHistory,
  getNonUserResponseMessage,
} from './conversation-history';
