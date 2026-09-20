/**
 * What a project folder's `.choir/project.json` holds, and the hand-written
 * validation standing between a caller-supplied object and a commit.
 *
 * Kept a pure module with no service graph behind it, like
 * `services/docs-editor/document-path`: this is what decides whether a string
 * from the browser may become a file in someone's repository, so it should be
 * cheap to test and impossible to accidentally couple to GitHub.
 *
 * Validation is by hand rather than with a schema library because the rest of
 * the repository validates by hand, and because the refusal has to be a
 * sentence a manager can act on ("channels[1] is not a Slack channel ID")
 * rather than a library's path expression.
 *
 * See docs/project-folders.md sections 1 and 7.
 */

/** Where a project's metadata lives, relative to the project folder. */
export const PROJECT_FILE = '.choir/project.json';

/** The only schema version written today. */
export const PROJECT_VERSION = 1;

export type MemberSource = 'channels' | 'curated';
export type RetrievalScope = 'boost' | 'exclusive' | 'off';
export type UpdateScope = 'folder' | 'workspace';

export interface ProjectMembersSettings {
  /** 'channels': every non-bot member of the linked channels. 'curated': `curated` only. */
  source: MemberSource;
  /** Slack user IDs, consulted only when `source === 'curated'`. */
  curated: string[];
  /**
   * Dictation-correction and speaker-label spellings, keyed by Slack user ID.
   * Names are deliberately not stored — the GUI resolves them live, so the
   * repository never carries a roster (docs/project-folders.md 1).
   */
  aliases: Record<string, string[]>;
}

export interface ProjectScopeSettings {
  retrieval: RetrievalScope;
  updates: UpdateScope;
}

export interface ProjectSettings {
  version: typeof PROJECT_VERSION;
  name: string;
  description: string;
  /** Slack channel IDs. One channel belongs to at most one project. */
  channels: string[];
  members: ProjectMembersSettings;
  scope: ProjectScopeSettings;
  /** Default folder for meeting notes, relative to the project folder. */
  meetingsFolder: string;
  /** The project glossary document, relative to the project folder. */
  glossary: string;
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; message: string };

const CHANNEL_ID = /^[CG][A-Z0-9]+$/;
const USER_ID = /^[UW][A-Z0-9]+$/;

const SETTINGS_KEYS = [
  'version',
  'name',
  'description',
  'channels',
  'members',
  'scope',
  'meetingsFolder',
  'glossary',
] as const;
const MEMBERS_KEYS = ['source', 'curated', 'aliases'] as const;
const SCOPE_KEYS = ['retrieval', 'updates'] as const;

const MEMBER_SOURCES: readonly string[] = ['channels', 'curated'];
const RETRIEVAL_SCOPES: readonly string[] = ['boost', 'exclusive', 'off'];
const UPDATE_SCOPES: readonly string[] = ['folder', 'workspace'];

export const DEFAULT_MEETINGS_FOLDER = 'meetings';
export const DEFAULT_GLOSSARY = 'GLOSSARY.md';

/**
 * Names a project folder may never take: `assets/` holds committed binaries and
 * `.choir/` holds CHOIR's own metadata, and neither is a place whose *contents*
 * are a project. Mirrors RESERVED_PREFIXES in services/docs-editor/document-path,
 * which is not imported here so this module stays free of `node:path`'s
 * markdown-shaped assumptions.
 */
const RESERVED_SEGMENTS = new Set(['.choir', 'assets']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The first unexpected key, so the refusal can name it. */
function unknownKey(value: Record<string, unknown>, allowed: readonly string[]): string | undefined {
  return Object.keys(value).find((key) => !allowed.includes(key));
}

/**
 * A repository-relative folder path, or null.
 *
 * The repository root is deliberately NOT a project (docs/project-folders.md 2):
 * a question from an unlinked channel searches everything, and a root project
 * would make that impossible to express. So `''` is refused rather than
 * accepted as "the whole repository".
 */
export function normalizeProjectFolder(candidate: unknown): string | null {
  if (typeof candidate !== 'string') return null;

  const trimmed = candidate.trim().replace(/^\/+/, '').replace(/\/+$/, '');
  if (!trimmed) return null;

  const segments = trimmed.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.length === 0) return null;
  if (segments.some((segment) => segment === '..')) return null;
  if (segments.some((segment) => RESERVED_SEGMENTS.has(segment))) return null;
  // A backslash would be a path separator on the mirror's filesystem but a
  // literal character to GitHub, so the two would disagree about where the file
  // is. Refuse rather than pick one.
  if (segments.some((segment) => segment.includes('\\'))) return null;

  return segments.join('/');
}

