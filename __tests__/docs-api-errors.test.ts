// The docs API's error codes cross a boundary the compiler only half covers:
// the server picks a code, the viewer picks the sentence, and the catalogs are
// plain data. `satisfies Record<DocsApiErrorCode, MessageKey>` in
// server-errors.ts already fails the build when a code has no key; what is left
// to check here is that the key it names actually exists in both catalogs, that
// the English on the wire and the English on screen still say the same thing,
// and that `describeServerError` keeps its promises to older servers.

import { DOCS_API_ERROR_MESSAGES, type DocsApiErrorCode, apiErrorBodyFor } from '../services/docs-editor/api-errors';
import { IMPORT_STEPS } from '../services/google/import-steps';
import { en } from '../web/src/i18n/locales/en';
import { ko } from '../web/src/i18n/locales/ko';
import { SERVER_ERROR_KEY, describeServerError, isDocsApiErrorCode } from '../web/src/i18n/server-errors';
import { createT } from '../web/src/i18n/translate';

const codes = Object.keys(DOCS_API_ERROR_MESSAGES) as DocsApiErrorCode[];
const t = createT('en');
const tKo = createT('ko');

describe('docs API error codes', () => {
  it('has a catalog key for every code', () => {
    expect(codes.length).toBeGreaterThan(20);
    for (const code of codes) {
      expect([code, SERVER_ERROR_KEY[code]]).toEqual([code, `serverError.${code}`]);
    }
  });

  it('ships that key in English and in Korean', () => {
    const missing = codes.filter((code) => en[SERVER_ERROR_KEY[code]] === undefined);
    const untranslated = codes.filter((code) => ko[SERVER_ERROR_KEY[code]] === undefined);
    expect(missing).toEqual([]);
    expect(untranslated).toEqual([]);
  });

  it('says the same thing on the wire and on screen', () => {
    // The point of keeping English on both sides: a reader in `en` sees exactly
    // what the server used to send, so this refactor is invisible to them.
    for (const code of codes) {
      expect([code, en[SERVER_ERROR_KEY[code]]]).toEqual([code, DOCS_API_ERROR_MESSAGES[code]]);
    }
  });

  it('never leaves a Korean sentence in English', () => {
    for (const code of codes) {
      expect([code, ko[SERVER_ERROR_KEY[code]]]).not.toEqual([code, DOCS_API_ERROR_MESSAGES[code]]);
    }
  });

  it('gives every import step a word in both catalogs', () => {
    for (const step of IMPORT_STEPS) {
      expect([step, typeof en[`import.step.${step}` as keyof typeof en]]).toEqual([step, 'string']);
      expect([step, typeof ko[`import.step.${step}` as keyof typeof en]]).toEqual([step, 'string']);
    }
  });
});

describe('apiErrorBodyFor', () => {
  it('sends the code as `error` and the English as `message`', () => {
    expect(apiErrorBodyFor('read_only_document')).toEqual({
      error: 'read_only_document',
      message: 'This document is marked read-only. Clear that in App Home before deleting it.',
    });
  });

  it('fills the English holes from `detail`, and keeps `detail` for the client', () => {
    expect(apiErrorBodyFor('import_path_exists', { path: 'a.md' })).toEqual({
      error: 'import_path_exists',
      message: 'a.md already exists in this repository',
      detail: { path: 'a.md' },
    });
  });
});

describe('describeServerError', () => {
  it('translates a code', () => {
    expect(describeServerError(t, { error: 'not_a_manager' })).toBe('User is not a workspace manager');
    expect(describeServerError(tKo, { error: 'not_a_manager' })).toBe('워크스페이스 매니저만 할 수 있어요.');
  });

  it('translates a bare code string — a write-access `reason` arrives as one', () => {
    expect(describeServerError(t, 'no_github_repo')).toBe('No GitHub repository is connected to this workspace yet.');
    expect(describeServerError(tKo, 'no_github_repo')).toBe('이 워크스페이스에는 아직 연결된 GitHub 저장소가 없어요.');
  });

  it('fills the holes from a `detail` object', () => {
    expect(describeServerError(t, apiErrorBodyFor('import_path_exists', { path: 'notes/a.md' }))).toBe(
      'notes/a.md already exists in this repository',
    );
    expect(describeServerError(tKo, apiErrorBodyFor('import_path_exists', { path: 'notes/a.md' }))).toBe(
      'notes/a.md는 이미 이 저장소에 있어요.',
    );
  });

  it('names the repository in a write-access refusal, in either language', () => {
    // What `GET /api/docs/session` now puts in `github`: the probe's code plus
    // the slug its sentence names, so the viewer's read-only banner is a
    // finished sentence rather than a template with `{repo}` showing.
    const blocked = { error: 'github_repo_read_only', detail: { repo: 'echo-lab/assets' } };
    expect(describeServerError(t, blocked)).toBe(
      'Your GitHub account has read-only access to echo-lab/assets. Ask a repository admin for Write access, then reload this page.',
    );
    expect(describeServerError(tKo, blocked)).toContain('echo-lab/assets');
    expect(describeServerError(tKo, blocked)).not.toContain('{repo}');
    expect(describeServerError(tKo, { error: 'github_no_token', detail: { repo: 'echo-lab/assets' } })).toBe(
      'echo-lab/assets를 편집하려면 CHOIR 앱 홈에서 GitHub 계정을 연결해 주세요.',
    );
  });

  it('reads a free-text `detail` as the {message} a sentence wraps', () => {
    expect(describeServerError(t, { error: 'republish_failed', detail: 'quota exceeded' })).toBe(
      'Could not republish this document from GitHub: quota exceeded',
    );
  });

  it('passes a legacy sentence through — an older server, or a GitHub domain error', () => {
    const sentence = 'Your GitHub account has read-only access to echo-lab/assets.';
    expect(describeServerError(t, sentence)).toBe(sentence);
    expect(describeServerError(tKo, { error: sentence, message: sentence })).toBe(sentence);
  });

  it('falls back to a free-text `detail`, which is all the review endpoints send', () => {
    expect(describeServerError(t, { detail: 'quota exceeded' })).toBe('quota exceeded');
  });

  it('has nothing to say about nothing, so the call site keeps its own fallback', () => {
    expect(describeServerError(t, undefined)).toBeUndefined();
    expect(describeServerError(t, null)).toBeUndefined();
    expect(describeServerError(t, {})).toBeUndefined();
    expect(describeServerError(t, '  ')).toBeUndefined();
  });

  it('recognises exactly the codes the server can send', () => {
    for (const code of codes) expect([code, isDocsApiErrorCode(code)]).toEqual([code, true]);
    expect(isDocsApiErrorCode('nope')).toBe(false);
    expect(isDocsApiErrorCode(undefined)).toBe(false);
  });
});
