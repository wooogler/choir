import fs from 'node:fs';
import path from 'node:path';
import { WorkspaceMirrorService } from './mirror-service';

/**
 * Replicates @tobilu/qmd's internal `handelize()` function.
 * Used to build the reverse mapping: handelized path → original path.
 */
function handelize(p: string): string {
  return p
    .replace(/___/g, '/')
    .toLowerCase()
    .split('/')
    .map((segment, idx, arr) => {
      const isLast = idx === arr.length - 1;
      if (isLast) {
        const extMatch = segment.match(/(\.[a-z0-9]+)$/i);
        const ext = extMatch ? extMatch[1] : '';
        const name = ext ? segment.slice(0, -ext.length) : segment;
        const cleanedName = name.replace(/[^\p{L}\p{N}$]+/gu, '-').replace(/^-+|-+$/g, '');
        return cleanedName + ext;
      }
      return segment.replace(/[^\p{L}\p{N}$]+/gu, '-').replace(/^-+|-+$/g, '');
    })
    .filter(Boolean)
    .join('/');
}

export class PathMapService {
  private static instance: PathMapService;
  private readonly cache = new Map<string, Record<string, string>>();

  public static getInstance(): PathMapService {
    if (!PathMapService.instance) {
      PathMapService.instance = new PathMapService();
    }
    return PathMapService.instance;
  }

  private getMapPath(workspaceId: string): string {
    return path.join(
      WorkspaceMirrorService.getInstance().getWorkspaceRoot(workspaceId),
      'state',
      'path-map.json',
    );
  }

  public async save(workspaceId: string, originalPaths: string[]): Promise<void> {
    const map: Record<string, string> = {};
    for (const original of originalPaths) {
      try {
        map[handelize(original)] = original;
      } catch {
        // skip paths that can't be handelized
      }
    }
    await fs.promises.writeFile(this.getMapPath(workspaceId), JSON.stringify(map, null, 2), 'utf-8');
    this.cache.set(workspaceId, map);
  }

  public async upsert(workspaceId: string, originalPath: string): Promise<void> {
    const map = this.loadSync(workspaceId);
    try {
      map[handelize(originalPath)] = originalPath;
    } catch {
      return;
    }
    await fs.promises.writeFile(this.getMapPath(workspaceId), JSON.stringify(map, null, 2), 'utf-8');
    this.cache.set(workspaceId, map);
  }

  private loadSync(workspaceId: string): Record<string, string> {
    const cached = this.cache.get(workspaceId);
    if (cached) return { ...cached };

    const mapPath = this.getMapPath(workspaceId);
    if (fs.existsSync(mapPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(mapPath, 'utf-8')) as Record<string, string>;
        this.cache.set(workspaceId, data);
        return { ...data };
      } catch {
        return {};
      }
    }
    return {};
  }

  public getOriginalPath(workspaceId: string, handelizedPath: string): string {
    const map = this.loadSync(workspaceId);
    return map[handelizedPath] ?? handelizedPath;
  }

  public invalidate(workspaceId: string): void {
    this.cache.delete(workspaceId);
  }
}
