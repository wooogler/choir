/**
 * Parsed transcripts waiting for the manager to say "만들기".
 *
 * The same three-call shape as the PDF upload, for the same reason: the dialog
 * shows a price before anything is spent, and between the price and the decision
 * the transcript has to live somewhere. Asking the manager to upload an hour of
 * Zoom export twice would be the alternative.
 *
 * It reuses `UploadStore` rather than copying it — same TTL, same per-user
 * count, same byte ceiling across the process — because those rules are about
 * the process's memory, not about what is being held. The store is generic over
 * its payload, which is the only change that was needed.
 */

import { UploadStore } from '../../upload-store';
import type { LoadedTranscript } from '../text';
import type { MeetingImportEstimate } from './estimate';
import type { MeetingMeta } from './meta';

export interface MeetingUploadPayload {
  workspaceId: string;
  userId: string;
  /**
   * The transcript as it arrived. Kept beside the parsed form because it is what
   * the byte ceiling counts — the segments are a view of these same words, and
   * bounding one bounds the other.
   */
  bytes: Buffer;
  /** Absent for a paste. */
  filename?: string;
  transcript: LoadedTranscript;
  meta: MeetingMeta;
  estimate: MeetingImportEstimate;
}

let singleton: UploadStore<MeetingUploadPayload> | null = null;

/** The process-wide store. Created on first use so config is read after env is set. */
export function getMeetingUploadStore(): UploadStore<MeetingUploadPayload> {
  if (!singleton) singleton = new UploadStore<MeetingUploadPayload>();
  return singleton;
}
