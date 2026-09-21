/**
 * What making this meeting note will cost, before the dialog's "만들기".
 *
 * Unlike the PDF estimate next door, this one asks nothing: a transcript is
 * text, the prompts are built locally, and counting characters is both free and
 * accurate enough. The PDF path has to call the token-count endpoint because a
 * page image's cost cannot be modelled; here there are no images.
 *
 * The prompts counted are the real ones — `buildChunkPrompt` and
 * `buildReducePrompt`, with the same glossary block the conversion will get.
 * An estimate built from a different payload than the one that gets sent is a
 * number nobody should approve a bill against.
 */

import type { GlossaryEntry } from 'services/glossary/parse';
import { estimateTokens } from 'services/glossary/prompt-block';
import { type PdfServiceTier, loadPdfImportConfig } from '../pdf/config';
import { estimateUsd } from '../pdf/estimate';
import type { LoadedTranscript } from '../text';
import { chunkSegments, renderSegments, resolveSpeakerMap } from './convert';
import type { MeetingMeta } from './meta';
import { buildChunkPrompt, buildReducePrompt } from './prompts';

/**
 * What the reduce step writes on top of the record: five summary lines, a
 * handful of decisions, a task table and the topic list. Measured as a flat
 * budget because it does not grow with the meeting — a three-hour meeting has
 * about as many decisions as a one-hour one, it just has more transcript.
 */
const REDUCE_OUTPUT_TOKENS = 1500;

/**
 * Output tokens per source character. A cleaned record is the same words minus
 * the filler, so the output is roughly the input — a quarter of a token per
 * character is the same Latin-text ratio the rest of the pipeline assumes.
 */
const OUTPUT_TOKENS_PER_CHAR = 0.25;

export interface MeetingImportEstimate {
  utterances: number;
  speakers: number;
  /** Absent when the transcript carried no clock. */
  minutes?: number;
  chunks: number;
  inputTokens: number;
  estimatedOutputTokens: number;
  /** Absent when we do not know what the configured model costs. */
  estimatedUsd?: number;
  model: string;
  serviceTier: string;
}

export interface EstimateMeetingImportParams {
  transcript: LoadedTranscript;
  meta: MeetingMeta;
  model: string;
  serviceTier?: PdfServiceTier;
  /** Must be the glossary the conversion will be given, for the same reason as PDF. */
  glossary?: GlossaryEntry[];
  /** Rendered block, when the caller has already built one. */
  glossaryBlock?: string;
  aliasGroups?: string[][];
}

export function estimateMeetingImport(params: EstimateMeetingImportParams): MeetingImportEstimate {
  const { transcript, meta } = params;
  const serviceTier = params.serviceTier ?? loadPdfImportConfig().serviceTier;

  const speakerMap = resolveSpeakerMap(transcript.stats.speakers, meta.participants, params.aliasGroups ?? []);
  const chunks = chunkSegments(transcript.segments);
  const glossaryBlock = params.glossaryBlock ?? '';

  let inputTokens = 0;
  for (let index = 0; index < chunks.length; index += 1) {
    inputTokens += estimateTokens(
      buildChunkPrompt({
        index: index + 1,
        total: chunks.length,
        transcript: renderSegments(chunks[index]),
        participants: meta.participants,
        context: meta.context,
        glossaryBlock,
        aliasGroups: params.aliasGroups,
        speakerMap,
      }),
    );
  }

  if (meta.format === 'notes') {
    // The reduce step's input is the chunk summaries, which do not exist yet.
    // Six bullets a chunk is what the prompt asks for; at ~120 characters each
    // that is the only part of this estimate that is a guess.
    const summaries = chunks.map(() => '- '.padEnd(120, 'x'));
    inputTokens += estimateTokens(
      buildReducePrompt({
        summaries,
        participants: meta.participants,
        context: meta.context,
        glossaryBlock,
        aliasGroups: params.aliasGroups,
        speakerMap,
      }),
    );
  }

  const estimatedOutputTokens =
    Math.ceil(transcript.stats.chars * OUTPUT_TOKENS_PER_CHAR) + (meta.format === 'notes' ? REDUCE_OUTPUT_TOKENS : 0);

  return {
    utterances: transcript.stats.utterances,
    speakers: transcript.stats.speakers.length,
    ...(transcript.stats.durationSeconds
      ? { minutes: Math.max(1, Math.round(transcript.stats.durationSeconds / 60)) }
      : {}),
    chunks: chunks.length,
    inputTokens,
    estimatedOutputTokens,
    estimatedUsd: estimateUsd(params.model, inputTokens, estimatedOutputTokens, serviceTier),
    model: params.model,
    serviceTier,
  };
}
