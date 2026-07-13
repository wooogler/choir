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
   * Get or create anonymization mapping for a user
   */
  getAnonymizationMapping(
    userId: string,
    realName: string,
    nickname?: string,
  ): {
    realName: string;
    fakeName: string;
    nickname?: string;
    fakeNickname: string;
  } {
    let mapping = this.anonymizationData.anonymization[userId];

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
        const usedNames = new Set(Object.values(this.anonymizationData.anonymization).map((entry) => entry.fakeName));
        const { fakeName, fakeNickname } = generateFakeName(usedNames);

        mapping = {
          realName,
          fakeName,
          nickname,
          fakeNickname,
          lastUsed: new Date().toISOString(),
        };
      }
      this.anonymizationData.anonymization[userId] = mapping;
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
  anonymizeText(text: string): string {
    let anonymizedText = text;

    // Sort mappings by lastUsed (most recent first) to handle duplicate names
    const sortedMappings = Object.entries(this.anonymizationData.anonymization).sort(
      ([, a], [, b]) => new Date(b.lastUsed).getTime() - new Date(a.lastUsed).getTime(),
    );

    for (const [userId, mapping] of sortedMappings) {
      // Replace user ID mentions first
      const userMentionRegex = new RegExp(`<@${userId}>`, 'g');
      anonymizedText = anonymizedText.replace(userMentionRegex, mapping.fakeNickname);

      // Replace nickname first (highest priority)
      if (mapping.nickname) {
        anonymizedText = anonymizedText.replace(this.buildNameRegex(mapping.nickname), mapping.fakeNickname);
      }

      // Replace full name with nickname only
      anonymizedText = anonymizedText.replace(this.buildNameRegex(mapping.realName), mapping.fakeNickname);

      // Replace first name (extracted from real name) with nickname only
      const firstName = mapping.realName.split(' ')[0];
      if (firstName && firstName !== mapping.nickname) {
        anonymizedText = anonymizedText.replace(this.buildNameRegex(firstName), mapping.fakeNickname);
      }
    }

    return anonymizedText;
  }

  /**
   * De-anonymize text by replacing fake names with real names
   */
  deAnonymizeText(text: string): string {
    if (!text || typeof text !== 'string') {
      return text || '';
    }

    let deAnonymizedText = text;

    // Sort mappings by lastUsed (most recent first) to handle duplicate names
    const sortedMappings = Object.entries(this.anonymizationData.anonymization).sort(
      ([, a], [, b]) => new Date(b.lastUsed).getTime() - new Date(a.lastUsed).getTime(),
    );

    for (const [, mapping] of sortedMappings) {
      // Replace fake full name with real name
      deAnonymizedText = deAnonymizedText.replace(this.buildNameRegex(mapping.fakeName), mapping.realName);

      // Replace fake nickname with real nickname (if exists) or first name
      const realNickname = mapping.nickname || mapping.realName.split(' ')[0];
      deAnonymizedText = deAnonymizedText.replace(this.buildNameRegex(mapping.fakeNickname), realNickname);
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
   * correctly regardless of script. (Names directly fused with a suffix — e.g. a
   * Korean particle — are still not split; that needs morphological analysis.)
   */
  private buildNameRegex(name: string): RegExp {
    return new RegExp(`(?<![\\p{L}\\p{N}])${this.escapeRegex(name)}(?![\\p{L}\\p{N}])`, 'gu');
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
