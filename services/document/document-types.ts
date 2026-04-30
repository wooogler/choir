import type { Root } from 'mdast';
import type { Node } from 'unist';

export interface ExtendedNode extends Node {
  id?: string;
  parentId?: string;
  sectionId?: string;
  sectionLevel?: number;
  isListItem?: boolean;
  listItemIndex?: number;
  fileName?: string;
}

export interface DocumentTree {
  title: string;
  root: Root & ExtendedNode;
  nodeMap: Map<string, ExtendedNode>;
  sectionMap: Map<string, ExtendedNode>;
}
