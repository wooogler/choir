/**
 * Transcript → meeting note.
 *
 * The map-reduce the design asks for: the utterances are cut into chunks on
 * utterance boundaries, each chunk is cleaned and summarised in its own request,
 * and — for the 회의록 format — one last request turns the summaries into the
 * structured sections. The "정리된 transcript" format stops after the map, which
 * is the whole difference between the two.
 *
 * Two things wrap every request. The glossary block, participants and the
 * manager's one-line context go into all of them, because a chunk that does not
 * know the project's words will mis-transcribe them exactly as the recording
 * did; and the anonymization service goes around all of them, so the names in
 * this workspace's Slack never reach the model unmasked.
 *
 * See docs/meeting-notes-and-glossary.md, "변환 파이프라인".
 */

import { anonymizeText, deAnonymizeText } from 'services/anonymization/anonymization-service';
import { Logger } from 'services/common/logger';
import type { GlossaryEntry, GlossaryLanguage } from 'services/glossary/parse';
import { estimateTokens, glossaryPromptBlock } from 'services/glossary/prompt-block';
import type { ConvertedDocument, ImportProgressListener, ImportWarning } from 'services/import/types';
import { ImportRefusal } from 'services/import/types';
import type { Locale } from '../../../../src/i18n';
import { pickDocumentLanguage } from '../../source-note';
import { type PdfImportConfig, loadPdfImportConfig } from '../pdf/config';
import { fidelityScore } from '../pdf/fidelity';
import { type PdfLlmClient, buildChunkRequest, resolvePdfLlm, stripCodeFence } from '../pdf/llm-convert';
import type { LoadedTranscript, Segment } from '../text';
import type { MeetingMeta } from './meta';
import { buildChunkPrompt, buildReducePrompt, parseChunkOutput, parseReduceOutput } from './prompts';
import { type MeetingSections, emptyMeetingSections, renderMeetingNote } from './template';

/**
 * Roughly 6k tokens of transcript per request (design: "약 6k 토큰 단위").
 * Small enough that the prompt, the glossary and the answer all fit beside it
 * with room to spare, large enough that an hour of talk is a handful of calls
 * rather than dozens.
 */
export const MEETING_CHUNK_TOKENS = 6000;

/**
 * Below this 5-gram coverage the cleaned record is suspect.
 *
 * Higher than the PDF's 0.85 would be wrong and lower would be useless: cleaning
 * legitimately deletes filler and stutters, so a faithful record scores below a
 * transcription. 0.8 is what separates "the filler is gone" from "the meeting
 * was summarised", which is the failure this exists to catch.
 */
export const MEETING_FIDELITY_THRESHOLD = 0.8;

/** The glossary budget the PDF path uses; the same block, the same cap. */
const GLOSSARY_MAX_TOKENS = 1500;

export interface ConvertMeetingParams {
  workspaceId: string;
  /** Who asked, for the logs. The draft store is what actually owns it. */
  userId?: string;
  transcript: LoadedTranscript;
  meta: MeetingMeta;
  /** The name the file was uploaded under; absent for a paste. */
  filename?: string;
  onProgress?: ImportProgressListener;
  client?: PdfLlmClient;
  model?: string;
  config?: PdfImportConfig;
  /** Injected by the route, which has already loaded the target folder's chain. */
  glossary?: GlossaryEntry[];
  /** Spellings the project knows belong together, from `members.aliases`. */
  aliasGroups?: string[][];
  /** Overrides `pickDocumentLanguage`; the estimate and the tests pass it. */
  language?: Locale;
}

export interface ConvertedMeeting extends ConvertedDocument {
  /** Terms the model did not recognise, for the glossary card in a later stage. */
  unknownTerms: string[];
  /** Speaker label → participant name, as far as the server could resolve it. */
  speakerMap: Record<string, string>;
}

