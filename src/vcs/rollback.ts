/**
 * HunkRollbackExecutor — accept / reject individual AI patch hunks.
 *
 * Moved from src/merge/rollback.ts and stripped of all lineOwnership logic.
 * VS Code's approach (chatEditingTextModelChangeService._keepHunk / _undoHunk):
 *   - Accept = advance baseline to include the AI change
 *   - Reject = revert the AI change in the modified model (our: disk file)
 *
 * The StringEditTracker handles the human/AI attribution — rollback.ts only
 * cares about the mechanical accept/reject splice.
 */

import * as fs from 'fs';
import * as path from 'path';
import { PatchesRepository } from '../db/patches.js';
import { FileStatesRepository } from '../db/fileStates.js';
import { JournalManager } from '../engine/journal.js';

export class HunkRollbackExecutor {
  constructor(
    private patchesRepo: PatchesRepository,
    private journalManager: JournalManager,
    private fileStatesRepo?: FileStatesRepository,
    /**
     * Called with the file path BEFORE every disk write.
     * Pass `stringEditTracker.suppressNextChangeFor` here so both the
     * onDidChangeTextDocument event AND the FSW event are swallowed.
     */
    private onBeforeWrite?: (filePath: string) => void
  ) {}

  // ─── Reject (Rollback) ───────────────────────────────────────────────────

  /**
   * Reverts a single hunk patch from a file surgically:
   * - Only removes the AI-written lines for THIS hunk
   * - Leaves all other accepted/human edits untouched
   * - No human-overlap blocking — StringEditTracker handles attribution
   */
  public async rollbackHunk(patchId: string): Promise<{ success: boolean; error?: string }> {
    const patch = this.patchesRepo.getById(patchId);
    if (!patch) {
      return { success: false, error: 'Patch not found' };
    }

    // Handle deleted files
    if (!fs.existsSync(patch.filePath)) {
      try {
        const dir = path.dirname(patch.filePath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        this.onBeforeWrite?.(patch.filePath);
        fs.writeFileSync(patch.filePath, patch.rawOriginal, 'utf8');
        this.patchesRepo.updateStatus(patchId, 'REJECTED');
        return { success: true };
      } catch (err: any) {
        return { success: false, error: `Failed to recreate deleted file: ${err.message}` };
      }
    }

    try {
      const currentContent = fs.readFileSync(patch.filePath, 'utf8');
      const currentLines = currentContent.split(/\r?\n/);

      // Surgical splice: replace AI-modified lines with original lines
      const replaceStart = patch.modifiedStartLine - 1; // 0-indexed
      const replaceEnd = replaceStart + patch.modifiedLineCount;
      const originalLines = patch.rawOriginal === '' ? [] : patch.rawOriginal.split(/\r?\n/);

      const newLines = [
        ...currentLines.slice(0, replaceStart),
        ...originalLines,
        ...currentLines.slice(replaceEnd),
      ];

      const newContent = newLines.join('\n');

      // Suppress FSW + onDidChangeTextDocument events for this write
      this.onBeforeWrite?.(patch.filePath);
      fs.writeFileSync(patch.filePath, newContent, 'utf8');

      this.patchesRepo.updateStatus(patchId, 'REJECTED');
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message ?? 'Unknown rollback error' };
    }
  }

  // ─── Accept ──────────────────────────────────────────────────────────────

  /**
   * Accepts a patch: marks it ACCEPTED and advances the session baseline.
   *
   * New baseline = current content with every STILL-PENDING patch reverted.
   * This ensures future watcher diffs still surface the remaining pending hunks.
   */
  public async acceptPatch(patchId: string): Promise<void> {
    const patch = this.patchesRepo.getById(patchId);
    if (!patch) return;

    // Mark accepted
    this.patchesRepo.updateStatus(patchId, 'ACCEPTED');

    if (!this.fileStatesRepo || !fs.existsSync(patch.filePath)) return;

    const fileState = this.fileStatesRepo.getByFileAndSession(patch.filePath, patch.sessionId);
    if (!fileState) return;

    const currentContent = fs.readFileSync(patch.filePath, 'utf8');

    // Compute new baseline: current content with still-pending patches reverted
    const stillPending = this.patchesRepo
      .getByFileAndSession(patch.filePath, patch.sessionId)
      .filter(p => p.status === 'PENDING');

    // Process bottom-to-top so line shifts don't affect earlier hunks
    stillPending.sort((a, b) => b.modifiedStartLine - a.modifiedStartLine);

    let baseLines = currentContent.split('\n');
    for (const pendingPatch of stillPending) {
      const start = pendingPatch.modifiedStartLine - 1;
      const end = start + pendingPatch.modifiedLineCount;
      const origLines = pendingPatch.rawOriginal === ''
        ? []
        : pendingPatch.rawOriginal.split('\n');

      baseLines = [
        ...baseLines.slice(0, start),
        ...origLines,
        ...baseLines.slice(end),
      ];
    }

    const newBaseContent = baseLines.join('\n');
    const newBaseSha256 = this.journalManager.createBackup(patch.filePath, newBaseContent);

    fileState.baseSha256 = newBaseSha256;
    fileState.currentSha256 = this.journalManager.calculateHash(currentContent);
    fileState.lastModified = Date.now();
    this.fileStatesRepo.upsert(fileState);
  }
}
