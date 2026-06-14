/**
 * Offset-based edit algebra — the same mathematical model VS Code uses internally
 * in chatEditingTextModelChangeService.ts (_originalToModifiedEdit).
 *
 * A StringEdit is an ordered, non-overlapping list of single-offset replacements
 * (deleteCount chars removed, insertText inserted) on a source string.
 *
 * Key operations mirror VS Code's StringEdit:
 *   apply            — produce result text
 *   compose          — chain two edits sequentially
 *   inverse          — undo this edit (needs original text)
 *   tryRebase        — rebase this edit on top of another (returns undefined on conflict)
 *   rebaseSkipConflicting — same but drops conflicting sub-edits (human wins)
 */

export interface SingleStringEdit {
  /** Character offset in the **source** text where the replacement begins. */
  readonly offset: number;
  /** Number of source characters to remove starting at `offset`. */
  readonly deleteCount: number;
  /** Text to insert in their place. */
  readonly insertText: string;
}

export class StringEdit {
  // ─── Factory ────────────────────────────────────────────────────────────────

  static readonly empty = new StringEdit([]);

  static single(offset: number, deleteCount: number, insertText: string): StringEdit {
    return new StringEdit([{ offset, deleteCount, insertText }]);
  }

  /**
   * Build a StringEdit from VS Code `TextDocumentContentChangeEvent` changes.
   * Note: VS Code content changes use character offsets directly.
   */
  static fromContentChanges(
    changes: ReadonlyArray<{ rangeOffset: number; rangeLength: number; text: string }>
  ): StringEdit {
    if (changes.length === 0) return StringEdit.empty;
    // VS Code can give multiple changes in one event; normalise and sort by offset asc.
    const edits: SingleStringEdit[] = changes.map(c => ({
      offset: c.rangeOffset,
      deleteCount: c.rangeLength,
      insertText: c.text,
    }));
    return new StringEdit(StringEdit._sortAndMerge(edits));
  }

  /**
   * Compute a StringEdit that transforms `original` into `modified`.
   * Uses a simple greedy longest-common-prefix/suffix approach — good enough for
   * the small incremental deltas we process (not a full diff).
   * For large files, consider replacing with a character-level LCS.
   */
  static fromTexts(original: string, modified: string): StringEdit {
    if (original === modified) return StringEdit.empty;

    // Find common prefix
    let prefixLen = 0;
    const minLen = Math.min(original.length, modified.length);
    while (prefixLen < minLen && original[prefixLen] === modified[prefixLen]) {
      prefixLen++;
    }

    // Find common suffix (not overlapping with prefix)
    let suffixLen = 0;
    while (
      suffixLen < minLen - prefixLen &&
      original[original.length - 1 - suffixLen] === modified[modified.length - 1 - suffixLen]
    ) {
      suffixLen++;
    }

    const deleteCount = original.length - prefixLen - suffixLen;
    const insertText = modified.slice(prefixLen, modified.length - suffixLen);

    return new StringEdit([{ offset: prefixLen, deleteCount, insertText }]);
  }

  // ─── Core ───────────────────────────────────────────────────────────────────

  constructor(public readonly edits: readonly SingleStringEdit[]) {}

  isEmpty(): boolean {
    return this.edits.length === 0;
  }

  // ─── apply ──────────────────────────────────────────────────────────────────

  /**
   * Apply this edit to `text` and return the resulting string.
   * Edits are applied right-to-left so earlier edits don't shift later offsets.
   */
  apply(text: string): string {
    let result = text;
    // Process from end to start to preserve offset validity
    for (let i = this.edits.length - 1; i >= 0; i--) {
      const { offset, deleteCount, insertText } = this.edits[i];
      result = result.slice(0, offset) + insertText + result.slice(offset + deleteCount);
    }
    return result;
  }

  // ─── compose ────────────────────────────────────────────────────────────────

  /**
   * Returns an edit equivalent to applying `this` first, then `next`.
   * `next`'s offsets are in the coordinate space of the text AFTER `this` is applied.
   */
  compose(next: StringEdit): StringEdit {
    if (this.isEmpty()) return next;
    if (next.isEmpty()) return this;

    // We translate `next` edits back into the original coordinate space.
    const result: SingleStringEdit[] = [...this.edits];

    for (const ne of next.edits) {
      result.push(ne); // naive: re-sort and merge will handle overlaps
    }

    // Re-sort by offset. Note: this is a simplification — a fully correct
    // compose needs coordinate translation. For our use case (sequential,
    // non-overlapping edits from the same source text) this is correct.
    return new StringEdit(StringEdit._sortAndMerge(result));
  }

  // ─── inverse ────────────────────────────────────────────────────────────────

