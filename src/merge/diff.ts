/**
 * Myers Diff Engine
 * ─────────────────
 * Implements Eugene Myers' O(ND) Shortest Edit Script algorithm, which is the
 * same algorithm used by git diff internally. It operates directly on line
 * arrays with no character-encoding tricks, so it is completely robust
 * regardless of file size, number of unique lines, or where edits occur.
 *
 * Why we replaced diff-match-patch:
 *   DMP's line-level mode maps each unique line to a Unicode character code
 *   starting at 0. This breaks badly when files have many unique lines (null
 *   bytes, surrogate pairs, etc.) causing the entire file to appear as one
 *   giant replacement hunk — exactly the bug the user reported.
 */

export interface DiffHunk {
  originalStartLine: number;  // 1-indexed
  originalLineCount: number;
  modifiedStartLine: number;  // 1-indexed
  modifiedLineCount: number;
  hunkDiff: string;
  rawOriginal: string;
  rawModified: string;
}

// ── Myers Algorithm Internals ───────────────────────────────────────────────

type Edit =
  | { kind: 'equal';  origIdx: number; modIdx: number }
  | { kind: 'delete'; origIdx: number }
  | { kind: 'insert';                  modIdx: number };

/**
 * Runs Myers O(ND) diff on two string arrays.
 * Returns the minimal edit script as a flat list of Edit operations.
 */
function myersDiff(a: string[], b: string[]): Edit[] {
  const n = a.length;
  const m = b.length;

  if (n === 0 && m === 0) return [];
  if (n === 0) return b.map((_, i) => ({ kind: 'insert', modIdx: i }));
  if (m === 0) return a.map((_, i) => ({ kind: 'delete', origIdx: i }));

  const max = n + m;
  // V[k] = furthest x coordinate reached on diagonal k
  // We store snapshots of V at each "d" level so we can backtrack.
  const vs: Int32Array[] = [];
  const V = new Int32Array(2 * max + 1);

  // Offset so we can index with negative k
  const offset = max;
  V[offset + 1] = 0;

  let found = false;
  let foundD = 0;

  outer:
  for (let d = 0; d <= max; d++) {
    vs.push(V.slice());  // save snapshot

    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && V[offset + k - 1] < V[offset + k + 1])) {
        x = V[offset + k + 1];          // move down (insert)
      } else {
        x = V[offset + k - 1] + 1;      // move right (delete)
      }
      let y = x - k;

      // Extend the snake (equal lines)
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }

      V[offset + k] = x;

      if (x >= n && y >= m) {
        vs.push(V.slice());
        foundD = d;
        found = true;
        break outer;
      }
    }
  }

  if (!found) {
    // Should never happen, but fallback: treat as full replacement
    const edits: Edit[] = [];
    a.forEach((_, i) => edits.push({ kind: 'delete', origIdx: i }));
    b.forEach((_, i) => edits.push({ kind: 'insert', modIdx: i }));
    return edits;
  }

  // ── Backtrack to recover the edit script ──────────────────────────────────
  const edits: Edit[] = [];
  let x = n;
  let y = m;

  for (let d = foundD; d > 0; d--) {
    const Vprev = vs[d];
    const k = x - y;
    let prevK: number;

    if (k === -d || (k !== d && Vprev[offset + k - 1] < Vprev[offset + k + 1])) {
      prevK = k + 1;  // came from a down move (insert)
    } else {
      prevK = k - 1;  // came from a right move (delete)
    }

    const prevX = Vprev[offset + prevK];
    const prevY = prevX - prevK;

    // Walk the snake backwards (equal lines)
    while (x > prevX + (x - prevX - (y - prevY)) && y > prevY + (y - prevY - (x - prevX))) {
      x--;
      y--;
      edits.unshift({ kind: 'equal', origIdx: x, modIdx: y });
    }

    if (d > 0) {
      if (prevK === k + 1) {
        // Insert: y decreased
        y--;
        edits.unshift({ kind: 'insert', modIdx: y });
      } else {
        // Delete: x decreased
        x--;
        edits.unshift({ kind: 'delete', origIdx: x });
      }
    }

    x = prevX;
    y = prevY;
  }

  // Handle the snake at d=0 (equal lines at start)
  while (x > 0 && y > 0 && a[x - 1] === b[y - 1]) {
    x--;
    y--;
    edits.unshift({ kind: 'equal', origIdx: x, modIdx: y });
  }

  return edits;
}

