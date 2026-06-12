import * as fs from 'fs';
import * as path from 'path';
import { PatchesRepository } from '../db/patches.js';
import { LineOwnershipRepository } from '../db/lineOwnership.js';
import { FileStatesRepository } from '../db/fileStates.js';
import { JournalManager } from '../engine/journal.js';

export class HunkRollbackExecutor {
  constructor(
    private patchesRepo: PatchesRepository,
    private lineOwnershipRepo: LineOwnershipRepository,
    private journalManager: JournalManager,
    private fileStatesRepo?: FileStatesRepository
  ) {}

  /**
   * Reverts a single hunk patch from a file surgically:
   * - Only removes the AI-written lines for THIS hunk
   * - Leaves all other accepted/human edits untouched
   * - Updates fileState baseline so future AI edits compare against the post-rollback state
   */
  public async rollbackHunk(patchId: string): Promise<{ success: boolean; conflict: boolean; error?: string }> {
    const patch = this.patchesRepo.getById(patchId);
    if (!patch) {
      return { success: false, conflict: false, error: 'Patch not found' };
    }

    if (!fs.existsSync(patch.filePath)) {
      // Recreate the deleted file using its original baseline content
      try {
        // Ensure parent directory exists
        const dir = path.dirname(patch.filePath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(patch.filePath, patch.rawOriginal, 'utf8');
        this.patchesRepo.updateStatus(patchId, 'REJECTED');
        console.log('[Stavreng] Recreated deleted file:', patch.filePath);
        return { success: true, conflict: false };
      } catch (err: any) {
        return { success: false, conflict: false, error: `Failed to recreate deleted file: ${err.message}` };
      }
    }

    const currentContent = fs.readFileSync(patch.filePath, 'utf8');

    // Check for human collisions on the lines modified by this patch
    const fileOwnership = this.lineOwnershipRepo.getFileOwnership(patch.filePath);
    const startLine = patch.modifiedStartLine;
    const endLine = patch.modifiedStartLine + patch.modifiedLineCount - 1;

    const hasHumanOverlap = fileOwnership.some(lo =>
      lo.owner === 'HUMAN' && lo.lineNumber >= startLine && lo.lineNumber <= endLine
    );

    if (hasHumanOverlap) {
      return { success: false, conflict: true, error: 'Human edits overlap with the AI hunk you are trying to reject.' };
    }

    // Surgical line-level replacement:
    // Replace the AI-modified lines with the original lines in the current content.
    // This is safer than DMP patch_apply which can mis-locate hunks when context has changed.
    try {
      const currentLines = currentContent.split(/\r?\n/);

      // modifiedStartLine is 1-indexed
      const replaceStart = patch.modifiedStartLine - 1;  // 0-indexed
      const replaceEnd = replaceStart + patch.modifiedLineCount; // exclusive

      // The lines to restore
      const originalLines = patch.rawOriginal === '' ? [] : patch.rawOriginal.split(/\r?\n/);

      // Splice: remove [replaceStart, replaceEnd) and insert originalLines
      const newLines = [
        ...currentLines.slice(0, replaceStart),
        ...originalLines,
        ...currentLines.slice(replaceEnd)
      ];

      const newContent = newLines.join('\n');

      // Save reverted content back to disk.
      // NOTE: Do NOT update fileState.baseSha256 here.
      // The baseline must ONLY advance when the user explicitly ACCEPTS a patch.
      // After this write, the FSW fires, re-diffs (base=unchanged, current=new disk content),
      // and recreates any remaining PENDING patches with correct, up-to-date line numbers.
      fs.writeFileSync(patch.filePath, newContent, 'utf8');

      // Update patch status
      this.patchesRepo.updateStatus(patchId, 'REJECTED');

      // Shift line ownership records to match the new line count
      const delta = patch.originalLineCount - patch.modifiedLineCount;
      if (delta !== 0) {
        this.lineOwnershipRepo.shiftOwnership(patch.filePath, patch.modifiedStartLine, delta);
      }

      // Remove AI ownership entries for only this reverted hunk
      const remainingOwnership = this.lineOwnershipRepo.getFileOwnership(patch.filePath)
        .filter(lo => !(lo.owner === 'AI' && lo.associatedPatchId === patchId));

      this.lineOwnershipRepo.clearOwnershipForFile(patch.filePath);
      this.lineOwnershipRepo.setOwnershipBulk(patch.filePath, remainingOwnership.map(lo => ({
        lineNumber: lo.lineNumber,
        owner: lo.owner,
        associatedPatchId: lo.associatedPatchId
      })));

      console.log('[Stavreng] Rollback complete for patch:', patchId, '— baseline unchanged, FSW will resurface remaining pending patches.');
      return { success: true, conflict: false };
    } catch (err: any) {
      return { success: false, conflict: false, error: err.message || 'Unknown rollback error' };
    }
  }


  /**
   * Accepts a patch: marks it ACCEPTED and advances the session baseline to
   * "current content minus all still-pending patches".
   *
   * Why not just use the full current content as baseline?
   * Because the current content contains BOTH the just-accepted patch AND any
   * other patches the user hasn't reviewed yet.  If we stored that as the
   * baseline, the next time the watcher compares baseline vs current it would
   * find no diff → the un-reviewed patches would silently disappear.
   *
   * Instead we compute:
   *   new_baseline = current_content with every STILL-PENDING patch reverted
   * so the baseline represents "everything accepted so far" and future diffs
   * still surface the remaining pending hunks.
   */
  public async acceptPatch(patchId: string): Promise<void> {
    const patch = this.patchesRepo.getById(patchId);
    if (!patch) return;

    // Mark this patch as accepted
    this.patchesRepo.updateStatus(patchId, 'ACCEPTED');

    // Remove this patch's line-ownership entries
    const remaining = this.lineOwnershipRepo.getFileOwnership(patch.filePath)
      .filter(lo => lo.associatedPatchId !== patchId);
    this.lineOwnershipRepo.clearOwnershipForFile(patch.filePath);
    this.lineOwnershipRepo.setOwnershipBulk(patch.filePath, remaining.map(lo => ({
      lineNumber: lo.lineNumber,
      owner: lo.owner,
      associatedPatchId: lo.associatedPatchId
    })));

    if (!this.fileStatesRepo || !fs.existsSync(patch.filePath)) return;

    const fileState = this.fileStatesRepo.getByFileAndSession(patch.filePath, patch.sessionId);
    if (!fileState) return;

    const currentContent = fs.readFileSync(patch.filePath, 'utf8');

    // ── Compute new baseline ─────────────────────────────────────────────
    // Get all patches that are STILL PENDING for this file (excluding the
    // just-accepted one, which is now ACCEPTED in the DB).
    const stillPending = this.patchesRepo
      .getByFileAndSession(patch.filePath, patch.sessionId)
      .filter(p => p.status === 'PENDING');

    // Sort descending by modifiedStartLine so we revert from bottom to top.
    // This prevents line-number shifts from affecting earlier hunks as we go.
    stillPending.sort((a, b) => b.modifiedStartLine - a.modifiedStartLine);

    let baseLines = currentContent.split('\n');
    for (const pendingPatch of stillPending) {
      // Surgically remove this pending hunk's added/modified lines and
      // restore the original lines that existed before the AI edited them.
      const start = pendingPatch.modifiedStartLine - 1;           // 0-indexed, inclusive
      const end   = start + pendingPatch.modifiedLineCount;       // 0-indexed, exclusive
      const origLines = pendingPatch.rawOriginal === ''
        ? []
        : pendingPatch.rawOriginal.split('\n');

      baseLines = [
        ...baseLines.slice(0, start),
        ...origLines,
        ...baseLines.slice(end)
      ];
      console.log(`[Stavreng] Accept: reverted pending patch ${pendingPatch.id} from new baseline`);
    }

    const newBaseContent = baseLines.join('\n');
    const newBaseSha256  = this.journalManager.createBackup(patch.filePath, newBaseContent);

    fileState.baseSha256   = newBaseSha256;
    fileState.currentSha256 = this.journalManager.calculateHash(currentContent);
    fileState.lastModified  = Date.now();
    this.fileStatesRepo.upsert(fileState);

    console.log(
      `[Stavreng] Accept: baseline promoted. stillPending=${stillPending.length}`,
      'file:', patch.filePath
    );
  }

}