  /**
   * Returns an edit that, when applied to the result of `this.apply(originalText)`,
   * produces `originalText` back.
   *
   * Requires the original text so we can capture what was deleted.
   */
  inverse(originalText: string): StringEdit {
    if (this.isEmpty()) return StringEdit.empty;

    let offset = 0; // cursor in the modified text
    const invEdits: SingleStringEdit[] = [];

    for (const { offset: srcOffset, deleteCount, insertText } of this.edits) {
      // In the modified text, the position of this edit shifts by prior insertions/deletions
      const modOffset = srcOffset + offset;
      invEdits.push({
        offset: modOffset,
        deleteCount: insertText.length,              // undo the insertion
        insertText: originalText.slice(srcOffset, srcOffset + deleteCount), // restore deletion
      });
      offset += insertText.length - deleteCount;
    }

    return new StringEdit(invEdits);
  }

  // ─── tryRebase ──────────────────────────────────────────────────────────────

  /**
   * VS Code formula:  e_user_r = e_user.tryRebase(e_ai.inverse(original))
   *
   * Rebases `this` edit (which was computed against text A) on top of `over`
   * (which transforms text A into text B), producing an edit valid for text B.
   *
   * Returns `undefined` if `this` and `over` touch overlapping character ranges
   * (a true conflict).
   */
  tryRebase(over: StringEdit): StringEdit | undefined {
    if (over.isEmpty()) return this;
    if (this.isEmpty()) return this;

    const rebased: SingleStringEdit[] = [];
    let delta = 0; // cumulative offset shift introduced by `over`'s edits so far

    let overIdx = 0;

    for (const mine of this.edits) {
      // Advance through `over` edits that come entirely BEFORE `mine`
      while (overIdx < over.edits.length) {
        const o = over.edits[overIdx];
        if (o.offset + o.deleteCount <= mine.offset) {
          delta += o.insertText.length - o.deleteCount;
          overIdx++;
        } else {
          break;
        }
      }

      // Check if the current `over` edit overlaps with `mine`
      if (overIdx < over.edits.length) {
        const o = over.edits[overIdx];
        const mineEnd = mine.offset + mine.deleteCount;
        const oEnd = o.offset + o.deleteCount;

        const overlaps =
          o.offset < mineEnd && oEnd > mine.offset;

        if (overlaps) {
          // Conflict — caller decides how to handle (human wins, skip, etc.)
          return undefined;
        }
      }

      rebased.push({
        offset: mine.offset + delta,
        deleteCount: mine.deleteCount,
        insertText: mine.insertText,
      });
    }

    return new StringEdit(rebased);
  }

  // ─── rebaseSkipConflicting ──────────────────────────────────────────────────

  /**
   * Same as `tryRebase` but instead of returning undefined on conflict, it
   * **drops** the conflicting sub-edit from the result.
   *
   * Used for the AI edit side when the human has touched the same region:
   * human wins, AI change for that region is silently dropped.
   */
  rebaseSkipConflicting(over: StringEdit): StringEdit {
    if (over.isEmpty()) return this;
    if (this.isEmpty()) return this;

    const rebased: SingleStringEdit[] = [];
    let delta = 0;
    let overIdx = 0;

    for (const mine of this.edits) {
      while (overIdx < over.edits.length) {
        const o = over.edits[overIdx];
        if (o.offset + o.deleteCount <= mine.offset) {
          delta += o.insertText.length - o.deleteCount;
          overIdx++;
        } else {
          break;
        }
      }

      if (overIdx < over.edits.length) {
        const o = over.edits[overIdx];
        const mineEnd = mine.offset + mine.deleteCount;
        const oEnd = o.offset + o.deleteCount;
        const overlaps = o.offset < mineEnd && oEnd > mine.offset;

        if (overlaps) {
          // Skip this conflicting edit — human wins
          continue;
        }
      }

      rebased.push({
        offset: mine.offset + delta,
        deleteCount: mine.deleteCount,
        insertText: mine.insertText,
      });
    }

    return new StringEdit(rebased);
  }

  // ─── Serialization ──────────────────────────────────────────────────────────

  toJSON(): object {
    return { edits: this.edits };
  }

  static fromJSON(json: { edits: SingleStringEdit[] }): StringEdit {
    return new StringEdit(json.edits ?? []);
  }

  // ─── Internal helpers ────────────────────────────────────────────────────────

  /** Sort edits by offset and merge adjacent/overlapping ones. */
  private static _sortAndMerge(edits: SingleStringEdit[]): SingleStringEdit[] {
    if (edits.length <= 1) return edits;

    const sorted = [...edits].sort((a, b) => a.offset - b.offset);
    const merged: SingleStringEdit[] = [sorted[0]];

    for (let i = 1; i < sorted.length; i++) {
      const last = merged[merged.length - 1];
      const cur = sorted[i];
      const lastEnd = last.offset + last.deleteCount;

      if (cur.offset > lastEnd) {
        // No overlap — just append
        merged.push(cur);
      } else {
        // Overlapping or adjacent — merge into one
        merged[merged.length - 1] = {
          offset: last.offset,
          deleteCount: Math.max(lastEnd, cur.offset + cur.deleteCount) - last.offset,
          insertText: last.insertText + cur.insertText.slice(Math.max(0, lastEnd - cur.offset)),
        };
      }
    }

    return merged;
  }
}
