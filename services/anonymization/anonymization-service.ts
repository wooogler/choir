import * as fs from 'node:fs';
import * as path from 'node:path';
import { getDataPath } from 'services/common/data-path';
import { generateFakeName } from './name-dictionary';

export interface AnonymizationMapping {
  [userId: string]: {
    realName: string;
    fakeName: string;
    nickname?: string;
    fakeNickname: string;
    lastUsed: string;
  };
}

export interface AnonymizationData {
  anonymization: AnonymizationMapping;
}

/**
 * Korean honorifics that fuse onto a name with no space: 김철수님, 철수씨, 김교수님.
 */
const KOREAN_HONORIFICS = [
  '교수님',
  '선생님',
  '박사님',
  '팀장님',
  '대표님',
  '과장님',
  '부장님',
  '선배',
  '후배',
  '교수',
  '박사',
  '팀장',
  '대표',
  '님',
  '씨',
  '군',
  '양',
];

/**
 * Korean case/topic particles that fuse onto a name with no space: 김철수가, 김철수에게.
 */
const KOREAN_PARTICLES = [
  '이라고',
  '라고',
  '에게',
  '께서',
  '이랑',
  '하고',
  '에서',
  '으로',
  '한테',
  '부터',
  '까지',
  '처럼',
  '보다',
  '이나',
  '이야',
  '께',
  '의',
  '도',
  '만',
  '와',
  '과',
  '랑',
  '로',
  '나',
  '야',
  '이',
  '가',
  '은',
  '는',
  '을',
  '를',
];

/** Longest alternatives first so `에게` wins over `에`, `이랑` over `이`. */
function alternation(suffixes: readonly string[]): string {
  return [...suffixes].sort((a, b) => b.length - a.length).join('|');
}

/**
 * Optional honorific followed by an optional particle (`님` + `이` covers 김철수님이),
 * wrapped in ONE capture group so a replacement can put the suffix back verbatim.
 * Every alternative is Hangul, so this can never extend a Latin name: `John` still
 * refuses to match inside `Johnson` because the trailing boundary lookahead applies
 * after the (empty) suffix.
 */
const NAME_SUFFIX_PATTERN = `((?:${alternation(KOREAN_HONORIFICS)})?(?:${alternation(KOREAN_PARTICLES)})?)`;

/** True when the name contains any Hangul (used to pick a matching pseudonym pool). */
function isHangulName(name: string): boolean {
  return /\p{Script=Hangul}/u.test(name);
}

const HANGUL_ONLY = /^\p{Script=Hangul}+$/u;

/**
 * AnonymizationService handles all anonymization and de-anonymization operations
 * Maintains mappings between real and fake names for privacy protection
 */
export class AnonymizationService {
  private cacheDir: string;
  private cacheFile: string;
  private anonymizationData: AnonymizationData;

  constructor() {
    this.cacheDir = getDataPath('cache');
    this.cacheFile = path.join(this.cacheDir, 'anonymization-mappings.json');
    this.anonymizationData = { anonymization: {} };
    this.ensureCacheDirectory();
    this.loadData();
  }

  private ensureCacheDirectory(): void {
    if (!fs.existsSync(this.cacheDir)) {
      fs.mkdirSync(this.cacheDir, { recursive: true });
    }
  }

  private loadData(): void {
    try {
      if (fs.existsSync(this.cacheFile)) {
        const data = fs.readFileSync(this.cacheFile, 'utf-8').trim();
        if (data) {
          this.anonymizationData = JSON.parse(data);
        }
      }
    } catch (error) {
      console.warn('Failed to load anonymization data, starting with empty data:', error);
      this.anonymizationData = { anonymization: {} };
    }
  }

  private saveData(): void {
    try {
      fs.writeFileSync(this.cacheFile, JSON.stringify(this.anonymizationData, null, 2));
    } catch (error) {
      console.error('Failed to save anonymization data:', error);
    }
  }

  /**
   * Mappings are keyed by `${workspaceId}:${userId}` so that fake↔real names are
   * scoped to a single workspace: without this, a fake nickname minted in one
   * workspace would de-anonymize to that workspace's real user inside another
   * workspace's LLM answers (cross-tenant PII leak). A missing workspaceId falls
   * back to the bare userId (legacy/global) for callers that can't supply one.
   */
  private mappingKey(userId: string, workspaceId?: string): string {
    return workspaceId ? `${workspaceId}:${userId}` : userId;
  }

