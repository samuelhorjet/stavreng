import * as vscode from 'vscode';
import * as fs from 'fs';

import { SessionsRepository } from '../db/sessions.js';
import { FileStatesRepository } from '../db/fileStates.js';
import { PatchesRepository } from '../db/patches.js';
import { JournalManager } from './journal.js';
import { DiffEngine } from '../merge/diff.js';
import { normalizePath } from '../db/pathUtils.js';
import { StavrengSidebarProvider } from '../ui/sidebarWebview.js';
import { IgnoreManager } from './ignoreManager.js';
import { StringEditTracker } from '../vcs/stringEditTracker.js';

export class WorkspaceWatcher {
  private watcher: vscode.FileSystemWatcher | null = null;
  private diffEngine: DiffEngine;

  /**
   * Pre-change content cache.
   * Stores the content of each file as it was BEFORE any external change fires.
   */
  private contentCache: Map<string, string> = new Map();

  /**
   * Debounce timers to prevent concurrent/duplicate processing of file system events.
   */
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();

  /** Called after a file change is processed and patches are recorded in the DB. */
  public onFileMutated: ((filePath: string) => void) | null = null;

  /** True once snapshotWorkspace() has completed. The terminal gate reads this. */
  public isReady = false;

  /**
   * Call this BEFORE writing a file from a rollback or accept operation.
   * Both the onDidChangeTextDocument event AND the FSW event will be swallowed
   * by the StringEditTracker so they don't get re-classified.
   */
  public suppressNextChangeFor(filePath: string): void {
    this.stringEditTracker.suppressNextChangeFor(filePath);
  }

  private ignoreManager: IgnoreManager;

  constructor(
    private workspacePath: string,
    private sessionsRepo: SessionsRepository,
    private fileStatesRepo: FileStatesRepository,
    private patchesRepo: PatchesRepository,
    private journalManager: JournalManager,
    private terminalProvider: StavrengSidebarProvider,
    private stringEditTracker: StringEditTracker
  ) {
    this.diffEngine = new DiffEngine();
    this.ignoreManager = new IgnoreManager(workspacePath);
  }

  public start(): void {
    if (this.watcher) return;
    console.log('[Stavreng] Watcher.start() — workspace:', this.workspacePath);

    // ── File System Watcher (external changes from AI agents) ──────────────
    const relativePattern = new vscode.RelativePattern(this.workspacePath, '**/*');
    this.watcher = vscode.workspace.createFileSystemWatcher(relativePattern);

    this.watcher.onDidChange(uri => {
      this.triggerHandleFileChange(uri.fsPath);
    });
    this.watcher.onDidCreate(uri => {
      this.triggerHandleFileChange(uri.fsPath);
    });
    this.watcher.onDidDelete(uri => {
      this.handleFileDelete(uri.fsPath);
    });

    // ── Cache update on human typing ──────────────────────────────────────
    // Keep the in-memory cache in sync as the user types (before they save).
    // This ensures the cache always reflects the latest in-editor content
    // so when a human save fires, we read the correct pre-save baseline.
    vscode.workspace.onDidChangeTextDocument(event => {
      const doc = event.document;
      if (doc.uri.scheme !== 'file') return;
      if (doc.isDirty && event.contentChanges.length > 0) {
        const normPath = normalizePath(doc.uri.fsPath);
        // Only update the cache with human typing IF the file is NOT being
        // processed as an AI write (suppressed path). This prevents the cache
        // baseline from being overwritten with AI content before the FSW fires.
        if (!this.stringEditTracker.isSuppressed(normPath)) {
          this.contentCache.set(normPath, doc.getText());
        }
      }
    });
  }

  /**
   * Re-snapshot the workspace to establish fresh baselines.
   * Called on every session start so the cache always reflects the current
   * state of all files BEFORE the agent begins editing.
   */
  public async refreshSnapshot(): Promise<void> {
    this.isReady = false;
    await this.snapshotWorkspace();
  }

  public stop(): void {
    if (this.watcher) {
      this.watcher.dispose();
      this.watcher = null;
    }
    // DO NOT clear contentCache here.
    // The cache is the baseline for detecting changes. Clearing it means the
    // next session has no reference point and every file looks like it was
    // just created from nothing (showing the entire file as AI-added).
    // The cache persists across sessions and is only updated after each
    // FSW event or snapshot. Entries only become stale if a file is deleted
    // (handled in handleFileDelete by removing that specific entry).
    this.isReady = false; // Block FSW events until next snapshot completes.
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
  }

