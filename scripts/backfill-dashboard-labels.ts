/**
 * Backfills localized display labels for awareness-dashboard topics that were
 * clustered before the translation step existed (or before a locale was added).
 *
 * The English label stays the clustering key; this only fills in the
 * `labels_json` translations the dashboard API serves to readers of that
 * language. Topics that already have the locale are skipped, so the script is
 * idempotent and safe to re-run.
 *
 * Usage:
 *   pnpm backfill:dashboard:labels --workspace <id> [--locale ko] [--dry-run]
 *
 * With no --locale it fills every supported non-English locale.
 */
import * as dotenv from 'dotenv';
import { getTopics, setTopicLabels } from 'services/dashboard/qa-event-store';
import { TRANSLATED_LOCALES, makeDefaultTranslator } from 'services/dashboard/topic-clusterer';
import { closeDatabase } from 'services/db/connection';
import { type Locale, normalizeLocale } from '../src/i18n/supported-locales';

dotenv.config();

interface Args {
  workspace?: string;
  locales: Locale[];
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  let workspace: string | undefined;
  const locales: Locale[] = [];
  let dryRun = false;

  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--workspace') workspace = argv[++i];
    else if (argv[i] === '--locale') {
      const raw = argv[++i];
      const locale = normalizeLocale(raw);
      if (!locale || locale === 'en') {
        throw new Error(`--locale ${raw} is not a supported translation target (${TRANSLATED_LOCALES.join(', ')})`);
      }
      locales.push(locale);
    } else if (argv[i] === '--dry-run') dryRun = true;
  }

  return { workspace, locales: locales.length > 0 ? locales : TRANSLATED_LOCALES, dryRun };
}

async function main(): Promise<void> {
  const { workspace, locales, dryRun } = parseArgs(process.argv);
  if (!workspace) {
    console.error('Usage: pnpm backfill:dashboard:labels --workspace <id> [--locale ko] [--dry-run]');
    process.exitCode = 1;
    return;
  }

  const topics = getTopics(workspace);
  if (topics.length === 0) {
    console.log(`Workspace ${workspace}: no topics to label.`);
    return;
  }

  const translate = makeDefaultTranslator(workspace);
  let translated = 0;
  let skipped = 0;
  let failed = 0;

  for (const topic of topics) {
    const missing = locales.filter((locale) => !topic.labels[locale]);
    if (missing.length === 0) {
      skipped++;
      continue;
    }
    if (dryRun) {
      console.log(`[dry-run] topic ${topic.id} "${topic.label}" -> ${missing.join(', ')}`);
      translated++;
      continue;
    }

    const labels = { ...topic.labels };
    for (const locale of missing) {
      const result = await translate({ label: topic.label, representative: topic.representative }, locale);
      if (result) labels[locale] = result;
      else failed++;
    }
    setTopicLabels(topic.id, labels);
    translated++;
  }

  console.log(
    `Workspace ${workspace}: ${translated} topic(s) translated into ${locales.join(', ')}, ` +
      `${skipped} already complete, ${failed} translation call(s) failed (those stay English).`,
  );
}

main()
  .catch((error) => {
    console.error('Label backfill failed:', error);
    process.exitCode = 1;
  })
  .finally(() => {
    closeDatabase();
  });