/**
 * A relative path inside the project folder (`meetings`, `docs/GLOSSARY.md`).
 * Same containment rules as the folder itself, but an empty result is allowed
 * to mean "the project folder", which `meetingsFolder` never uses today and
 * `glossary` cannot reach (it must end in `.md`).
 */
function normalizeRelativePath(candidate: string): string | null {
  const trimmed = candidate.trim().replace(/^\/+/, '').replace(/\/+$/, '');
  const segments = trimmed.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.some((segment) => segment === '..' || segment.includes('\\'))) return null;
  return segments.join('/');
}

function parseStringArray(value: unknown, field: string, pattern: RegExp, label: string): ParseResult<string[]> {
  if (!Array.isArray(value)) return { ok: false, message: `${field} must be an array` };

  const seen = new Set<string>();
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== 'string' || !pattern.test(entry.trim())) {
      return { ok: false, message: `${field}[${index}] is not ${label}` };
    }
    // A hand-edited file can repeat an entry; the GUI's multi-select cannot.
    // Dropping the repeat is what the caller meant either way.
    seen.add(entry.trim());
  }
  // Sorted here as well as at serialization, so a parsed value compares equal
  // to the one read back out of the file it was written to.
  return { ok: true, value: [...seen].sort() };
}

function parseMembers(value: unknown): ParseResult<ProjectMembersSettings> {
  if (value === undefined) {
    return { ok: true, value: { source: 'channels', curated: [], aliases: {} } };
  }
  if (!isPlainObject(value)) return { ok: false, message: 'members must be an object' };

  const extra = unknownKey(value, MEMBERS_KEYS);
  if (extra) return { ok: false, message: `members.${extra} is not a known setting` };

  const source = value.source ?? 'channels';
  if (typeof source !== 'string' || !MEMBER_SOURCES.includes(source)) {
    return { ok: false, message: "members.source must be 'channels' or 'curated'" };
  }

  const curated =
    value.curated === undefined
      ? { ok: true as const, value: [] }
      : parseStringArray(value.curated, 'members.curated', USER_ID, 'a Slack user ID');
  if (!curated.ok) return curated;

  const aliases: Record<string, string[]> = {};
  if (value.aliases !== undefined) {
    if (!isPlainObject(value.aliases)) return { ok: false, message: 'members.aliases must be an object' };
    for (const [userId, spellings] of Object.entries(value.aliases)) {
      if (!USER_ID.test(userId)) {
        return { ok: false, message: `members.aliases has a key (${userId}) that is not a Slack user ID` };
      }
      if (!Array.isArray(spellings) || spellings.some((entry) => typeof entry !== 'string')) {
        return { ok: false, message: `members.aliases.${userId} must be an array of strings` };
      }
      const cleaned = (spellings as string[]).map((entry) => entry.trim()).filter(Boolean);
      // An empty list is the same as no entry, and leaving it out keeps the
      // file from growing a row per person the manager opened and closed.
      if (cleaned.length > 0) aliases[userId] = [...new Set(cleaned)];
    }
  }

  return { ok: true, value: { source: source as MemberSource, curated: curated.value, aliases } };
}

function parseScope(value: unknown): ParseResult<ProjectScopeSettings> {
  if (value === undefined) return { ok: true, value: { retrieval: 'boost', updates: 'folder' } };
  if (!isPlainObject(value)) return { ok: false, message: 'scope must be an object' };

  const extra = unknownKey(value, SCOPE_KEYS);
  if (extra) return { ok: false, message: `scope.${extra} is not a known setting` };

  const retrieval = value.retrieval ?? 'boost';
  if (typeof retrieval !== 'string' || !RETRIEVAL_SCOPES.includes(retrieval)) {
    return { ok: false, message: "scope.retrieval must be 'boost', 'exclusive' or 'off'" };
  }
  const updates = value.updates ?? 'folder';
  if (typeof updates !== 'string' || !UPDATE_SCOPES.includes(updates)) {
    return { ok: false, message: "scope.updates must be 'folder' or 'workspace'" };
  }

  return { ok: true, value: { retrieval: retrieval as RetrievalScope, updates: updates as UpdateScope } };
}