  /**
   * Debounces the execution of handleFileChange to prevent concurrency bugs
   * when the file system fires multiple events within milliseconds.
   */
  private triggerHandleFileChange(filePath: string, overrideCurrentContent?: string): void {
    const normPath = normalizePath(filePath);

    const existingTimer = this.debounceTimers.get(normPath);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      this.debounceTimers.delete(normPath);
      this.handleFileChange(filePath, overrideCurrentContent).catch(err => {
        console.error('[Stavreng] Error in debounced handleFileChange:', err);
      });
    }, 500);

    this.debounceTimers.set(normPath, timer);
  }

  /**
   * Instantly crawls the workspace and loads the current text of all valid
   * files into the baseline cache. Respects .gitignore and .stavreng-ignore.
   */
  public async snapshotWorkspace(): Promise<void> {
    if (!this.workspacePath) return;

    const excludeGlob = this.ignoreManager.getExcludeGlob();

    try {
      console.log('[Stavreng] Taking workspace snapshot...');
      const files = await vscode.workspace.findFiles('**/*', excludeGlob || undefined);

      const batchSize = 100;
      for (let i = 0; i < files.length; i += batchSize) {
        const batch = files.slice(i, i + batchSize);
        await Promise.all(batch.map(async (uri) => {
          try {
            if (this.ignoreManager.shouldIgnorePath(uri.fsPath)) return;
            const stat = await vscode.workspace.fs.stat(uri);
            if (stat.size < 1024 * 1024) {
              const uint8Array = await vscode.workspace.fs.readFile(uri);
              const content = new TextDecoder().decode(uint8Array);
              this.contentCache.set(normalizePath(uri.fsPath), content);
            }
          } catch (e) {
            // Ignore unreadable files
          }
        }));
      }
      console.log(`[Stavreng] Workspace snapshot complete. Cached ${this.contentCache.size} files in memory.`);
    } catch (err) {
      console.error('[Stavreng] Failed to snapshot workspace:', err);
    } finally {
      this.isReady = true;
    }
  }

  private async handleFileChange(filePath: string, overrideCurrentContent?: string): Promise<void> {
    filePath = normalizePath(filePath);

    // ── Gate on snapshot readiness ─────────────────────────────────────────
    // If the snapshot is still running, the cache doesn't have the pre-AI
    // baseline yet. Defer this event until the snapshot is ready.
    // Without this gate, an agent that starts writing immediately after session
    // start would get empty string as the baseline for every file.
    if (!this.isReady) {
      const waitForReady = () => new Promise<void>(resolve => {
        const interval = setInterval(() => {
          if (this.isReady) { clearInterval(interval); resolve(); }
        }, 100);
      });
      await waitForReady();
    }

    // ── Suppress rollback/accept writes ─────────────────────────────────────
    // The StringEditTracker already swallowed the onDidChangeTextDocument event
    // for this path. Now consume the FSW suppression and sync the cache only.
    if (this.stringEditTracker.isSuppressed(filePath)) {
      this.stringEditTracker.consumeSuppression(filePath);
      if (fs.existsSync(filePath)) {
        const content = overrideCurrentContent ?? fs.readFileSync(filePath, 'utf8');
        this.contentCache.set(filePath, content);
      }
      return;
    }

    // ── Ignore paths matching .stavreng-ignore ──────────────────────────────
    if (this.ignoreManager.shouldIgnorePath(filePath)) return;

    // ── Must have an active session ────────────────────────────────────────
    const activeSession = this.sessionsRepo.getActiveSession();
    if (!activeSession) {
      console.log('[Stavreng] No active session, ignoring:', filePath);
      return;
    }

    try {
      if (!fs.existsSync(filePath)) return;

      // ── Determine current content ───────────────────────────────────────
      const currentContent = overrideCurrentContent ?? fs.readFileSync(filePath, 'utf8');

      // ── Determine baseline content ──────────────────────────────────────
      let fileState = this.fileStatesRepo.getByFileAndSession(filePath, activeSession.id);
      let baseContent: string;

      if (!fileState) {
        baseContent = this.getBaselineContent(filePath);
        console.log(`[Stavreng] New file in session. baseLen=${baseContent.length} currentLen=${currentContent.length}`);

        const baseSha256 = this.journalManager.createBackup(filePath, baseContent);
        fileState = {
          filePath,
          sessionId: activeSession.id,
          baseSha256,
          currentSha256: this.journalManager.calculateHash(currentContent),
          lastModified: Date.now()
        };
        this.fileStatesRepo.upsert(fileState);
      } else {
        baseContent = this.journalManager.getBackupContent(fileState.baseSha256) || '';
        console.log(`[Stavreng] Existing file state. baseLen=${baseContent.length} currentLen=${currentContent.length}`);
      }

      // ── Generate diff hunks ────────────────────────────────────────────
      const hunks = this.diffEngine.generateHunks(baseContent, currentContent);
      console.log(`[Stavreng] Diff produced ${hunks.length} hunk(s) for:`, filePath);

      // ── Remove old PENDING patches for this file ────────────────────────
      const stillPending = this.patchesRepo
        .getByFileAndSession(filePath, activeSession.id)
        .filter(p => p.status === 'PENDING');

      stillPending.forEach(p => this.patchesRepo.delete(p.id));

      // ── Determine human save vs AI write ────────────────────────────────
      // VS Code-aligned detection:
      //   human save  = onWillSaveTextDocument fired (tracked by StringEditTracker)
      //               OR agent is not running (agent idle means any save is human)
      //   AI write    = FSW fired with no prior onWillSaveTextDocument
      //
      // NOTE: consumeHumanSave also returns false when agent is idle — we check
      // isAgentRunning() separately for that case.
      let isHumanSave = this.stringEditTracker.consumeHumanSave(filePath);
      if (!this.terminalProvider.isAgentRunning()) {
        isHumanSave = true;
      }

      if (isHumanSave) {
        // ── Human save path ─────────────────────────────────────────────
        // Reconstruct a new baseline by scanning currentContent for each pending patch.
        //
        // For MATCHED patches (AI's rawModified still in file untouched):
        //   → put rawOriginal back in baseline, keep rawModified in current
        //   → re-diff produces: rawOriginal → rawModified (AI patch, still pending)
        //
        // For UNMATCHED patches (human edited the AI-modified line):
        //   → put rawOriginal back in baseline at the estimated position
        //   → re-diff produces: rawOriginal → human's version (still pending)
        //   → Accept = saves human's version | Reject = restores original
        //
        // For lines outside all patches: copy from currentContent into baseline
        //   → silently committed (no patch shown, not an AI edit)
        console.log('[Stavreng] Human save detected — running line-level hunk matching for:', filePath);

        const currentLines = currentContent.split(/\r?\n/);
        if (currentLines.length > 0 && currentLines[currentLines.length - 1] === '') {
          currentLines.pop();
        }

        const baseLines = baseContent.split(/\r?\n/);
        if (baseLines.length > 0 && baseLines[baseLines.length - 1] === '') {
          baseLines.pop();
        }

        // All ranges map a span of currentLines to rawOriginal in the new baseline.
        // Both matched (untouched) and unmatched (human-edited) patches use the same
        // reconstruction logic — rawOriginal goes into the baseline, re-diff does the rest.
        const allRanges: { start: number; end: number; patch: typeof stillPending[0] }[] = [];
        const claimedIndices = new Set<number>();

        const sortedPatches = [...stillPending].sort((a, b) => a.modifiedStartLine - b.modifiedStartLine);
        let accumulatedHumanShift = 0;

        for (const p of sortedPatches) {
          const modLines = p.rawModified === '' ? [] : p.rawModified.split(/\r?\n/);
          const expectedStart = p.modifiedStartLine - 1 + accumulatedHumanShift;
          const maxDist = 100;
          let bestStart = -1;

          // Search for AI's rawModified text in currentLines
          for (let dist = 0; dist <= maxDist; dist++) {
            const candidates = dist === 0 ? [expectedStart] : [expectedStart - dist, expectedStart + dist];
            for (const i of candidates) {
              if (i < 0 || i + modLines.length > currentLines.length) continue;

              // Check overlap with already claimed ranges
              let overlaps = false;
              for (let j = 0; j < modLines.length; j++) {
                if (claimedIndices.has(i + j)) { overlaps = true; break; }
              }
              if (overlaps) continue;

              // Check content match
              let contentMatch = true;
              for (let j = 0; j < modLines.length; j++) {
                if (currentLines[i + j] !== modLines[j]) { contentMatch = false; break; }
              }
              if (!contentMatch) continue;

              // Additional context check for pure deletions
              if (modLines.length === 0) {
                let contextMatch = true;
                const expectedBeforeIdx = p.originalStartLine - 2;
                const expectedAfterIdx = p.originalStartLine - 1 + p.originalLineCount;

                if (expectedBeforeIdx >= 0 && expectedBeforeIdx < baseLines.length) {
                  const currentBeforeIdx = i - 1;
                  if (currentBeforeIdx < 0 || currentBeforeIdx >= currentLines.length || currentLines[currentBeforeIdx] !== baseLines[expectedBeforeIdx]) {
                    contextMatch = false;
                  }
                }
                if (expectedAfterIdx >= 0 && expectedAfterIdx < baseLines.length) {
                  const currentAfterIdx = i;
                  if (currentAfterIdx < 0 || currentAfterIdx >= currentLines.length || currentLines[currentAfterIdx] !== baseLines[expectedAfterIdx]) {
                    contextMatch = false;
                  }
                }
                if (!contextMatch) continue;
              }

              bestStart = i;
              break;
            }
            if (bestStart !== -1) break;
          }

          if (bestStart !== -1) {
            // MATCHED: AI text still there untouched — claim it and keep patch pending.
            for (let j = 0; j < modLines.length; j++) claimedIndices.add(bestStart + j);
            allRanges.push({ start: bestStart, end: bestStart + modLines.length, patch: p });
            accumulatedHumanShift = bestStart - (p.modifiedStartLine - 1);
            console.log(`[Stavreng] Matched untouched patch ${p.id} at index ${bestStart} (shift ${accumulatedHumanShift})`);
          } else {
            // UNMATCHED: Human edited the AI-modified line.
            // Keep this patch PENDING — the review will show rawOriginal → human's version.
            // Claim the estimated range in currentContent so rawOriginal goes into baseline.
            const estStart = Math.max(0, Math.min(expectedStart, currentLines.length));
            const estEnd = Math.min(estStart + modLines.length, currentLines.length);

            let overlapsExisting = false;
            for (let j = estStart; j < estEnd; j++) {
              if (claimedIndices.has(j)) { overlapsExisting = true; break; }
            }

            if (!overlapsExisting) {
              for (let j = estStart; j < estEnd; j++) claimedIndices.add(j);
              allRanges.push({ start: estStart, end: estEnd, patch: p });
              console.log(`[Stavreng] Patch ${p.id} was edited by human — keeping pending at estimated index ${estStart}.`);
            } else {
              console.log(`[Stavreng] Patch ${p.id} overlaps claimed range — dropping.`);
            }
          }
        }

        // Reconstruct new baseline:
        //   - For all patch ranges: put rawOriginal (restores pre-AI content)
        //   - For everything else: put currentLines (human edits outside AI zones → committed silently)
        const newBaseLines: string[] = [];
        let currentIndex = 0;

        allRanges.sort((a, b) => a.start - b.start);

        for (const range of allRanges) {
          while (currentIndex < range.start) {
            newBaseLines.push(currentLines[currentIndex]);
            currentIndex++;
          }
          const origLines = range.patch.rawOriginal === '' ? [] : range.patch.rawOriginal.split(/\r?\n/);
          newBaseLines.push(...origLines);
          currentIndex = range.end;
        }

        while (currentIndex < currentLines.length) {
          newBaseLines.push(currentLines[currentIndex]);
          currentIndex++;
        }

        const newBaseContent = newBaseLines.join('\n');

        const newBaseSha256 = this.journalManager.createBackup(filePath, newBaseContent);
        fileState.baseSha256 = newBaseSha256;
        this.fileStatesRepo.upsert(fileState);
        baseContent = newBaseContent;

        // Re-diff: produces updated pending patches with correct line numbers.
        // Matched patches:   rawOriginal → rawModified  (AI's change, still pending)
        // Unmatched patches: rawOriginal → human's text (human's override, still pending)
        const refreshedHunks = this.diffEngine.generateHunks(newBaseContent, currentContent);
        console.log(`[Stavreng] Human save re-diff: ${refreshedHunks.length} AI hunk(s) remaining`);

        refreshedHunks.forEach((hunk, idx) => {
          const patchId = `patch_${activeSession.id}_${Date.now()}_${idx}`;
          this.patchesRepo.create({
            id: patchId, sessionId: activeSession.id, filePath, status: 'PENDING',
            createdAt: Date.now(),
            originalStartLine: hunk.originalStartLine, originalLineCount: hunk.originalLineCount,
            modifiedStartLine: hunk.modifiedStartLine, modifiedLineCount: hunk.modifiedLineCount,
            hunkDiff: hunk.hunkDiff, rawOriginal: hunk.rawOriginal, rawModified: hunk.rawModified
          });
        });

        this.stringEditTracker.onHumanSavedFile(filePath);


      } else {
        // ── AI write path ───────────────────────────────────────────────
        // External agent wrote this file. Create AI patches for all diff hunks.
        // No line ownership check needed — StringEditTracker has the correct state.
        console.log('[Stavreng] AI write detected — creating patches for:', filePath);

        const oldCachedContent = this.contentCache.get(filePath) ?? baseContent;

        hunks.forEach((hunk, idx) => {
          const patchId = `patch_${activeSession.id}_${Date.now()}_${idx}`;
          this.patchesRepo.create({
            id: patchId, sessionId: activeSession.id, filePath, status: 'PENDING',
            createdAt: Date.now(),
            originalStartLine: hunk.originalStartLine, originalLineCount: hunk.originalLineCount,
            modifiedStartLine: hunk.modifiedStartLine, modifiedLineCount: hunk.modifiedLineCount,
            hunkDiff: hunk.hunkDiff, rawOriginal: hunk.rawOriginal, rawModified: hunk.rawModified
          });
        });

        // Notify tracker that the AI wrote this file.
        // (Character-level tracking retired; this is now a no-op stub.)
        this.stringEditTracker.onAIWroteFile(filePath, oldCachedContent, currentContent);
      }

      // ── Update file state ──────────────────────────────────────────────
      fileState.currentSha256 = this.journalManager.calculateHash(currentContent);
      fileState.lastModified = Date.now();
      this.fileStatesRepo.upsert(fileState);

      // ── Update cache ───────────────────────────────────────────────────
      this.contentCache.set(filePath, currentContent);

      // ── Notify UI ──────────────────────────────────────────────────────
      this.onFileMutated?.(filePath);

    } catch (err) {
      console.error('[Stavreng] Watcher failed to process file change:', err);
    }
  }

  private async handleFileDelete(filePath: string): Promise<void> {
    filePath = normalizePath(filePath);

    if (
      filePath.includes('/.stavreng/') ||
      filePath.includes('/node_modules/') ||
      filePath.includes('/.git/') ||
      filePath.endsWith('/target') ||
      filePath.includes('/target/') ||
      filePath.includes('/dist/') ||
      filePath.includes('/out/') ||
      filePath.includes('.tmp') ||
      filePath.endsWith('~') ||
      filePath.endsWith('.bak')
    ) {
      return;
    }

    const activeSession = this.sessionsRepo.getActiveSession();
    if (!activeSession) return;

    let isHumanDelete = this.stringEditTracker.consumeHumanSave(filePath);
    if (!this.terminalProvider.isAgentRunning()) {
      isHumanDelete = true;
    }

    try {
      const fileState = this.fileStatesRepo.getByFileAndSession(filePath, activeSession.id);
      if (!fileState) return;

      const baseContent = this.journalManager.getBackupContent(fileState.baseSha256) || '';

      const existingDelete = this.patchesRepo.getByFileAndSession(filePath, activeSession.id)
        .find(p => p.status === 'PENDING' && p.modifiedLineCount === 0);
      if (existingDelete) return;

      if (isHumanDelete) {
        console.log('[Stavreng] Human delete — cleaning session entries for:', filePath);
        this.patchesRepo.getByFileAndSession(filePath, activeSession.id).forEach(p => {
          this.patchesRepo.delete(p.id);
        });
        this.fileStatesRepo.delete(filePath, activeSession.id);
        this.stringEditTracker.clearFile(filePath);
        this.contentCache.delete(filePath); // Remove stale cache entry for deleted file
        this.onFileMutated?.(filePath);
        return;
      }

      // AI/External delete: create a deletion patch
      const originalLines = baseContent.split(/\r?\n/);
      const patchId = `patch_${activeSession.id}_${Date.now()}_delete`;

      this.patchesRepo.create({
        id: patchId, sessionId: activeSession.id, filePath,
        status: 'PENDING', createdAt: Date.now(),
        originalStartLine: 1, originalLineCount: originalLines.length,
        modifiedStartLine: 1, modifiedLineCount: 0,
        hunkDiff: originalLines.map(line => `-${line}`).join('\n'),
        rawOriginal: baseContent, rawModified: ''
      });

      console.log('[Stavreng] AI file deletion recorded for:', filePath);
      this.onFileMutated?.(filePath);
    } catch (err) {
      console.error('[Stavreng] Failed to handle file delete:', err);
    }
  }

  private getBaselineContent(filePath: string): string {
    const cached = this.contentCache.get(filePath);
    if (cached !== undefined) {
      console.log('[Stavreng] Using cached baseline for:', filePath);
      return cached;
    }
    console.log('[Stavreng] No baseline found, using empty string for:', filePath);
    return '';
  }
}