  /** Recover the userId from a mapping key (handles both composite and legacy). */
  private userIdFromKey(key: string): string {
    const separatorIndex = key.indexOf(':');
    return separatorIndex >= 0 ? key.slice(separatorIndex + 1) : key;
  }

  /** Mapping entries scoped to a workspace (all entries when no workspace given). */
  private scopedEntries(workspaceId?: string): Array<[string, AnonymizationMapping[string]]> {
    const all = Object.entries(this.anonymizationData.anonymization);
    if (!workspaceId) return all;
    const prefix = `${workspaceId}:`;
    return all.filter(([key]) => key.startsWith(prefix));
  }

  /**
   * Get or create anonymization mapping for a user (scoped to a workspace).
   */
  getAnonymizationMapping(
    userId: string,
    realName: string,
    nickname?: string,
    workspaceId?: string,
  ): {
    realName: string;
    fakeName: string;
    nickname?: string;
    fakeNickname: string;
  } {
    const key = this.mappingKey(userId, workspaceId);
    let mapping = this.anonymizationData.anonymization[key];

    if (!mapping) {
      // Special case: Keep CHOIR as CHOIR (don't anonymize the bot)
      if (realName === 'CHOIR') {
        mapping = {
          realName,
          fakeName: 'CHOIR',
          nickname,
          fakeNickname: 'CHOIR',
          lastUsed: new Date().toISOString(),
        };
      } else {
        // Only avoid fake-name collisions WITHIN the same workspace.
        const usedNames = new Set(this.scopedEntries(workspaceId).map(([, entry]) => entry.fakeName));
        // Hangul real names get Hangul pseudonyms so the masked text still reads as
        // Korean (and so fused particles stay grammatical-looking) for the LLM.
        const { fakeName, fakeNickname } = generateFakeName(usedNames, isHangulName(realName));

        mapping = {
          realName,
          fakeName,
          nickname,
          fakeNickname,
          lastUsed: new Date().toISOString(),
        };
      }
      this.anonymizationData.anonymization[key] = mapping;
      this.saveData();
    } else {
      // Update last used timestamp
      mapping.lastUsed = new Date().toISOString();
      this.saveData();
    }

    return mapping;
  }

  /**
   * Anonymize text by replacing real names with fake names
   */
  anonymizeText(text: string, workspaceId?: string): string {
    let anonymizedText = text;

    // Sort mappings by lastUsed (most recent first) to handle duplicate names
    const sortedMappings = this.scopedEntries(workspaceId).sort(
      ([, a], [, b]) => new Date(b.lastUsed).getTime() - new Date(a.lastUsed).getTime(),
    );

    for (const [key, mapping] of sortedMappings) {
      const userId = this.userIdFromKey(key);
      // Replace user ID mentions first
      const userMentionRegex = new RegExp(`<@${userId}>`, 'g');
      anonymizedText = anonymizedText.replace(userMentionRegex, mapping.fakeNickname);

      // Replace nickname first (highest priority)
      if (mapping.nickname) {
        anonymizedText = this.replaceName(anonymizedText, mapping.nickname, mapping.fakeNickname);
      }

      // Replace full name with nickname only
      anonymizedText = this.replaceName(anonymizedText, mapping.realName, mapping.fakeNickname);

      // Replace first name (extracted from real name) with nickname only
      const firstName = this.firstNameOf(mapping.realName);
      if (firstName && firstName !== mapping.nickname) {
        anonymizedText = this.replaceName(anonymizedText, firstName, mapping.fakeNickname);
      }
    }

    return anonymizedText;
  }

  /**
   * De-anonymize text by replacing fake names with real names
   */
  deAnonymizeText(text: string, workspaceId?: string): string {
    if (!text || typeof text !== 'string') {
      return text || '';
    }

    let deAnonymizedText = text;

    // Sort mappings by lastUsed (most recent first) to handle duplicate names
    const sortedMappings = this.scopedEntries(workspaceId).sort(
      ([, a], [, b]) => new Date(b.lastUsed).getTime() - new Date(a.lastUsed).getTime(),
    );

    for (const [, mapping] of sortedMappings) {
      // Replace fake full name with real name
      deAnonymizedText = this.replaceName(deAnonymizedText, mapping.fakeName, mapping.realName);

      // Replace fake nickname with real nickname (if exists) or first name. Names with
      // no space (Korean full names) have no separable first name, so the whole real
      // name is restored — which is exactly what anonymizeText masked.
      const realNickname = mapping.nickname || this.firstNameOf(mapping.realName) || mapping.realName;
      deAnonymizedText = this.replaceName(deAnonymizedText, mapping.fakeNickname, realNickname);
    }

    return deAnonymizedText;
  }

