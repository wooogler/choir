export type DiffLine = { type: 'add' | 'del'; text: string };

/**
 * Compact line diff (LCS) returning only the changed lines — no unchanged
 * context — so it stays readable inside the narrow history panel.
 */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split('\n');
  const b = after.split('\n');
  const m = a.length;
  const n = b.length;

  const dp = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ type: 'del', text: a[i] });
      i += 1;
    } else {
      out.push({ type: 'add', text: b[j] });
      j += 1;
    }
  }
  while (i < m) {
    out.push({ type: 'del', text: a[i] });
    i += 1;
  }
  while (j < n) {
    out.push({ type: 'add', text: b[j] });
    j += 1;
  }

  // Drop diffs that are only an empty-line artifact (e.g. new-file before = "").
  return out.filter((line) => line.text.trim() !== '' || out.length === 1);
}