// ── Hunk grouping ────────────────────────────────────────────────────────────

/**
 * Groups a flat edit list into contiguous change hunks, exactly like
 * `git diff --unified=0` would produce. Each group of consecutive
 * deletes/inserts becomes one DiffHunk.
 */
function groupIntoHunks(edits: Edit[], a: string[], b: string[]): DiffHunk[] {
  const hunks: DiffHunk[] = [];

  let i = 0;
  while (i < edits.length) {
    // Skip equal edits
    if (edits[i].kind === 'equal') {
      i++;
      continue;
    }

    // Start of a change region
    const regionStart = i;
    let origStart = -1;
    let modStart  = -1;
    const deleted: string[] = [];
    const inserted: string[] = [];

    // Collect consecutive non-equal edits (delete/insert blocks can interleave)
    while (i < edits.length && edits[i].kind !== 'equal') {
      const e = edits[i];
      if (e.kind === 'delete') {
        if (origStart === -1) origStart = e.origIdx;
        if (modStart  === -1) modStart  = e.origIdx; // approximate until we see an insert
        deleted.push(a[e.origIdx]);
      } else if (e.kind === 'insert') {
        if (modStart === -1) modStart = e.modIdx;
        inserted.push(b[e.modIdx]);
      }
      i++;
    }

    // Resolve modStart: if we only saw deletes and no inserts, modStart is the
    // position *after* the last original line that stays.
    // Find the first equal edit AFTER this region to determine modStart precisely.
    if (deleted.length > 0 && inserted.length === 0) {
      // Pure deletion — modStart is the same line as origStart in the modified file
      // (lines before this point in b)
      let modsBeforeHere = 0;
      for (let j = 0; j < regionStart; j++) {
        if (edits[j].kind === 'equal' || edits[j].kind === 'insert') modsBeforeHere++;
      }
      modStart = modsBeforeHere;
    } else if (inserted.length > 0 && deleted.length === 0) {
      // Pure insertion
      modStart = (edits[regionStart] as any).modIdx;
    }

    // Build the hunkDiff string in unified-diff style: all deletes then all inserts.
    // This is what the review webview uses to render red/green lines.
    const diffLines: string[] = [];
    deleted.forEach(l => diffLines.push(`-${l}`));
    inserted.forEach(l => diffLines.push(`+${l}`));

    // origStart / modStart are 0-indexed from the edit indices;
    // Patch stores 1-indexed line numbers.
    const origStartLine = origStart >= 0 ? origStart + 1 : modStart + 1;
    const modStartLine  = modStart  >= 0 ? modStart  + 1 : origStart + 1;

    hunks.push({
      originalStartLine: origStartLine,
      originalLineCount: deleted.length,
      modifiedStartLine: modStartLine,
      modifiedLineCount: inserted.length,
      hunkDiff:    diffLines.join('\n'),
      rawOriginal: deleted.join('\n'),
      rawModified: inserted.join('\n'),
    });
  }

  return hunks;
}

// ── Public API ───────────────────────────────────────────────────────────────

export class DiffEngine {
  /**
   * Generates hunks from original and modified content using the Myers
   * O(ND) diff algorithm (same as git diff).
   *
   * Guarantees:
   *  - Works correctly when changes are only at the top or bottom of the file.
   *  - Works correctly for large files with many unique lines.
   *  - Each unchanged region between two change blocks becomes a hunk boundary.
   *  - No character-encoding tricks; comparisons are always exact string equality.
   */
  public generateHunks(original: string, modified: string): DiffHunk[] {
    if (original === modified) return [];

    const origLines = original.split(/\r?\n/);
    const modLines  = modified.split(/\r?\n/);

    // Handle trailing newline: if a file ends with \n, split produces an empty
    // last element. We strip it so it does not appear as a spurious empty-line change.
    if (origLines.length > 0 && origLines[origLines.length - 1] === '') origLines.pop();
    if (modLines.length  > 0 && modLines[modLines.length  - 1] === '') modLines.pop();

    if (origLines.length === 0 && modLines.length === 0) return [];

    const edits = myersDiff(origLines, modLines);
    return groupIntoHunks(edits, origLines, modLines);
  }
}
