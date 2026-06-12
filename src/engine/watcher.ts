import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { SessionsRepository } from '../db/sessions.js';
import { FileStatesRepository } from '../db/fileStates.js';
import { PatchesRepository } from '../db/patches.js';
import { LineOwnershipRepository } from '../db/lineOwnership.js';
import { JournalManager } from './journal.js';
import { DiffEngine } from '../merge/diff.js';
import { normalizePath } from '../db/pathUtils.js';
import { StavrengSidebarProvider } from '../ui/sidebarWebview.js';

export class WorkspaceWatcher {
  private watcher: vscode.FileSystemWatcher | null = null;
  private diffEngine: DiffEngine;

  /**
   * Pre-change content cache.
   * Stores the content of each file as it was BEFORE any external change fires.
   */
  private contentCache: Map<string, string> = new Map();

  /**
   * Tracks files that are about to be saved by the USER from within VS Code.
   * When a file path is in this set, the next FSW event for that file should
   * advance the baseline (auto-accept the human edit) instead of creating AI patches.
   */
  private pendingHumanSaves: Set<string> = new Set();

  /** Called after a file change is processed and patches are recorded in the DB. */
  public onFileMutated: ((filePath: string) => void) | null = null;

  constructor(
    private workspacePath: string,
    private sessionsRepo: SessionsRepository,
    private fileStatesRepo: FileStatesRepository,
    private patchesRepo: PatchesRepository,
    private lineOwnershipRepo: LineOwnershipRepository,
    private journalManager: JournalManager,
    private terminalProvider: StavrengSidebarProvider
  ) {
    this.diffEngine = new DiffEngine();
  }

  public start(): void {
    if (this.watcher) return;
    console.log('[Stavreng] Watcher.start() — workspace:', this.workspacePath);

    // ── 1. Pre-cache all currently open documents ──────────────────────────
    vscode.workspace.textDocuments.forEach(doc => {
      if (!doc.isClosed && doc.uri.scheme === 'file') {
        const normPath = normalizePath(doc.uri.fsPath);
        this.contentCache.set(normPath, doc.getText());
        console.log('[Stavreng] Pre-cached:', normPath);
      }
    });

    // ── 2. Cache any document that opens or becomes active ─────────────────
    vscode.workspace.onDidOpenTextDocument(doc => {
      if (doc.uri.scheme === 'file') {
        const normPath = normalizePath(doc.uri.fsPath);
        if (!this.contentCache.has(normPath)) {
          this.contentCache.set(normPath, doc.getText());
          console.log('[Stavreng] Cached on open:', normPath);
        }
      }
    });

    vscode.window.onDidChangeActiveTextEditor(editor => {
      if (editor && editor.document.uri.scheme === 'file') {
        const normPath = normalizePath(editor.document.uri.fsPath);
        if (!editor.document.isDirty) {
          this.contentCache.set(normPath, editor.document.getText());
          console.log('[Stavreng] Cache refreshed on activate:', normPath);
        }
      }
    });

    // ── 3. Detect when the USER saves from inside VS Code ──────────────────
    // onWillSaveTextDocument fires BEFORE the file hits disk, so we can mark
    // it as a human save. When the FSW event fires immediately after, we know
    // to advance the baseline (auto-accept human edit) instead of creating patches.
    vscode.workspace.onWillSaveTextDocument(event => {
      if (event.document.uri.scheme === 'file' && event.document.isDirty) {
        const normPath = normalizePath(event.document.uri.fsPath);
        this.pendingHumanSaves.add(normPath);
        console.log('[Stavreng] Human save pending for:', normPath);
      }
    });

    // ── 3. File System Watcher (external changes from AI agents / Notepad) ──
    const relativePattern = new vscode.RelativePattern(this.workspacePath, '**/*');
    this.watcher = vscode.workspace.createFileSystemWatcher(relativePattern);

    this.watcher.onDidChange(uri => {
      console.log('[Stavreng] FSW onDidChange:', uri.fsPath);
      this.handleFileChange(uri.fsPath);
    });
    this.watcher.onDidCreate(uri => {
      console.log('[Stavreng] FSW onDidCreate:', uri.fsPath);
      this.handleFileChange(uri.fsPath);
    });
    this.watcher.onDidDelete(uri => {
      console.log('[Stavreng] FSW onDidDelete:', uri.fsPath);
      this.handleFileDelete(uri.fsPath);
    });

    // ── 4. onDidChangeTextDocument — catches VS Code in-editor saves too ───
    // When VS Code reloads a file from disk (isDirty=false), this fires after
    // the FSW event. We also trigger handleFileChange here as a safety net.
    vscode.workspace.onDidChangeTextDocument(event => {
      const doc = event.document;
      if (doc.uri.scheme !== 'file') return;
      const normPath = normalizePath(doc.uri.fsPath);
      // isDirty=false means VS Code reloaded from disk (external change)
      if (!doc.isDirty && event.contentChanges.length > 0) {
        console.log('[Stavreng] onDidChangeTextDocument (external reload):', normPath);
        this.handleFileChange(normPath, doc.getText());
      }
    });
  }