  /**
   * Helper method to escape regex special characters
   */
  private escapeRegex(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * Builds a "whole name" matcher that works in any script. JavaScript's `\b`
   * is ASCII-only, so `\b김철수\b` never matches and Korean/CJK names would be
   * sent to the LLM unmasked. Unicode letter/number lookarounds bound the name
   * correctly regardless of script.
   *
   * Korean fuses honorifics and particles straight onto the name with no space
   * (김철수가, 김철수를, 김철수님이, 철수씨), which the trailing lookaround alone
   * rejects — leaking the real name to the LLM. So an optional honorific+particle
   * from a fixed list may sit between the name and the boundary. It is captured
   * (group 1) so `replaceName` can put it back verbatim: only the name is swapped.
   */
  private buildNameRegex(name: string): RegExp {
    return new RegExp(`(?<![\\p{L}\\p{N}])${this.escapeRegex(name)}${NAME_SUFFIX_PATTERN}(?![\\p{L}\\p{N}])`, 'gu');
  }

  /**
   * Swaps `name` for `replacement` everywhere it stands alone, keeping any fused
   * Korean suffix byte-for-byte (김철수가 → Alex가). Preserving the original particle
   * rather than re-deriving it is what makes anonymize → de-anonymize round-trip
   * exactly; Korean 이/가 and 을/를 alternate on the final consonant of the *name*,
   * and "fixing" that would rewrite text we are only supposed to mask.
   * A function replacer is used so `$&`/`$1` inside a real name are never expanded.
   */
  private replaceName(text: string, name: string, replacement: string): string {
    return text.replace(this.buildNameRegex(name), (_match: string, suffix: string) => `${replacement}${suffix}`);
  }

  /**
   * The space-separated given name used as an extra alias ("John Smith" → "John").
   * Returns null when the real name has no space: Korean/CJK full names (김철수) are
   * written as one token, so there is nothing to split. We deliberately do NOT slice
   * off the surname syllable — a one-syllable Hangul "first name" (이, 강, 안 …) is
   * also a common particle/ordinary word and would mis-mask half the message. Such
   * names are masked whole, and a given-name-only mention (철수씨) is covered by the
   * stored Slack nickname instead. The same guard rejects the surname token of a
   * spaced Hangul name ("김 철수" → "김").
   */
  private firstNameOf(realName: string): string | null {
    const [first, ...rest] = realName.trim().split(/\s+/);
    if (!first || rest.length === 0) return null;
    if (HANGUL_ONLY.test(first) && first.length < 2) return null;
    return first;
  }

  /** Removes all anonymization mappings for a workspace (used on uninstall). */
  purgeWorkspace(workspaceId: string): number {
    const prefix = `${workspaceId}:`;
    let removed = 0;
    for (const key of Object.keys(this.anonymizationData.anonymization)) {
      if (key.startsWith(prefix)) {
        delete this.anonymizationData.anonymization[key];
        removed += 1;
      }
    }
    if (removed > 0) this.saveData();
    return removed;
  }

  /**
   * Get all anonymization mappings
   */
  getAllMappings(): AnonymizationMapping {
    return this.anonymizationData.anonymization;
  }

  /**
   * Import anonymization mappings from name-mappings.json
   */
  importFromNameMappings(nameMappingsPath: string): void {
    try {
      if (fs.existsSync(nameMappingsPath)) {
        const data = JSON.parse(fs.readFileSync(nameMappingsPath, 'utf-8'));
        if (data.anonymization) {
          this.anonymizationData.anonymization = { ...this.anonymizationData.anonymization, ...data.anonymization };
          this.saveData();
          console.log('Successfully imported anonymization mappings');
        }
      }
    } catch (error) {
      console.error('Failed to import anonymization mappings:', error);
    }
  }

  /**
   * Get anonymization statistics
   */
  getStats(): {
    totalMappings: number;
    cacheFile: string;
  } {
    return {
      totalMappings: Object.keys(this.anonymizationData.anonymization).length,
      cacheFile: this.cacheFile,
    };
  }
}

// Singleton instance
export const anonymizationService = new AnonymizationService();

// Convenience functions
export const getAnonymizationMapping = anonymizationService.getAnonymizationMapping.bind(anonymizationService);
export const anonymizeText = anonymizationService.anonymizeText.bind(anonymizationService);
export const deAnonymizeText = anonymizationService.deAnonymizeText.bind(anonymizationService);
