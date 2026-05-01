import type { DocumentMetadata } from 'services/file-registry/types';

/**
 * 헤딩 텍스트를 GitHub 앵커 링크로 변환하는 함수
 * GitHub는 헤딩을 소문자로 변환하고 공백을 하이픈으로 바꾸며 특수문자를 제거합니다
 */
function createGitHubAnchor(headingText: string): string {
  return headingText
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '') // 특수문자 제거
    .replace(/\s+/g, '-') // 공백을 하이픈으로
    .replace(/-+/g, '-') // 연속된 하이픈을 하나로
    .replace(/^-|-$/g, ''); // 시작과 끝의 하이픈 제거
}

/**
 * DocumentMetadata에서 섹션 계층 정보를 포맷팅하는 함수 (텍스트만)
 */
export function formatSectionPath(metadata: DocumentMetadata): string {
  if (metadata.headingPath && metadata.headingPath.length > 0) {
    return metadata.headingPath;
  }
  return metadata.sectionName || 'Main Content';
}

/**
 * DocumentMetadata에서 섹션 계층 정보를 GitHub 링크가 포함된 마크다운으로 포맷팅하는 함수
 */
export function formatSectionPathWithLinks(metadata: DocumentMetadata): string {
  if (!metadata.headingPath || metadata.headingPath.length === 0) {
    return metadata.sectionName || 'Main Content';
  }

  const githubUrl = metadata.githubUrl;
  if (!githubUrl) {
    // GitHub URL이 없으면 일반 텍스트로 반환
    return metadata.headingPath;
  }

  // headingPath가 문자열이므로 ' > '로 분할해서 각 헤딩을 GitHub 링크로 변환
  const headings = metadata.headingPath.split(' > ');
  const linkedHeadings = headings.map((heading) => {
    const anchor = createGitHubAnchor(heading);
    return `<${githubUrl}#${anchor}|${heading}>`;
  });

  return linkedHeadings.join(' > ');
}

/**
 * DocumentMetadata에서 전체 경로 정보를 포맷팅하는 함수
 */
export function formatFullPath(metadata: DocumentMetadata): string {
  const fileName = metadata.fileName || 'Unknown File';
  const sectionPath = formatSectionPath(metadata);
  return `${fileName} > ${sectionPath}`;
}

/**
 * DocumentMetadata에서 전체 경로 정보를 GitHub 링크가 포함된 마크다운으로 포맷팅하는 함수
 */
export function formatFullPathWithLinks(metadata: DocumentMetadata): string {
  const fileName = metadata.fileName || 'Unknown File';
  const githubUrl = metadata.githubUrl;

  if (githubUrl) {
    const fileLink = `<${githubUrl}|${fileName}>`;
    const sectionPath = formatSectionPathWithLinks(metadata);
    return `${fileLink} > ${sectionPath}`;
  }

  const sectionPath = formatSectionPath(metadata);
  return `${fileName} > ${sectionPath}`;
}
