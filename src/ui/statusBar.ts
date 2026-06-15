import * as vscode from 'vscode';
import { PatchesRepository } from '../db/patches.js';
import { SessionsRepository } from '../db/sessions.js';
import { normalizePath } from '../db/pathUtils.js';

export class StavrengStatusBarManager {
  private acceptItem: vscode.StatusBarItem;
  private rejectItem: vscode.StatusBarItem;
  private statusItem: vscode.StatusBarItem;
  private trackingToggleItem: vscode.StatusBarItem;
  private disposable: vscode.Disposable;
  private debounceTimer: NodeJS.Timeout | null = null;

  constructor(
    private sessionsRepo: SessionsRepository,
    private patchesRepo: PatchesRepository
  ) {
    // Create status bar items
    // Align them to the right, next to each other
    this.trackingToggleItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 103);
    this.statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 102);
    this.acceptItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 101);
    this.rejectItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);

    // Style items
    this.statusItem.text = '$(shield) Stavreng:';
    this.statusItem.tooltip = 'Stavreng is tracking edits in this file.';

    this.acceptItem.text = '$(check) Accept All';
    this.acceptItem.tooltip = 'Accept all pending AI changes in this file';
    this.acceptItem.color = new vscode.ThemeColor('statusBarItem.prominentForeground');
    
    this.rejectItem.text = '$(discard) Reject All';
    this.rejectItem.tooltip = 'Reject and rollback all pending AI changes in this file';
    this.rejectItem.color = new vscode.ThemeColor('errorForeground');

    // Wire listeners to update visibility
    const subscriptions: vscode.Disposable[] = [];
    vscode.window.onDidChangeActiveTextEditor(() => this.debouncedUpdateVisibility(), null, subscriptions);
    
    // We also want to refresh when text documents are saved/changed
    vscode.workspace.onDidSaveTextDocument(() => this.debouncedUpdateVisibility(), null, subscriptions);
    vscode.workspace.onDidChangeTextDocument(() => this.debouncedUpdateVisibility(), null, subscriptions);

    this.disposable = vscode.Disposable.from(...subscriptions);
  }

  private debouncedUpdateVisibility(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.updateVisibility();
    }, 250);
  }

  public updateVisibility(): void {
    const activeSession = this.sessionsRepo.getActiveSession();
    if (activeSession) {
      this.trackingToggleItem.text = `$(shield) Stavreng: Active`;
      this.trackingToggleItem.command = 'stavreng.stopSession';
      this.trackingToggleItem.tooltip = `Stavreng is tracking edits under session "${activeSession.agentName}". Click to stop.`;
    } else {
      this.trackingToggleItem.text = `$(shield) Stavreng: Idle`;
      this.trackingToggleItem.command = 'stavreng.startSession';
      this.trackingToggleItem.tooltip = 'Stavreng is currently inactive. Click to start a new tracking session.';
    }
    this.trackingToggleItem.show();

    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== 'file') {
      this.hideAll();
      return;
    }

    if (!activeSession) {
      this.hideAll();
      return;
    }

    const filePath = normalizePath(editor.document.uri.fsPath);
    const pendingPatches = this.patchesRepo
      .getByFileAndSession(filePath, activeSession.id)
      .filter(p => p.status === 'PENDING');

    if (pendingPatches.length > 0) {
      // Setup commands dynamically with the current file path
      this.acceptItem.command = {
        command: 'stavreng.acceptFileChanges',
        title: 'Accept All File Changes',
        arguments: [filePath]
      };
      this.rejectItem.command = {
        command: 'stavreng.rejectFileChanges',
        title: 'Reject All File Changes',
        arguments: [filePath]
      };

      this.statusItem.text = `$(shield) Stavreng: ${pendingPatches.length} Pending Hunk${pendingPatches.length > 1 ? 's' : ''}`;
      
      this.statusItem.show();
      this.acceptItem.show();
      this.rejectItem.show();
    } else {
      this.hideAll();
    }
  }

  private hideAll(): void {
    this.statusItem.hide();
    this.acceptItem.hide();
    this.rejectItem.hide();
  }

  public dispose(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.trackingToggleItem.dispose();
    this.statusItem.dispose();
    this.acceptItem.dispose();
    this.rejectItem.dispose();
    this.disposable.dispose();
  }
}
