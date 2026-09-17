// Strings for the App Home GitHub connection flow.
// Keys: `appHome.github.<surface>.<element>[.<variant>]`, with four surfaces:
//
//   connect      the OAuth device-flow modal and the notices it ends in
//   disconnect   the one-click "forget my token" confirmations
//   repoPicker   the Select Repository modal in its loading/list/empty/error states
//   connectRepo  what happens after that modal is submitted
//
// Two things are deliberately *not* here. Repository names, owners and URLs are
// identifiers, so they arrive as `{name}`/`{repository}`/`{example}` params and
// the verification link is pre-formatted as `<url|label>` before it is passed
// in. And `connectRepo.error.access` carries `{reason}` verbatim: the sentence
// comes from `services/github/repository-access`, which has no translator.
export const appHomeGithub = {
  'appHome.github.connect.title': 'Connect GitHub',
  'appHome.github.connect.intro':
    '🔐 *Connect your GitHub account*\n\nTo connect your GitHub account, please follow these steps:',
  'appHome.github.connect.steps':
    '1. Go to: *{link}*\n2. Enter this code: `{code}`\n3. Authorize CHOIR to access your GitHub account',
  'appHome.github.connect.expiry': {
    one: '⏰ *Code expires in {count} minute*',
    other: '⏰ *Code expires in {count} minutes*',
  },
  'appHome.github.connect.hint':
    '💡 This window will update once you complete the authorization on GitHub — you can then close it.',
  'appHome.github.connect.success': '✅ *GitHub account connected!*\nWelcome, {name}. You can close this window.',
  'appHome.github.connect.successNotice': '✅ GitHub account connected successfully! Welcome, {name}!',
  'appHome.github.connect.failure': '❌ *GitHub connection failed.*\nPlease close this window and try again.',
  'appHome.github.connect.failureNotice': '❌ GitHub connection failed. Please try again.',
  'appHome.github.connect.startError': '❌ Error starting GitHub connection. Please try again.',

  'appHome.github.disconnect.success': '✅ GitHub account disconnected successfully.',
  'appHome.github.disconnect.error': '❌ Error disconnecting GitHub. Please try again.',

  'appHome.github.repoPicker.title': 'Select Repository',
  'appHome.github.repoPicker.submit': 'Connect Repository',
  'appHome.github.repoPicker.notConnected': '❌ Please connect your GitHub account first.',
  'appHome.github.repoPicker.loading':
    '⏳ *Loading repositories*\n\nChecking which repositories you can write to and which ones already contain `.md` files...',
  'appHome.github.repoPicker.intro':
    '📂 *Select a GitHub repository to connect*\n\nChoose a public repository you can write to, or paste a public GitHub repository URL below. Private repositories are not supported.',
  'appHome.github.repoPicker.select.label': 'Repository',
  'appHome.github.repoPicker.select.placeholder': 'Choose a repository...',
  'appHome.github.repoPicker.url.label': 'Repository URL',
  'appHome.github.repoPicker.url.placeholder': '{example} or /tree/branch/docs',
  'appHome.github.repoPicker.path.label': 'Path in Repository',
  'appHome.github.repoPicker.path.placeholder': 'docs/ (optional - leave empty for root)',
  'appHome.github.repoPicker.option.label': '{name} ({files} md)',
  'appHome.github.repoPicker.option.description': {
    one: '{count} markdown file · {percent}% of {total} files',
    other: '{count} markdown files · {percent}% of {total} files',
  },
  'appHome.github.repoPicker.empty': '❌ No public writable repositories with markdown files were found.',
  'appHome.github.repoPicker.error': '❌ Error loading repositories. Please try again.',

  'appHome.github.connectRepo.error.permission': "❌ You don't have permission to connect a repository.",
  'appHome.github.connectRepo.error.noSelection': 'Choose a repository or paste a GitHub repository URL.',
  'appHome.github.connectRepo.error.bothInputs': 'Use either the repository picker or a URL, not both.',
  'appHome.github.connectRepo.error.privateRepo':
    'Private repositories are not supported. Please choose a public repository.',
  'appHome.github.connectRepo.error.invalidUrl': 'Enter a valid GitHub repository URL.',
  'appHome.github.connectRepo.error.access': '❌ {reason}',
  'appHome.github.connectRepo.error.inline': 'Error connecting the repository. Please try again.',
  'appHome.github.connectRepo.error.generic': '❌ Error connecting the repository. Please try again.',
  'appHome.github.connectRepo.progress.connecting': '🔗 Connecting to repository and loading documents...',
  'appHome.github.connectRepo.progress.loaded': {
    one: '📚 Loaded {count} file from {repository}. Building the Q&A index now; this may take a minute or two on CPU.',
    other:
      '📚 Loaded {count} files from {repository}. Building the Q&A index now; this may take a minute or two on CPU.',
  },
  'appHome.github.connectRepo.noFiles': '⚠️ Repository connected but no markdown files found.',
  'appHome.github.connectRepo.success': {
    one: '✅ Successfully connected to {repository}, loaded {count} file, and built the Q&A index. CHOIR is ready to answer questions.',
    other:
      '✅ Successfully connected to {repository}, loaded {count} files, and built the Q&A index. CHOIR is ready to answer questions.',
  },
  'appHome.github.connectRepo.indexFailed': {
    one: '⚠️ Repository connected and {count} file was loaded, but the Q&A index failed to build. Q&A will not be ready until you rebuild the QMD index from App Home.',
    other:
      '⚠️ Repository connected and {count} files were loaded, but the Q&A index failed to build. Q&A will not be ready until you rebuild the QMD index from App Home.',
  },
  'appHome.github.connectRepo.loadFailed':
    '⚠️ Repository connected but failed to load documents. Please try refreshing.',
} as const;
