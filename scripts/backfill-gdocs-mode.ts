/**
 * Stamps `mode` onto Google Doc mappings that predate the field.
 *
 * `GoogleDocMapping.mode` decides whether publishing may replace a Doc's whole
 * body (see docs/gdocs-format-preserving-sync.md). Rather than defaulting a
 * missing mode — which would either flatten a document somebody wrote or
 * silently stop syncing a real replica — `publishReplica` refuses to act on a
 * mapping that has none. This script gives the existing ones the mode they
 * already have in practice: every Doc linked before this change was published
 * over wholesale, so it is a `replica`.
 *
 * Run it BEFORE deploying the code that requires the field, or linked documents
 * stop syncing until it has run.
 *
 * Usage:
 *   pnpm backfill:gdocs-mode [--workspace <id>] [--mode replica|preserve] [--dry-run]
 *
 * Idempotent: only mappings with no mode are touched, so a second run reports
 * nothing to do and rewrites no config. Use the viewer (or a targeted --mode
 * preserve run) to reclassify a document afterwards; this script will not
 * overwrite a mode that is already set.
 */
import * as dotenv from 'dotenv';
import { closeDatabase } from 'services/db/connection';
import { type GoogleDocMode, WorkspaceStore } from 'services/workspace/workspace-store';

dotenv.config();

interface Args {
  workspace?: string;
  mode: GoogleDocMode;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  let workspace: string | undefined;
  let mode: GoogleDocMode = 'replica';
  let dryRun = false;

  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--workspace') workspace = argv[++i];
    else if (argv[i] === '--mode') {
      const value = argv[++i];
      if (value !== 'replica' && value !== 'preserve') {
        throw new Error(`--mode must be replica or preserve, got ${JSON.stringify(value)}`);
      }
      mode = value;
    } else if (argv[i] === '--dry-run') dryRun = true;
  }

  return { workspace, mode, dryRun };
}

async function main() {
  const args = parseArgs(process.argv);
  const store = new WorkspaceStore();

  const configs = await store.getAllWorkspaceConfigs();
  const targets = args.workspace ? configs.filter((config) => config.workspaceId === args.workspace) : configs;

  if (args.workspace && targets.length === 0) {
    throw new Error(`No such workspace: ${args.workspace}`);
  }

  let stamped = 0;
  let alreadySet = 0;

  for (const config of targets) {
    const mappings = config.google?.docs ?? {};
    const unset = Object.entries(mappings).filter(([, mapping]) => !mapping.mode);
    alreadySet += Object.keys(mappings).length - unset.length;

    if (unset.length === 0) continue;

    if (args.dryRun) {
      console.log(`${config.workspaceId}: would stamp ${args.mode} on ${unset.length} mapping(s)`);
      for (const [githubPath] of unset) console.log(`    ${githubPath}`);
      stamped += unset.length;
      continue;
    }

    const changed = await store.setGoogleDocMode(config.workspaceId, args.mode, { onlyIfUnset: true });
    stamped += changed.length;
    console.log(`${config.workspaceId}: stamped ${args.mode} on ${changed.length} mapping(s)`);
    for (const githubPath of changed) console.log(`    ${githubPath}`);
  }

  console.log(
    `\n${args.dryRun ? '[dry run] ' : ''}${stamped} mapping(s) stamped ${args.mode}; ${alreadySet} already had a mode.`,
  );
  if (stamped === 0 && alreadySet === 0) {
    console.log('No Google Doc mappings exist in any workspace — nothing to do.');
  }
}

main()
  .catch((error) => {
    console.error('Backfill failed:', error);
    process.exitCode = 1;
  })
  .finally(() => {
    closeDatabase();
  });
