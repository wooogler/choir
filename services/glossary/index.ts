/**
 * The glossary: the organization's own words, kept as `GLOSSARY.md` files in
 * the documentation repository itself.
 *
 * See docs/meeting-notes-and-glossary.md, 용어집.
 */

export { GLOSSARY_TEMPLATE, glossaryTableHeader, parseGlossaryMarkdown, splitAliases } from './parse';
export type { GlossaryEntry, GlossaryLanguage } from './parse';
export { DEFAULT_GLOSSARY_FILE, clearGlossaryCache, glossaryFileFor, loadAllGlossaries, loadGlossary } from './load';
export type { LoadGlossaryOptions, LoadedGlossary } from './load';
export { estimateTokens, glossaryPromptBlock, mentions } from './prompt-block';
export type { GlossaryPromptBlockOptions } from './prompt-block';
export { appendGlossaryRows, escapeCell } from './table';
export type { AppendGlossaryRowsOptions, AppendGlossaryRowsResult, GlossaryRowInput } from './table';
export { CHUNK_MAX_TOKENS, MAX_CANDIDATES, chunkMarkdown, extractGlossaryCandidates } from './extract';
export type {
  ExtractGlossaryCandidatesParams,
  GlossaryCandidate,
  GlossaryCandidateKind,
  GlossaryLlmClient,
} from './extract';
// `./commit` is deliberately NOT re-exported: it reaches the GitHub client
// (octokit, ESM-only), which would make every consumer of this barrel — the
// Q&A path, the PDF prompt, the meeting converter — pay for a dependency they
// never use, and would break their jest suites. Import it from './commit'.
export type { CommitGlossaryRowsParams, CommitGlossaryRowsResult, GlossaryCreateAt } from './commit';
// `./routes` is deliberately absent, for the same reason services/import's
// barrel omits its own: it reaches the docs-editor and the draft store, and
// everything that only wants to read a glossary would pull those in with it.
