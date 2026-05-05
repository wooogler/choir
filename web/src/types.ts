export type DocFile = {
  path: string;
  name: string;
};

export type RepoInfo = {
  owner: string;
  name: string;
  branch?: string;
  url: string;
};

export type FolderNode = {
  name: string;
  path: string;
  folders: FolderNode[];
  files: DocFile[];
};

export type TocItem = {
  id: string;
  label: string;
  level: number;
  slug: string;
};
