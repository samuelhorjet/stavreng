import diff_match_patch_pkg from 'diff-match-patch';

export interface DiffHunk {
  originalStartLine: number;
  originalLineCount: number;
  modifiedStartLine: number;
  modifiedLineCount: number;
  hunkDiff: string;
  rawOriginal: string;
  rawModified: string;
}

export class DiffEngine {
  private dmp: any;

  constructor() {
    this.dmp = new diff_match_patch_pkg.diff_match_patch();
  }

  /**
   * Generates hunks from original and modified content.
   */
  public generateHunks(original: string, modified: string): DiffHunk[] {
    const originalLines = original.split(/\r?\n/);
    const modifiedLines = modified.split(/\r?\n/);

    // We can perform a line-level diff by mapping each unique line to a character,
    // running the character-level diff-match-patch, and mapping back.
    const { chars1, chars2, lineArray } = this.linesToChars(originalLines, modifiedLines);
    const diffs = this.dmp.diff_main(chars1, chars2);

    const hunks: DiffHunk[] = [];
    let origLineIdx = 0;
    let modLineIdx = 0;

    // We iterate through the diffs and group inserts and deletes into hunks.
    let pendingDelete: string[] = [];
    let pendingInsert: string[] = [];
    let hunkOrigStart = 0;
    let hunkModStart = 0;

    const flushHunk = () => {
      if (pendingDelete.length > 0 || pendingInsert.length > 0) {
        const rawOriginal = pendingDelete.join('\n');
        const rawModified = pendingInsert.join('\n');
        
        // Generate a unified-like diff format
        const diffLines: string[] = [];
        pendingDelete.forEach(l => diffLines.push(`-${l}`));
        pendingInsert.forEach(l => diffLines.push(`+${l}`));
        const hunkDiff = diffLines.join('\n');

        hunks.push({
          originalStartLine: hunkOrigStart + 1,
          originalLineCount: pendingDelete.length,
          modifiedStartLine: hunkModStart + 1,
          modifiedLineCount: pendingInsert.length,
          hunkDiff,
          rawOriginal,
          rawModified
        });

        pendingDelete = [];
        pendingInsert = [];
      }
    };

    diffs.forEach((diff: [number, string]) => {
      const [operation, text] = diff;
      // text is composed of mapped characters
      const lines = text.split('').map(char => lineArray[char.charCodeAt(0)]);

      if (operation === 0) { // Equal
        flushHunk();
        origLineIdx += lines.length;
        modLineIdx += lines.length;
      } else if (operation === -1) { // Delete
        if (pendingDelete.length === 0 && pendingInsert.length === 0) {
          hunkOrigStart = origLineIdx;
          hunkModStart = modLineIdx;
        }
        pendingDelete.push(...lines);
        origLineIdx += lines.length;
      } else if (operation === 1) { // Insert
        if (pendingDelete.length === 0 && pendingInsert.length === 0) {
          hunkOrigStart = origLineIdx;
          hunkModStart = modLineIdx;
        }
        pendingInsert.push(...lines);
        modLineIdx += lines.length;
      }
    });

    flushHunk();
    return hunks;
  }

  /**
   * Helper to map lines to Unicode characters.
   */
  private linesToChars(lines1: string[], lines2: string[]) {
    const lineMap: { [key: string]: number } = {};
    const lineArray: string[] = [];

    const mapLines = (lines: string[]): string => {
      let chars = '';
      lines.forEach(line => {
        if (lineMap[line] !== undefined) {
          chars += String.fromCharCode(lineMap[line]);
        } else {
          const code = lineArray.length;
          lineMap[line] = code;
          lineArray.push(line);
          chars += String.fromCharCode(code);
        }
      });
      return chars;
    };

    const chars1 = mapLines(lines1);
    const chars2 = mapLines(lines2);

    return { chars1, chars2, lineArray };
  }
}