/**
 * Validates one `.choir/project.json` body — from the GUI's PUT, or from the
 * repository where someone may have edited it by hand.
 *
 * `version` may be absent (the GUI sends settings without it) but a version
 * this build does not understand is refused rather than coerced: writing it
 * back as version 1 would silently drop whatever a newer CHOIR put there.
 */
export function parseProjectSettings(json: unknown): ParseResult<ProjectSettings> {
  if (!isPlainObject(json)) return { ok: false, message: 'expected a JSON object' };

  const extra = unknownKey(json, SETTINGS_KEYS);
  if (extra) return { ok: false, message: `${extra} is not a known setting` };

  if (json.version !== undefined && json.version !== PROJECT_VERSION) {
    return { ok: false, message: `unsupported version ${String(json.version)}` };
  }

  if (typeof json.name !== 'string' || !json.name.trim()) {
    return { ok: false, message: 'name is required' };
  }

  if (json.description !== undefined && typeof json.description !== 'string') {
    return { ok: false, message: 'description must be a string' };
  }

  const channels =
    json.channels === undefined
      ? { ok: true as const, value: [] }
      : parseStringArray(json.channels, 'channels', CHANNEL_ID, 'a Slack channel ID');
  if (!channels.ok) return channels;

  const members = parseMembers(json.members);
  if (!members.ok) return members;

  const scope = parseScope(json.scope);
  if (!scope.ok) return scope;

  let meetingsFolder = DEFAULT_MEETINGS_FOLDER;
  if (json.meetingsFolder !== undefined) {
    if (typeof json.meetingsFolder !== 'string') {
      return { ok: false, message: 'meetingsFolder must be a string' };
    }
    const normalized = normalizeRelativePath(json.meetingsFolder);
    if (normalized === null) {
      return { ok: false, message: 'meetingsFolder must be a relative path inside the project folder' };
    }
    meetingsFolder = normalized || DEFAULT_MEETINGS_FOLDER;
  }

  let glossary = DEFAULT_GLOSSARY;
  if (json.glossary !== undefined) {
    if (typeof json.glossary !== 'string') {
      return { ok: false, message: 'glossary must be a string' };
    }
    const normalized = normalizeRelativePath(json.glossary);
    if (normalized === null) {
      return { ok: false, message: 'glossary must be a relative path inside the project folder' };
    }
    // The glossary is indexed as a document, and the mirror walk matches `.md`
    // case-sensitively, so the extension is lowercased rather than merely
    // accepted (same reason as normalizeDocumentPath).
    const lowered = normalized.replace(/\.md$/i, '.md');
    if (!lowered.endsWith('.md')) {
      return { ok: false, message: 'glossary must be a markdown file' };
    }
    glossary = lowered;
  }

  return {
    ok: true,
    value: {
      version: PROJECT_VERSION,
      name: json.name.trim(),
      description: typeof json.description === 'string' ? json.description.trim() : '',
      channels: channels.value,
      members: members.value,
      scope: scope.value,
      meetingsFolder,
      glossary,
    },
  };
}

/**
 * The file's text, in a fixed key order.
 *
 * Stable order is what keeps a save that changed one channel from producing a
 * diff across the whole file — this is committed to the manager's repository,
 * where the diff is read by people.
 */
export function serializeProjectSettings(value: ProjectSettings): string {
  const ordered = {
    version: value.version,
    name: value.name,
    description: value.description,
    channels: [...value.channels].sort(),
    members: {
      source: value.members.source,
      curated: [...value.members.curated].sort(),
      aliases: Object.fromEntries(Object.entries(value.members.aliases).sort(([a], [b]) => a.localeCompare(b))),
    },
    scope: {
      retrieval: value.scope.retrieval,
      updates: value.scope.updates,
    },
    meetingsFolder: value.meetingsFolder,
    glossary: value.glossary,
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}
