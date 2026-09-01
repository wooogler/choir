/**
 * Preload entry for the offline Google Docs loop:
 *
 *   ts-node -r tsconfig-paths/register -r ./scripts/dev/fake-google.ts app.ts
 *
 * or, in practice, `pnpm dev:local --fake-google`. Pulls in the Drive and GitHub
 * fakes so the replica → drift → review → approve state machine runs with no
 * Google account and no GitHub push rights. See docs/local-development.md.
 */
if ((process.env.NODE_ENV || '').toLowerCase() === 'production') {
  throw new Error('scripts/dev/fake-google is a development harness and must never load in production');
}

// `require` rather than `import` so the production guard above actually runs
// first — import statements are hoisted.
require('./fake-drive');
require('./fake-github');

console.log('[fake-google] Drive and GitHub writes are faked; nothing leaves this machine');