export async function convertMeeting(params: ConvertMeetingParams): Promise<ConvertedMeeting> {
  const { workspaceId, transcript, meta } = params;
  const config = params.config ?? loadPdfImportConfig();
  const warnings: ImportWarning[] = [];

  report(params.onProgress, { step: 'checking', label: 'Reading the transcript' });

  const speakerMap = resolveSpeakerMap(transcript.stats.speakers, meta.participants, params.aliasGroups ?? []);
  const unknownSpeakers = transcript.stats.speakers.filter((label) => !speakerMap[label]).length;

  const sourceText = transcript.segments.map((segment) => segment.text).join('\n');
  const language = params.language ?? (await pickDocumentLanguage(workspaceId, `${meta.title}\n${sourceText}`));
  const glossaryLanguage: GlossaryLanguage = language === 'ko' ? 'ko' : 'en';

  const glossaryBlock = glossaryPromptBlock(params.glossary ?? [], {
    text: `${sourceText}\n${meta.context ?? ''}`,
    maxTokens: GLOSSARY_MAX_TOKENS,
    language: glossaryLanguage,
  });

  const chunks = chunkSegments(transcript.segments);
  const { client, model } = await resolvePdfLlm(workspaceId, params.client, params.model);

  const records: string[] = [];
  const summaries: string[] = [];
  const unknownTerms: string[] = [];

  for (let index = 0; index < chunks.length; index += 1) {
    report(params.onProgress, {
      step: 'converting',
      label: `Cleaning the transcript (${index + 1}/${chunks.length})`,
      current: index + 1,
      total: chunks.length,
    });

    const prompt = buildChunkPrompt({
      index: index + 1,
      total: chunks.length,
      transcript: renderSegments(chunks[index]),
      participants: meta.participants,
      context: meta.context,
      glossaryBlock,
      aliasGroups: params.aliasGroups,
      speakerMap,
      language: glossaryLanguage,
    });

    const answer = await ask(client, model, prompt, workspaceId, config);
    const parsed = parseChunkOutput(answer);
    if (parsed.record) records.push(parsed.record);
    if (parsed.summary.length > 0) summaries.push(parsed.summary.map((line) => `- ${line}`).join('\n'));
    unknownTerms.push(...parsed.unknownTerms);
  }

  const fullRecord = records.join('\n\n').trim();
  if (!fullRecord) {
    // Nothing usable came back from any chunk. A note whose 전체 기록 is empty is
    // not worth a commit, and the manager's key already paid for the attempt.
    throw new ImportRefusal(502, 'import_conversion_failed', { message: 'The model returned no cleaned record' });
  }

  let sections: MeetingSections = emptyMeetingSections(fullRecord);
  if (meta.format === 'notes') {
    report(params.onProgress, { step: 'converting', label: 'Writing the summary and decisions' });
    const reduced = parseReduceOutput(
      await ask(
        client,
        model,
        buildReducePrompt({
          summaries: summaries.length > 0 ? summaries : [fullRecord],
          participants: meta.participants,
          context: meta.context,
          glossaryBlock,
          aliasGroups: params.aliasGroups,
          speakerMap,
          language: glossaryLanguage,
        }),
        workspaceId,
        config,
      ),
    );
    sections = { ...reduced, fullRecord };
  }

  // Cleaning removes filler by design, so this warns rather than refuses — the
  // manager reads the preview. Scored against the utterances *with their
  // speakers*, because the record writes `**Name**:` between them: comparing
  // against the bare words would fail every gram that straddles a speaker
  // change, and a faithful hour-long note would cry wolf on arithmetic alone.
  const score = fidelityScore(fidelitySourceText(transcript.segments, speakerMap), fullRecord);
  if (score < MEETING_FIDELITY_THRESHOLD) {
    warnings.push({
      code: 'low_fidelity',
      detail: {
        score: Math.round(score * 100) / 100,
        // Carried on the same warning rather than as one of its own: there is no
        // warning code for unmapped speakers, and a record that is both short
        // and full of `Speaker 2` is one problem, not two.
        ...(unknownSpeakers > 0 ? { unknownSpeakers } : {}),
      },
    });
  } else if (unknownSpeakers > 0) {
    Logger.info('Meeting import: some speaker labels stayed unmapped', {
      workspaceId,
      operation: 'import.meeting.convert',
      unknownSpeakers,
      speakers: transcript.stats.speakers.length,
    });
  }

  report(params.onProgress, { step: 'ready', label: 'Meeting note ready' });

  const minutes = transcript.stats.durationSeconds
    ? Math.max(1, Math.round(transcript.stats.durationSeconds / 60))
    : undefined;

  return {
    markdown: renderMeetingNote({ meta, language, sections }),
    title: meta.title,
    assets: [],
    rejectedAssets: [],
    warnings,
    source: {
      kind: 'meeting',
      name: params.filename ?? 'pasted transcript',
      ...(minutes ? { minutes } : {}),
      ...(transcript.stats.speakers.length > 0 ? { speakers: transcript.stats.speakers.length } : {}),
    },
    unknownTerms: dedupe(unknownTerms),
    speakerMap,
  };
}

/**
 * The transcript as the cleaned record would have written it: each utterance
 * behind the name the record uses for that speaker. Only the fidelity check
 * reads this — everything else wants the words on their own.
 */
function fidelitySourceText(segments: Segment[], speakerMap: Record<string, string>): string {
  return segments
    .map((segment) => {
      const name = segment.speaker ? (speakerMap[segment.speaker] ?? segment.speaker) : '';
      return name ? `${name}: ${segment.text}` : segment.text;
    })
    .join('\n');
}

// ── Speakers ───────────────────────────────────────────────────────────────

/**
 * Which speaker labels are which participant, decided here rather than by the
 * model.
 *
 * Only the certain cases: a label that *is* a participant's name, and a label
 * that shares an alias group with one. `Speaker 2` and `참석자 1` stay unmapped —
 * the prompt asks the model to place them when the conversation makes it
 * obvious, and what it does there cannot be observed from the outside, so the
 * map this returns is deliberately only what the server itself could prove.
 *
 * The project's alias groups carry no names (they are keyed by Slack user ID and
 * the repository stores no roster), which is why the participant list is what
 * gives a group its name: a group containing both `SW` and `이상욱`, with
 * `이상욱` in the room, resolves `SW`.
 */
