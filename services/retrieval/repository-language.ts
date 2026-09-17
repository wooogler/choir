import fs from 'node:fs';
import path from 'node:path';
import { type LanguageCode, detectDocumentLanguage } from 'services/common/language';

/**
 * The dominant language of a workspace's documentation.
 *
 * Retrieval needs it to decide whether a question has to be translated before
 * it can reach the vectors: a Korean question over an English repository never
 * lands near the right chunk, because the embedding of the question and the
 * embeddings of the documents live in different language neighbourhoods.
 *
 * This is a sample, not a census — reading every section of a large mirror on
 * every store init would cost more than the answer is worth, and the dominant
 * language of a repository is stable enough that the first N files settle it.
 */

const DEFAULT_SAMPLE_SIZE = 25;
/** Enough prose to judge a file by; a whole section file is usually smaller. */
const MAX_BYTES_PER_FILE = 8000;

async function collectSampleFiles(root: string, sampleSize: number): Promise<string[]> {
  const files: string[] = [];
  const stack: string[] = [root];

  while (stack.length > 0 && files.length < sampleSize) {
    const current = stack.pop();
    if (!current) continue;

    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }

    // Sorted so the sample is deterministic across processes and restarts.
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (files.length >= sampleSize) break;

      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        files.push(fullPath);
      }
    }
  }

  return files;
}

/**
 * Guesses the language the mirrored documentation is written in by voting
 * {@link detectDocumentLanguage} over a sample of section files. Falls back to
 * `en` for an empty, unreadable or tied sample.
 */
export async function detectRepositoryLanguage(
  sectionsRoot: string,
  sampleSize = DEFAULT_SAMPLE_SIZE,
): Promise<LanguageCode> {
  const files = await collectSampleFiles(sectionsRoot, sampleSize);
  const votes = new Map<LanguageCode, number>();

  for (const file of files) {
    let content: string;
    try {
      const handle = await fs.promises.open(file, 'r');
      try {
        const buffer = Buffer.alloc(MAX_BYTES_PER_FILE);
        const { bytesRead } = await handle.read(buffer, 0, MAX_BYTES_PER_FILE, 0);
        content = buffer.subarray(0, bytesRead).toString('utf-8');
      } finally {
        await handle.close();
      }
    } catch {
      continue;
    }

    if (!content.trim()) continue;

    const language = detectDocumentLanguage(content);
    votes.set(language, (votes.get(language) ?? 0) + 1);
  }

  let winner: LanguageCode = 'en';
  let winnerVotes = 0;
  for (const [language, count] of votes) {
    if (count > winnerVotes) {
      winner = language;
      winnerVotes = count;
    }
  }

  return winner;
}
