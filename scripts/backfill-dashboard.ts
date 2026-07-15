/**
 * Backfills the awareness-dashboard qa_events table from the historical
 * interaction logs (data/logs/user-interactions-*.jsonl). Reuses the live
 * recorder so backfilled events are anonymized, paraphrased, hashed, and gated
 * identically — only the timestamp differs (the original is preserved).
 *
 * Usage:
 *   pnpm backfill:dashboard [--workspace <id>] [--force]
 *
 * Not idempotent: it appends. It refuses to run against a workspace that already
 * has events unless --force is given (so a re-run doesn't duplicate rows).
 */
import fs from 'node:fs';
import path from 'node:path';
import * as dotenv from 'dotenv';
import { mapWithConcurrency } from 'services/common/concurrency';
import { getDataPath } from 'services/common/data-path';
import { recordQaEvent } from 'services/dashboard/qa-event-recorder';
import { countQaEvents } from 'services/dashboard/qa-event-store';
import { closeDatabase } from 'services/db/connection';

dotenv.config();

interface ProcessQuestionLog {
  action?: string;
  workspaceId?: string;
  userId?: string;
  channelType?: string;
  messageContent?: string;
  timestamp?: string;
  metadata?: {
    canAnswer?: boolean;
    searchResults?: number;
    relevantDocs?: any[];
  };
}

function parseArgs(argv: string[]): { workspace?: string; force: boolean } {
  let workspace: string | undefined;
  let force = false;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--workspace') workspace = argv[++i];
    else if (argv[i] === '--force') force = true;
  }
  return { workspace, force };
}

function readAllQuestionLogs(workspaceFilter?: string): ProcessQuestionLog[] {
  const logDir = getDataPath('logs');
  if (!fs.existsSync(logDir)) return [];

  const out: ProcessQuestionLog[] = [];
  for (const file of fs.readdirSync(logDir)) {
    if (!file.endsWith('.jsonl')) continue;
    const content = fs.readFileSync(path.join(logDir, file), 'utf-8');
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      let entry: ProcessQuestionLog;
      try {
        entry = JSON.parse(line);
      } catch {
        continue; // skip malformed lines rather than abort the whole backfill
      }
      if (entry.action !== 'process_question') continue;
      if (!entry.workspaceId || !entry.userId || !entry.messageContent) continue;
      if (workspaceFilter && entry.workspaceId !== workspaceFilter) continue;
      out.push(entry);
    }
  }
  return out;
}

async function main(): Promise<void> {
  const { workspace, force } = parseArgs(process.argv);

  const logs = readAllQuestionLogs(workspace);
  if (logs.length === 0) {
    console.log('No process_question log entries found to backfill.');
    return;
  }

  const workspaces = [...new Set(logs.map((l) => l.workspaceId as string))];
  console.log(`Found ${logs.length} question(s) across ${workspaces.length} workspace(s).`);

  for (const ws of workspaces) {
    const existing = countQaEvents(ws);
    if (existing > 0 && !force) {
      console.warn(`Skipping ${ws}: already has ${existing} qa_events (pass --force to append anyway).`);
      continue;
    }

    const wsLogs = logs.filter((l) => l.workspaceId === ws);
    const before = countQaEvents(ws);

    // Small concurrency: each event makes one paraphrase LLM call; cap the fan-out.
    await mapWithConcurrency(wsLogs, 4, async (entry) => {
      const at = entry.timestamp ? Date.parse(entry.timestamp) : undefined;
      await recordQaEvent({
        workspaceId: ws,
        userId: entry.userId as string,
        question: entry.messageContent as string,
        canAnswer: entry.metadata?.canAnswer === true,
        searchResults: entry.metadata?.searchResults ?? entry.metadata?.relevantDocs?.length ?? 0,
        channelType: entry.channelType,
        relevantDocs: entry.metadata?.relevantDocs,
        at: Number.isFinite(at) ? at : undefined,
      });
    });

    const added = countQaEvents(ws) - before;
    console.log(`Workspace ${ws}: backfilled ${added}/${wsLogs.length} (rest gated out or paraphrase-skipped).`);
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
