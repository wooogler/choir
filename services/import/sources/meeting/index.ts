/**
 * "회의록 만들기": a meeting transcript becomes a repository document.
 *
 * The barrel the route imports. `../text` does the parsing, this half does the
 * meeting: what the manager told us (`meta`), what the model is asked
 * (`prompts`), what it costs (`estimate`), what comes out (`template`), and the
 * pipeline that runs it (`convert`).
 *
 * See docs/meeting-notes-and-glossary.md.
 */

export {
  MEETING_CHUNK_TOKENS,
  MEETING_FIDELITY_THRESHOLD,
  type ConvertMeetingParams,
  type ConvertedMeeting,
  chunkSegments,
  convertMeeting,
  renderSegments,
  resolveSpeakerMap,
} from './convert';

export { estimateMeetingImport } from './estimate';
export type { EstimateMeetingImportParams, MeetingImportEstimate } from './estimate';

export { MEETING_FORMATS, meetingTargetPath, parseMeetingMeta } from './meta';
export type { MeetingFormat, MeetingMeta } from './meta';

export { resolveMeetingModel } from './model';

export { getMeetingUploadStore } from './meeting-upload-store';
export type { MeetingUploadPayload } from './meeting-upload-store';

export { buildChunkPrompt, buildReducePrompt, parseChunkOutput, parseReduceOutput } from './prompts';
export type { ChunkOutput, ChunkPromptParams, MeetingPromptContext, ReduceOutput, ReducePromptParams } from './prompts';

export { emptyMeetingSections, renderMeetingNote } from './template';
export type {
  MeetingActionItem,
  MeetingDiscussionTopic,
  MeetingSections,
  RenderMeetingNoteParams,
} from './template';
