/**
 * Test file for utilities
 * Run with: pnpm test:unit
 */

import { sanitizeText, truncateText, isValidUrl } from '@/utils';

describe('Utility functions', () => {
  describe('sanitizeText', () => {
    it('should sanitize HTML characters', () => {
      const input = '<script>alert("xss")</script>';
      const expected = '&lt;script&gt;alert("xss")&lt;/script&gt;';
      expect(sanitizeText(input)).toBe(expected);
    });

    it('should handle ampersands', () => {
      const input = 'Ben & Jerry\'s';
      const expected = 'Ben &amp; Jerry\'s';
      expect(sanitizeText(input)).toBe(expected);
    });
  });

  describe('truncateText', () => {
    it('should truncate long text', () => {
      const input = 'This is a very long text that should be truncated';
      const result = truncateText(input, 20);
      expect(result).toBe('This is a very lo...');
      expect(result.length).toBe(20);
    });

    it('should not truncate short text', () => {
      const input = 'Short text';
      const result = truncateText(input, 20);
      expect(result).toBe('Short text');
    });
  });

  describe('isValidUrl', () => {
    it('should validate correct URLs', () => {
      expect(isValidUrl('https://github.com')).toBe(true);
      expect(isValidUrl('http://localhost:3000')).toBe(true);
      expect(isValidUrl('ftp://example.com')).toBe(true);
    });

    it('should reject invalid URLs', () => {
      expect(isValidUrl('not-a-url')).toBe(false);
      expect(isValidUrl('github.com')).toBe(false);
      expect(isValidUrl('')).toBe(false);
    });
  });
});