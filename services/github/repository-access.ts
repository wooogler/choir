import { CHOIRUserError } from 'services/common/choir-error';
import type { GitHubRepository } from './oauth-device-flow';

export function normalizeRepositoryPath(value: string | undefined | null): string {
  return (value || '').trim().replace(/^\/+|\/+$/g, '');
}

export function canWriteRepository(repo: Pick<GitHubRepository, 'permissions'>): boolean {
  return !!repo.permissions && (repo.permissions.push || repo.permissions.admin || repo.permissions.maintain);
}

/**
 * Why this repository cannot be connected, or `null` if it can.
 *
 * Returned rather than thrown — the caller shows it in the picker, it is not
 * an exception — but returned as an error object all the same, so it carries a
 * `code` the Slack side can translate. Reading `.message` still gives the
 * English sentence this function has always produced.
 */
export function getRepositoryAccessError(
  repo: Pick<GitHubRepository, 'private' | 'permissions'>,
): CHOIRUserError | null {
  if (repo.private) {
    return new CHOIRUserError(
      'github.privateRepoUnsupported',
      'Private repositories are not supported. Please choose a public repository.',
    );
  }

  if (!canWriteRepository(repo)) {
    return new CHOIRUserError('github.writeAccessRequired', 'You need write access to connect this repository.');
  }

  return null;
}
