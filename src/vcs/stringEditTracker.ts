/**
 * StringEditTracker — tracks suppressed paths (for rollback/accept programmatic writes)
 * and detects human-initiated saves using vscode.workspace.onWillSaveTextDocument.
 */

import * as vscode from 'vscode';
import { normalizePath } from '../db/pathUtils.js';

interface FileEditState {
  /** True when onWillSaveTextDocument fired — indicates this is a human save. */
  isHumanSavePending: boolean;
}

export class StringEditTracker {
  private readonly _fileStates = new Map<string, FileEditState>();

  /** Paths whose next FSW event should be ignored (rollback/accept writes). */
  private readonly _suppressedPaths = new Set<string>();

  private _disposable: vscode.Disposable | null = null;

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  public start(): void {
    if (this._disposable) return;

    const subs: vscode.Disposable[] = [];

    // Track saves initiated from within VS Code (human Ctrl+S or auto-save).
    // This event CANNOT be triggered by external tools — it is 100% VS Code internal.
    subs.push(
      vscode.workspace.onWillSaveTextDocument(event => {
        if (event.document.uri.scheme !== 'file') return;
        const filePath = normalizePath(event.document.uri.fsPath);
        // Don't treat rollback/accept writes as human saves.
        if (!this._suppressedPaths.has(filePath)) {
          this._getOrCreate(filePath).isHumanSavePending = true;
        }
      })
    );

    this._disposable = vscode.Disposable.from(...subs);
  }

  public stop(): void {
    this._disposable?.dispose();
    this._disposable = null;
  }

  // ─── Suppress (rollback / accept writes) ─────────────────────────────────

  /**
   * Call BEFORE writing a file from rollback or accept.
   * Both the onWillSaveTextDocument event AND the FSW event will be swallowed.
   */
  public suppressNextChangeFor(filePath: string): void {
    this._suppressedPaths.add(normalizePath(filePath));
  }

  /**
   * Expose the current suppressed paths so the watcher can check them.
   * The watcher's handleFileChange should call this before processing.
   */
  public isSuppressed(filePath: string): boolean {
    return this._suppressedPaths.has(normalizePath(filePath));
  }

  /**
   * Consume the suppression for a path. Call once the FSW event is handled.
   */
  public consumeSuppression(filePath: string): boolean {
    return this._suppressedPaths.delete(normalizePath(filePath));
  }

  // ─── Human save detection ─────────────────────────────────────────────────

  /**
   * Called by the watcher when processing an FSW event.
   * Returns true and clears the flag if this was a human-initiated save.
   */
  public consumeHumanSave(filePath: string): boolean {
    const normPath = normalizePath(filePath);
    const state = this._fileStates.get(normPath);
    if (!state?.isHumanSavePending) return false;
    state.isHumanSavePending = false;
    return true;
  }

  // ─── State updates ────────────────────────────────────────────────────────



  /**
   * Called after human save is complete — resets edit state for the file.
   */
  public onHumanSavedFile(filePath: string): void {
    const normPath = normalizePath(filePath);
    const state = this._fileStates.get(normPath);
    if (!state) return;
    state.isHumanSavePending = false;
  }

  /**
   * Reset all state for a file (e.g. after Accept All or Reject All).
   */
  public clearFile(filePath: string): void {
    this._fileStates.delete(normalizePath(filePath));
  }

  /**
   * Reset all state (e.g. on session stop).
   */
  public clearAll(): void {
    this._fileStates.clear();
    this._suppressedPaths.clear();
  }

  // ─── Internal ─────────────────────────────────────────────────────────────

  private _getOrCreate(filePath: string): FileEditState {
    let state = this._fileStates.get(filePath);
    if (!state) {
      state = {
        isHumanSavePending: false,
      };
      this._fileStates.set(filePath, state);
    }
    return state;
  }
}
