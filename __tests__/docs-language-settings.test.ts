import { needsManager, parseLanguageUpdate } from '../services/docs-editor/language-settings';

/**
 * The rules behind `PUT /api/docs/:workspaceId/language`: what the settings
 * dialog may ask for, and which asks belong to the workspace rather than the
 * reader.
 */
describe('language settings update', () => {
  it('keeps the fields the caller sent and leaves the rest alone', () => {
    const parsed = parseLanguageUpdate({ mine: 'ko' });
    expect(parsed).toEqual({ ok: true, update: { mine: 'ko' } });
  });

  it('accepts auto, which clears a personal preference', () => {
    const parsed = parseLanguageUpdate({ mine: 'auto' });
    expect(parsed.ok && parsed.update.mine).toBe('auto');
  });

  it('accepts follow-conversation for document content', () => {
    const parsed = parseLanguageUpdate({ content: 'follow-conversation' });
    expect(parsed.ok && parsed.update.content).toBe('follow-conversation');
  });

  it('accepts all three at once', () => {
    const parsed = parseLanguageUpdate({ mine: 'en', workspace: 'ko', content: 'en' });
    expect(parsed).toEqual({ ok: true, update: { mine: 'en', workspace: 'ko', content: 'en' } });
  });

  it('treats an empty body as changing nothing', () => {
    expect(parseLanguageUpdate({})).toEqual({ ok: true, update: {} });
    expect(parseLanguageUpdate(undefined)).toEqual({ ok: true, update: {} });
    expect(parseLanguageUpdate(null)).toEqual({ ok: true, update: {} });
  });

  it('rejects a language nobody has a catalog for', () => {
    expect(parseLanguageUpdate({ mine: 'fr' })).toEqual({ ok: false, code: 'invalid_language', field: 'mine' });
    expect(parseLanguageUpdate({ workspace: 'fr' })).toEqual({
      ok: false,
      code: 'invalid_language',
      field: 'workspace',
    });
    expect(parseLanguageUpdate({ content: 'fr' })).toEqual({ ok: false, code: 'invalid_language', field: 'content' });
  });

  it('rejects auto for the workspace default, which has to name a language', () => {
    expect(parseLanguageUpdate({ workspace: 'auto' })).toEqual({
      ok: false,
      code: 'invalid_language',
      field: 'workspace',
    });
  });

  it('rejects follow-conversation for a person, who is not a document', () => {
    expect(parseLanguageUpdate({ mine: 'follow-conversation' })).toEqual({
      ok: false,
      code: 'invalid_language',
      field: 'mine',
    });
  });

  it('rejects a non-string value', () => {
    expect(parseLanguageUpdate({ mine: 42 }).ok).toBe(false);
    expect(parseLanguageUpdate({ workspace: null }).ok).toBe(false);
  });

  // A body with one good and one bad value must not have the good half applied,
  // so validation reports the failure before the route writes anything.
  it('fails the whole update when any field is unsupported', () => {
    expect(parseLanguageUpdate({ mine: 'ko', workspace: 'de' })).toEqual({
      ok: false,
      code: 'invalid_language',
      field: 'workspace',
    });
  });

  describe('who may make the change', () => {
    it('lets anyone set their own language', () => {
      expect(needsManager({ mine: 'ko' })).toBe(false);
      expect(needsManager({})).toBe(false);
    });

    it('requires a manager for the workspace default and the content policy', () => {
      expect(needsManager({ workspace: 'ko' })).toBe(true);
      expect(needsManager({ content: 'follow-conversation' })).toBe(true);
      expect(needsManager({ mine: 'ko', workspace: 'ko' })).toBe(true);
    });
  });
});
