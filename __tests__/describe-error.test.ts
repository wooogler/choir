// `describeError` is the last English leak on the Slack path: every handler
// used to pour a raw `error.message` into an otherwise translated sentence.
// What matters here is the order of its three cases, because the fallbacks are
// what keep it honest — an untranslated GitHub sentence is still better than a
// translated shrug, and a shrug is still better than "undefined".

import { CHOIRUserError } from '../services/common/choir-error';
import { GitHubError } from '../services/common/error-handler';
import { getRepositoryAccessError } from '../services/github/repository-access';
import { describeError } from '../services/i18n/describe-error';
import { createT } from '../src/i18n';

const en = createT('en');
const ko = createT('ko');

describe('describeError', () => {
  it('renders a coded error in the reader’s language', () => {
    const error = new CHOIRUserError(
      'llm.noApiKey',
      'No OpenAI API key configured. Set it from App Home or via OPENAI_API_KEY.',
    );

    expect(describeError(ko, error)).toBe(
      'OpenAI API 키가 없어요. 앱 홈에서 등록하거나 OPENAI_API_KEY 환경 변수를 설정해 주세요.',
    );
    // English reads exactly as it did before the code existed.
    expect(describeError(en, error)).toBe(error.message);
  });

  it('fills the throw site’s params into the translation', () => {
    const error = new GitHubError('Concurrent modification of docs/guide.md while committing; aborting', {
      code: 'github.concurrentModification',
      params: { path: 'docs/guide.md' },
    });

    expect(describeError(ko, error)).toContain('docs/guide.md');
    expect(describeError(ko, error)).toContain('덮어쓰지 않으려고');
  });

  it('keeps the English message when the code is not one we translate', () => {
    // The write-failure classifier mints codes like this one; they are log
    // taxonomy, not catalog keys, and their messages are already specific.
    const error = new GitHubError('GitHub says you have no push access to echo-lab/assets', {
      code: 'GITHUB_WRITE_FORBIDDEN',
    });

    expect(describeError(ko, error)).toBe('GitHub says you have no push access to echo-lab/assets');
  });

  it('passes a plain Error through untranslated', () => {
    expect(describeError(ko, new Error('socket hang up'))).toBe('socket hang up');
  });

  it('falls back to the unknown-error string for anything that is not an Error', () => {
    expect(describeError(en, 'just a string')).toBe('Unknown error');
    expect(describeError(ko, undefined)).toBe('알 수 없는 오류가 생겼어요. 잠시 후 다시 시도해 주세요.');
    expect(describeError(ko, { status: 500 })).toBe('알 수 없는 오류가 생겼어요. 잠시 후 다시 시도해 주세요.');
    // An Error that says nothing is as unknown as a thrown string.
    expect(describeError(en, new Error('   '))).toBe('Unknown error');
  });
});

describe('getRepositoryAccessError', () => {
  const writable = { push: true, admin: false, maintain: false, triage: false, pull: true };

  it('returns null for a public repository the user can write to', () => {
    expect(getRepositoryAccessError({ private: false, permissions: writable })).toBeNull();
  });

  it('carries a code, not just a sentence, for a private repository', () => {
    const error = getRepositoryAccessError({ private: true, permissions: writable });

    expect(error?.code).toBe('github.privateRepoUnsupported');
    expect(error?.message).toBe('Private repositories are not supported. Please choose a public repository.');
    expect(describeError(ko, error)).toBe('비공개 저장소는 지원하지 않아요. 공개 저장소를 골라 주세요.');
  });

  it('carries a code for a repository the user cannot push to', () => {
    const error = getRepositoryAccessError({
      private: false,
      permissions: { push: false, admin: false, maintain: false, triage: false, pull: true },
    });

    expect(error?.code).toBe('github.writeAccessRequired');
    expect(error?.message).toBe('You need write access to connect this repository.');
    expect(describeError(ko, error)).toBe(
      '이 저장소를 연결하려면 쓰기 권한이 필요해요. 권한을 받은 뒤 다시 시도해 주세요.',
    );
  });
});
