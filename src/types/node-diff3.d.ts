/**
 * node-diff3 ships its types behind an `exports` map, which this project's
 * `moduleResolution: node10` cannot follow (see tsconfig.json — the repo is not
 * on node16 resolution yet). Re-declaring the handful of entry points used here
 * is cheaper and less disruptive than migrating resolution for one dependency.
 *
 * Mirrors node_modules/node-diff3/src/diff3.d.ts; keep in step if it moves.
 */
declare module 'node-diff3' {
  export interface ILCSResult {
    buffer1index: number;
    buffer2index: number;
    chain: ILCSResult | null;
  }

  export function LCS<T>(buffer1: T[], buffer2: T[]): ILCSResult;

  export interface IDiffIndicesResult<T> {
    /** [start, length] range replaced in buffer1. */
    buffer1: [number, number];
    buffer1Content: T[];
    /** [start, length] range that replaces it in buffer2. */
    buffer2: [number, number];
    buffer2Content: T[];
  }

  export function diffIndices<T>(buffer1: T[], buffer2: T[]): IDiffIndicesResult<T>[];

  export interface IMergeRegionOk<T> {
    ok: T[];
    conflict?: never;
  }

  export interface IMergeRegionConflict<T> {
    ok?: never;
    conflict: {
      a: T[];
      aIndex: number;
      o: T[];
      oIndex: number;
      b: T[];
      bIndex: number;
    };
  }

  export type IMergeRegion<T> = IMergeRegionOk<T> | IMergeRegionConflict<T>;

  /** (mine, original, theirs) — regions in order, conflicts left for the caller. */
  export function diff3Merge<T>(
    a: T[],
    o: T[],
    b: T[],
    options?: { excludeFalseConflicts?: boolean; stringSeparator?: string | RegExp },
  ): IMergeRegion<T>[];
}
