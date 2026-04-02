const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const mode = process.argv[2] || 'check';

if (!['check', 'write'].includes(mode)) {
  console.error(`Unsupported mode: ${mode}. Use "check" or "write".`);
  process.exit(1);
}

const repoRoot = process.cwd();
const supportedExtensions = new Set(['.js', '.cjs', '.mjs', '.ts', '.tsx', '.jsx', '.json']);

function readNullDelimitedGitOutput(args) {
  const output = execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  return output
    .split('\0')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function getChangedFiles() {
  const changed = new Set([
    ...readNullDelimitedGitOutput(['diff', '--name-only', '--diff-filter=ACMR', '-z']),
    ...readNullDelimitedGitOutput(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']),
    ...readNullDelimitedGitOutput(['ls-files', '--others', '--exclude-standard', '-z']),
  ]);

  return [...changed]
    .map((file) => file.replace(/\\/g, '/'))
    .filter((file) => supportedExtensions.has(path.extname(file)))
    .filter((file) => fs.existsSync(path.join(repoRoot, file)))
    .sort();
}

const files = getChangedFiles();

if (files.length === 0) {
  console.log('No changed Biome-supported files found.');
  process.exit(0);
}

const biomeArgs = ['@biomejs/biome', 'check'];
if (mode === 'write') {
  biomeArgs.push('--write');
}
biomeArgs.push(...files);

const result = spawnSync('npx', biomeArgs, {
  cwd: repoRoot,
  stdio: 'inherit',
});

process.exit(result.status ?? 1);
