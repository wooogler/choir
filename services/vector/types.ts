import type { UpdateAnchor } from 'services/document/update-anchor';

export interface DocumentMetadata {
  fileName: string;
  nodeId: string;
  sectionId?: string;
  sectionName?: string;
  nodeType: string;
  githubUrl: string;
  headingPath?: string;
  originalContent: string;
  updateAnchor?: UpdateAnchor;
}