  public stop(): void {
    if (this.watcher) {
      this.watcher.dispose();
      this.watcher = null;
    }
    this.contentCache.clear();
  }

  /**
   * @param filePath   Absolute path to the changed file.
   * @param overrideCurrentContent  If provided, use this as the "new" content
   *                                instead of reading from disk (supplied by the
   *                                onDidChangeTextDocument handler which already
   *                                has the updated document text).
   */
  private async handleFileChange(filePath: string, overrideCurrentContent?: string): Promise<void> {
    filePath = normalizePath(filePath);
    // ── Ignore build/meta directories ──────────────────────────────────────
    const normalized = filePath;
    if (
      normalized.includes('/.stavreng/') ||
      normalized.includes('/node_modules/') ||
      normalized.includes('/.git/') ||
      normalized.endsWith('/target') ||
      normalized.includes('/target/') ||     // Rust target dir (has sub-dirs)
      normalized.includes('/dist/') ||
      normalized.includes('/out/') ||
      normalized.includes('.tmp') ||         // AI agent backup files
      normalized.endsWith('~') ||
      normalized.endsWith('.bak')
    ) {
      console.log('[Stavreng] Ignored path:', filePath);
      return;
    }

    // ── Must have an active session ────────────────────────────────────────
    const activeSession = this.sessionsRepo.getActiveSession();
    if (!activeSession) {
      console.log('[Stavreng] No active session, ignoring:', filePath);
      return;
    }

    try {
      if (!fs.existsSync(filePath)) return;

      // ── Determine "new" (post-change) content ──────────────────────────
      const currentContent = overrideCurrentContent ?? fs.readFileSync(filePath, 'utf8');

      // ── Determine baseline (pre-change) content ────────────────────────
      let fileState = this.fileStatesRepo.getByFileAndSession(filePath, activeSession.id);
      let baseContent: string;

      if (!fileState) {
        // First time we see this file in the session — get baseline
        baseContent = this.getBaselineContent(filePath);
        console.log(`[Stavreng] New file in session. baseLen=${baseContent.length} currentLen=${currentContent.length} file=${filePath}`);

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

      // ── Get pending patches BEFORE deleting them ────────────────────────
      const stillPending = this.patchesRepo
        .getByFileAndSession(filePath, activeSession.id)
        .filter(p => p.status === 'PENDING');

      // ── Remove old PENDING patches for this file ────────────────────────
      stillPending.forEach(p => {
        this.patchesRepo.delete(p.id);
      });

      // ── Insert new patches & line ownerships ────────────────────────────
      // Before inserting: check if this file save was made by the USER from
      // within VS Code (detected via onWillSaveTextDocument above).
      // If it's a human save or the AI agent terminal is idle, automatically
      // treat all edits as human (auto-accept, no prompts).
      // Otherwise (if agent is running): check if it was saved by human in VS Code.
      let isHumanSave = this.pendingHumanSaves.delete(filePath);
      if (!this.terminalProvider.isAgentRunning()) {
        isHumanSave = true;
      }

      if (isHumanSave) {
        console.log('[Stavreng] Human save detected — advancing baseline for:', filePath);
        // Advance baseline = current content minus all still-pending AI patches
        // (same formula as acceptPatch uses)
        stillPending.sort((a, b) => b.modifiedStartLine - a.modifiedStartLine);

        let newBaseLines = currentContent.split('\n');
        for (const p of stillPending) {
          const start = p.modifiedStartLine - 1;
          const end   = start + p.modifiedLineCount;
          const origLines = p.rawOriginal === '' ? [] : p.rawOriginal.split('\n');
          newBaseLines = [
            ...newBaseLines.slice(0, start),
            ...origLines,
            ...newBaseLines.slice(end)
          ];
        }

        const newBaseContent = newBaseLines.join('\n');
        const newBaseSha256  = this.journalManager.createBackup(filePath, newBaseContent);
        fileState.baseSha256 = newBaseSha256;
        this.fileStatesRepo.upsert(fileState);
        baseContent = newBaseContent; // use this for the re-diff below

        // Re-diff with the updated baseline so still-pending AI patches get
        // recreated with correct (post-human-edit) line numbers
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
          const aiLines: { lineNumber: number; owner: 'AI'; associatedPatchId: string }[] = [];
          for (let i = 0; i < hunk.modifiedLineCount; i++) {
            aiLines.push({ lineNumber: hunk.modifiedStartLine + i, owner: 'AI', associatedPatchId: patchId });
          }
          if (aiLines.length > 0) {
            this.lineOwnershipRepo.setOwnershipBulk(filePath, aiLines);
          }
        });

      } else {
        // ── External / AI save: check per-hunk ownership before creating patches ─
        hunks.forEach((hunk, idx) => {
          // If ALL modified lines in this hunk are already HUMAN-owned,
          // the user typed them directly in VS Code — don't create an AI patch.
          if (hunk.modifiedLineCount > 0) {
            const allHuman = Array.from(
              { length: hunk.modifiedLineCount },
              (_, i) => this.lineOwnershipRepo.getOwnership(filePath, hunk.modifiedStartLine + i)
            ).every(lo => lo?.owner === 'HUMAN');

            if (allHuman) {
              console.log(`[Stavreng] Skipping human-authored hunk at line ${hunk.modifiedStartLine}`);
              return; // Skip this hunk — it was written by the user, not an AI tool
            }
          }

          const patchId = `patch_${activeSession.id}_${Date.now()}_${idx}`;
          this.patchesRepo.create({
            id: patchId, sessionId: activeSession.id, filePath, status: 'PENDING',
            createdAt: Date.now(),
            originalStartLine: hunk.originalStartLine, originalLineCount: hunk.originalLineCount,
            modifiedStartLine: hunk.modifiedStartLine, modifiedLineCount: hunk.modifiedLineCount,
            hunkDiff: hunk.hunkDiff, rawOriginal: hunk.rawOriginal, rawModified: hunk.rawModified
          });

          const aiLines: { lineNumber: number; owner: 'AI'; associatedPatchId: string }[] = [];
          for (let i = 0; i < hunk.modifiedLineCount; i++) {
            const lineNumber = hunk.modifiedStartLine + i;
            const existing = this.lineOwnershipRepo.getOwnership(filePath, lineNumber);
            if (!existing || existing.owner !== 'HUMAN') {
              aiLines.push({ lineNumber, owner: 'AI', associatedPatchId: patchId });
            }
          }
          if (aiLines.length > 0) {
            this.lineOwnershipRepo.setOwnershipBulk(filePath, aiLines);
          }
        });
      }

      // ── Update file hash ────────────────────────────────────────────────
      fileState.currentSha256 = this.journalManager.calculateHash(currentContent);
      fileState.lastModified = Date.now();
      this.fileStatesRepo.upsert(fileState);

      // ── Update cache with new content ───────────────────────────────────
      this.contentCache.set(filePath, currentContent);

      // ── Notify UI ──────────────────────────────────────────────────────
      if (this.onFileMutated) {
        this.onFileMutated(filePath);
      }

    } catch (err) {
      console.error('[Stavreng] Watcher failed to process file change:', err);
    }
  }

  private async handleFileDelete(filePath: string): Promise<void> {
    filePath = normalizePath(filePath);

    // Ignore build/meta/temp files
    const normalized = filePath;
    if (
      normalized.includes('/.stavreng/') ||
      normalized.includes('/node_modules/') ||
      normalized.includes('/.git/') ||
      normalized.endsWith('/target') ||
      normalized.includes('/target/') ||
      normalized.includes('/dist/') ||
      normalized.includes('/out/') ||
      normalized.includes('.tmp') ||
      normalized.endsWith('~') ||
      normalized.endsWith('.bak')
    ) {
      return;
    }

    const activeSession = this.sessionsRepo.getActiveSession();
    if (!activeSession) return;

    // Check if this delete was made by the user or the agent
    let isHumanDelete = this.pendingHumanSaves.delete(filePath);
    if (!this.terminalProvider.isAgentRunning()) {
      isHumanDelete = true;
    }

    try {
      const fileState = this.fileStatesRepo.getByFileAndSession(filePath, activeSession.id);
      if (!fileState) {
        // No baseline, meaning the file was created and deleted in this session without being saved/accepted.
        // We don't have baseline content, so nothing to restore. We can just ignore.
        return;
      }

      const baseContent = this.journalManager.getBackupContent(fileState.baseSha256) || '';
      
      // If the file was already deleted and we have recorded a pending delete patch, don't duplicate it.
      const existingDelete = this.patchesRepo.getByFileAndSession(filePath, activeSession.id)
        .find(p => p.status === 'PENDING' && p.modifiedLineCount === 0);
      if (existingDelete) return;

      if (isHumanDelete) {
        console.log('[Stavreng] Human delete detected — clean session database entries for:', filePath);
        // Human explicitly deleted it, so we accept the delete as baseline:
        this.patchesRepo.getByFileAndSession(filePath, activeSession.id).forEach(p => {
          this.patchesRepo.delete(p.id);
        });
        this.fileStatesRepo.delete(filePath, activeSession.id);
        this.lineOwnershipRepo.clearOwnershipForFile(filePath);
        
        if (this.onFileMutated) {
          this.onFileMutated(filePath);
        }
        return;
      }

      // AI/External delete: create a deletion patch
      const originalLines = baseContent.split(/\r?\n/);
      const patchId = `patch_${activeSession.id}_${Date.now()}_delete`;
      
      this.patchesRepo.create({
        id: patchId,
        sessionId: activeSession.id,
        filePath,
        status: 'PENDING',
        createdAt: Date.now(),
        originalStartLine: 1,
        originalLineCount: originalLines.length,
        modifiedStartLine: 1,
        modifiedLineCount: 0,
        hunkDiff: originalLines.map(line => `-${line}`).join('\n'),
        rawOriginal: baseContent,
        rawModified: ''
      });

      // Clear ownership, since the file is gone, but associate it with the delete patch
      this.lineOwnershipRepo.clearOwnershipForFile(filePath);

      console.log('[Stavreng] AI file deletion recorded for:', filePath);
      if (this.onFileMutated) {
        this.onFileMutated(filePath);
      }
    } catch (err) {
      console.error('[Stavreng] Failed to handle file delete:', err);
    }
  }

  /**
   * Gets the pre-change baseline content for a file.
   * Priority order:
   *  1. In-memory cache (content captured before this change)
   *  2. Git HEAD (if the file is tracked)
   *  3. Empty string (brand-new file)
   */
  private getBaselineContent(filePath: string): string {
    // ── 1. In-memory cache (most reliable for open documents) ──────────────
    const cached = this.contentCache.get(filePath);
    if (cached !== undefined) {
      console.log('[Stavreng] Using cached baseline for:', filePath);
      return cached;
    }

    // ── 2. Git HEAD ────────────────────────────────────────────────────────
    const relativePath = path.relative(this.workspacePath, filePath).replace(/\\/g, '/');
    try {
      const stdout = execSync(`git show HEAD:"${relativePath}"`, {
        cwd: this.workspacePath,
        stdio: ['pipe', 'pipe', 'ignore'],
        timeout: 5000
      });
      console.log('[Stavreng] Using git HEAD baseline for:', filePath);
      return stdout.toString('utf8');
    } catch {
      // Git unavailable or file not tracked
    }

    // ── 3. Empty string (new/untracked file, treat as added from scratch) ──
    console.log('[Stavreng] No baseline found, using empty string for:', filePath);
    return '';
  }
}
