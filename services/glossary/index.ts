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
