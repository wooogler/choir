import path from 'node:path';

export function getDataPath(...segments: string[]): string {
  const dataRoot = process.env.CHOIR_DATA_DIR || 'data';
  return path.resolve(process.cwd(), dataRoot, ...segments);
}
