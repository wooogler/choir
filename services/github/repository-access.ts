import type { GitHubRepository } from './oauth-device-flow';

export function normalizeRepositoryPath(value: string | undefined | null): string {
  return (value || '').trim().replace(/^\/+|\/+$/g, '');
}

export function canWriteRepository(repo: Pick<GitHubRepository, 'permissions'>): boolean {
  return !!repo.permissions && (repo.permissions.push || repo.permissions.admin || repo.permissions.maintain);
}

export function getRepositoryAccessError(repo: Pick<GitHubRepository, 'private' | 'permissions'>): string | null {
  if (repo.private) {
    return 'Private repositories are not supported. Please choose a public repository.';
  }

  if (!canWriteRepository(repo)) {
    return 'You need write access to connect this repository.';
  }

  return null;
}
