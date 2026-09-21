/**
 * The viewer's client for "회의록 만들기" (`/api/docs/:ws/import/meeting…`).
 *
 * Two calls rather than one, and that order is the feature: the transcript and
 * the meeting's details go up together, the server parses and prices them
 * without calling a model, and only a second request spends the workspace's
 * key. So `estimateMeetingNote` is free and `convertMeetingNote` is not, and
 * the dialog puts a button between them.
 *
 * Separate from `import-api.ts` for the reason the routes are separate: an
 * import asks where the document should land afterwards, while a meeting note
 * is told before anything runs. The NDJSON reader is shared rather than copied
 * — `requestStream` is the same one the PDF and URL conversions use.
 *
 * The wire types are declared here rather than imported from
 * `services/import/sources/meeting`: the server module pulls in the whole
 * import pipeline, and the viewer's bundle may only share import-free modules
 * (`__tests__/web-shared-modules.test.ts`).
 *
 * See docs/meeting-notes-and-glossary.md, 사용자 흐름 1단계.
 */

import type { ServerErrorPayload, T } from '../i18n';
import { describeApiError, errorPayload } from './api-error';
import { type DraftResult, ImportApiError, type ImportProgressHandler, requestStream } from './import-api';

/** 회의록, or the cleaned transcript that is the same document without the analysis. */
export type MeetingFormat = 'notes' | 'transcript';

/** The meeting details the manager typed; the server validates every field. */
export interface MeetingMetaInput {
  title: string;
  /** `YYYY-MM-DD`, the day the meeting happened. */
  date: string;
  /** Repository-relative folder, no leading or trailing slash. `''` is the root. */
  folder: string;
  /** Basename only, ending in `.md`. */
  fileName: string;
  participants: string[];
  context?: string;
  format: MeetingFormat;
}

/** The transcript itself: an uploaded file, or text pasted into the dialog. */
export interface MeetingSourceInput {
  filename?: string;
  /** The file's bytes, base64 — a JSON body so the details cannot travel separately. */
  contentBase64?: string;
  text?: string;
}

/** What the parse made of the file, before a single model call. */
export interface MeetingDetected {
  /** `vtt`, `srt`, `transcript-text`, `docx`, `markdown`, `plain` — or whatever a newer server detects. */
  kind: string;
  speakers: string[];
  utterances: number;
  /** Absent when the transcript carried no clock. */
  minutes?: number;
}

export interface MeetingEstimate {
  utterances: number;
  speakers: number;
  minutes?: number;
  chunks: number;
  inputTokens: number;
  estimatedOutputTokens: number;
  /** Absent when we do not know what the configured model costs. */
  estimatedUsd?: number;
  model: string;
  serviceTier: string;
}

/** A parked transcript: parsed, priced, and waiting for a yes. */
export interface MeetingUpload {
  uploadId: string;
  /** Milliseconds since the epoch. */
  expiresAt: number;
  detected: MeetingDetected;
  estimate: MeetingEstimate;
  /** Where the note will be committed — already decided, unlike every other import. */
  targetPath: string;
}

/** An ordinary import draft, plus the two things only a meeting produces. */
export interface MeetingDraftResult extends DraftResult {
  /** Names and acronyms the model did not recognise, for the glossary card. */
  unknownTerms: string[];
  /** Speaker label → participant name, as far as the server could resolve it. */
  speakerMap: Record<string, string>;
}

/** `loadTranscript`'s ceiling, checked here so a refused upload is not sent. */
export const TRANSCRIPT_MAX_BYTES = 5 * 1024 * 1024;

/** Everything the transcript parser will open, mirroring `sources/text/detect.ts`. */
export const TRANSCRIPT_EXTENSIONS = ['vtt', 'srt', 'docx', 'md', 'markdown', 'txt', 'text'] as const;

/** What the file picker offers, in the order the design lists them. */
export const TRANSCRIPT_ACCEPT = '.vtt,.srt,.txt,.docx,.md';

/**
 * Whether the parser would even open this file. A name with no extension is
 * not a refusal: a browser may hand over a file called `transcript`.
 */
export function isSupportedTranscriptName(filename: string): boolean {
  const base = filename.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return true;
  const extension = base.slice(dot + 1).toLowerCase();
  return (TRANSCRIPT_EXTENSIONS as readonly string[]).includes(extension);
}

/** The sentence to show for a failed meeting call, in the reader's language. */
export function describeMeetingError(t: T, error: unknown, fallback: string): string {
  return describeApiError(t, error, fallback);
}

function meetingBase(workspaceId: string): string {
  return `/api/docs/${encodeURIComponent(workspaceId)}/import/meeting`;
}

/**
 * The file as the JSON body carries it.
 *
 * Chunked because `String.fromCharCode(...bytes)` on a five-megabyte array is
 * a stack overflow, not a string.
 */
export async function readFileAsBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const CHUNK = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
  }
  return btoa(binary);
}

/**
 * Parses and prices the transcript. No model is called, so this is the number
 * the manager approves before the workspace's key is billed.
 */
export async function estimateMeetingNote(
  workspaceId: string,
  body: MeetingSourceInput & { meta: MeetingMetaInput },
): Promise<MeetingUpload> {
  const response = await fetch(meetingBase(workspaceId), {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new ImportApiError((await errorPayload(response)) as ServerErrorPayload, response.status);
  }
  return (await response.json()) as MeetingUpload;
}

/** "Yes, make it." Streams its steps and ends in a draft. */
export function convertMeetingNote(
  workspaceId: string,
  uploadId: string,
  onProgress?: ImportProgressHandler,
): Promise<MeetingDraftResult> {
  return requestStream<MeetingDraftResult>(
    `${meetingBase(workspaceId)}/${encodeURIComponent(uploadId)}/convert`,
    { method: 'POST' },
    onProgress,
  );
}
