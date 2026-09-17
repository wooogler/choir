// Strings for the app-home feature. Keys: `appHome.<surface>.<element>[.<variant>]`.
//
// The language settings are the first App Home section to go through the
// catalog: they are the one place a person can be reading CHOIR in a language
// they cannot yet change, so the picker itself has to speak their language.
// Option labels are shared by all three selects — the value each one carries
// differs (`auto`/`follow-conversation` vs a locale), the wording does not.
export const appHome = {
  'appHome.language.title': 'Language',

  'appHome.language.mine.label': '*Your language*\nThe language CHOIR uses when it talks to you.',
  'appHome.language.mine.placeholder': 'Select a language',

  'appHome.language.workspace.label': '*Workspace language*',
  'appHome.language.workspace.context': "Default for CHOIR's messages and buttons when a member has no preference",
  'appHome.language.workspace.placeholder': 'Select a language',

  'appHome.language.content.label': '*Document content language*',
  'appHome.language.content.context':
    "Language CHOIR writes new document content in; 'Follow the conversation' keeps today's behaviour",
  'appHome.language.content.placeholder': 'Select a language',

  'appHome.language.option.auto': 'Automatic (follows your Slack language)',
  'appHome.language.option.english': 'English',
  'appHome.language.option.korean': '한국어',
  'appHome.language.option.followConversation': 'Follow the conversation',

  'appHome.language.confirm.mine': '✅ Language set to {language}.',
  'appHome.language.confirm.mineAuto': '✅ Language set to automatic — CHOIR will use {language}.',
  'appHome.language.confirm.workspace': '✅ Workspace language set to {language}.',
  'appHome.language.confirm.content': '✅ Document content language set to {language}.',
} as const;