export function resolveSpeakerMap(
  labels: string[],
  participants: string[],
  aliasGroups: string[][],
): Record<string, string> {
  const byKey = new Map<string, string>();
  for (const participant of participants) byKey.set(key(participant), participant);

  for (const group of aliasGroups) {
    const named = group.find((alias) => byKey.has(key(alias)));
    if (!named) continue;
    const participant = byKey.get(key(named)) as string;
    for (const alias of group) {
      if (!alias.trim()) continue;
      if (!byKey.has(key(alias))) byKey.set(key(alias), participant);
    }
  }

  const map: Record<string, string> = {};
  for (const label of labels) {
    const participant = byKey.get(key(label));
    // A label that already reads exactly as the participant is not a mapping
    // worth reporting, but it is still "known", so it belongs in the map.
    if (participant) map[label] = participant;
  }
  return map;
}

/** Case, spacing and honorific punctuation are spelling, not identity. */
function key(name: string): string {
  return name
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s.()[\]·_-]+/g, '');
}

// ── Chunking ───────────────────────────────────────────────────────────────

/**
 * Cuts the utterances into request-sized runs, never inside one.
 *
 * A sentence split across two requests is a sentence neither of them can clean:
 * the first has no end and the second has no speaker. An utterance that is on
 * its own bigger than a chunk still goes alone rather than being cut.
 */
export function chunkSegments(segments: Segment[], maxTokens = MEETING_CHUNK_TOKENS): Segment[][] {
  const chunks: Segment[][] = [];
  let current: Segment[] = [];
  let tokens = 0;

  for (const segment of segments) {
    const cost = estimateTokens(renderSegment(segment));
    if (current.length > 0 && tokens + cost > maxTokens) {
      chunks.push(current);
      current = [];
      tokens = 0;
    }
    current.push(segment);
    tokens += cost;
  }

  if (current.length > 0) chunks.push(current);
  return chunks;
}

/** One utterance per line, the way the source wrote it. */
export function renderSegments(segments: Segment[]): string {
  return segments.map((segment) => renderSegment(segment)).join('\n');
}

function renderSegment(segment: Segment): string {
  return segment.speaker ? `${segment.speaker}: ${segment.text}` : segment.text;
}

// ── The call ───────────────────────────────────────────────────────────────

/**
 * One request, with the names masked on the way out and restored on the way in.
 *
 * `anonymizeText` replaces the workspace's real names with the pseudonyms this
 * process already uses everywhere else it talks to a model, so the mapping — and
 * therefore the restoration — is the same one the QA path uses. Masking the
 * prompt covers the participants, the alias groups and the transcript in one
 * pass, which is why it is applied to the finished prompt rather than to each
 * piece as it is built.
 */
async function ask(
  client: PdfLlmClient,
  model: string,
  prompt: string,
  workspaceId: string,
  config: PdfImportConfig,
): Promise<string> {
  const request = buildChunkRequest({
    model,
    input: [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: anonymizeText(prompt, workspaceId) }],
      },
    ],
    serviceTier: config.serviceTier,
  });

  let response: Awaited<ReturnType<PdfLlmClient['responses']['create']>>;
  try {
    response = await client.responses.create(request);
  } catch (error) {
    // Flex trades price for capacity, so "no capacity" is an expected answer.
    // Copied from the PDF path rather than imported: `isCapacityError` is
    // private to llm-convert.ts, which this stage may not edit.
    if (config.serviceTier !== 'flex' || !isCapacityError(error)) throw error;
    Logger.warn('Meeting import: flex tier unavailable, retrying at the standard tier', {
      workspaceId,
      operation: 'import.meeting.convert',
    });
    response = await client.responses.create({ ...request, service_tier: 'default' });
  }

  return deAnonymizeText(stripCodeFence(response.output_text ?? ''), workspaceId);
}

/** 429, or an explicit `resource_unavailable`, both of which mean "try elsewhere". */
function isCapacityError(error: unknown): boolean {
  const candidate = error as { status?: number; code?: string; message?: string; error?: { code?: string } };
  if (candidate?.status === 429) return true;
  const code = candidate?.code ?? candidate?.error?.code ?? '';
  return /resource_unavailable/i.test(code) || /resource_unavailable/i.test(candidate?.message ?? '');
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const value of values) {
    const term = value.trim();
    if (!term) continue;
    const lowered = term.toLowerCase();
    if (seen.has(lowered)) continue;
    seen.add(lowered);
    kept.push(term);
  }
  return kept;
}

/** Progress is decoration: a listener that throws must not lose the conversion. */
function report(listener: ImportProgressListener | undefined, event: Parameters<ImportProgressListener>[0]): void {
  if (!listener) return;
  try {
    listener(event);
  } catch {
    // See above.
  }
}
