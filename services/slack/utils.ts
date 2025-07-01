// Legacy utilities that don't fit into other modules
export function createGitbookSectionLink(sectionName: string, fileName?: string): string {
  if (!sectionName) return '';

  if (!fileName) {
    return `https://choir.gitbook.io/echolab-assets/#${sectionName.toLowerCase().replace(/\s+/g, '-')}`;
  }

  const formattedFileName = fileName.replace(/\.md$/, '').toLowerCase().replace(/\s+/g, '_');

  const formattedSectionName = sectionName.toLowerCase().replace(/\s+/g, '-').replace(/\./g, '.').replace(/-/g, '-');

  return `https://choir.gitbook.io/echolab-assets/${formattedFileName}#${formattedSectionName}`;
}
