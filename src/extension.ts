import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

// Import local repositories and engines
import { SafeDatabase } from './db/engine.js';
import { SessionsRepository } from './db/sessions.js';
import { FileStatesRepository } from './db/fileStates.js';
import { PatchesRepository } from './db/patches.js';
import { normalizePath } from './db/pathUtils.js';

import { JournalManager } from './engine/journal.js';
import { WorkspaceWatcher } from './engine/watcher.js';
import { SessionCoordinator } from './engine/coordinator.js';
import { BaseDocumentProvider } from './engine/provider.js';

import { StringEditTracker, HunkRollbackExecutor } from './vcs/index.js';

import { GutterDecorator } from './ui/decorations.js';
import { StavrengReviewWebview } from './ui/webview.js';
import { StavrengSidebarProvider } from './ui/sidebarWebview.js';
import { StavrengStatusBarManager } from './ui/statusBar.js';

export async function activate(context: vscode.ExtensionContext) {
  console.log('Stavreng extension: activate() called!');

  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    console.log('Stavreng extension: No workspace folders found.');
    vscode.window.showWarningMessage('Stavreng requires an open workspace folder to run.');
    return;
  }

  const workspacePath = workspaceFolders[0].uri.fsPath;
  console.log('Stavreng extension: Active workspace path is:', workspacePath);

  try {
    // Initialize Database
    const dbStoragePath = context.storageUri
      ? context.storageUri.fsPath
      : path.join(workspacePath, '.stavreng');

    if (!fs.existsSync(dbStoragePath)) {
      fs.mkdirSync(dbStoragePath, { recursive: true });
    }

    const db = new SafeDatabase(dbStoragePath);
    const sessionsRepo = new SessionsRepository(db);
    const fileStatesRepo = new FileStatesRepository(db);
    const patchesRepo = new PatchesRepository(db);

    // Initialize Engines & UI managers
    const journalManager = new JournalManager(dbStoragePath);
    // Initialize Webview Sidebar Provider
    const sidebarProvider = new StavrengSidebarProvider(
      workspacePath,
      context,
      sessionsRepo,
      patchesRepo
    );

    // StringEditTracker replaces HumanTracker + lineOwnershipRepo.
    // It tracks human keystrokes and accumulated AI edits per file using
    // the same StringEdit algebra VS Code uses internally.
    const stringEditTracker = new StringEditTracker();
    stringEditTracker.start();
    context.subscriptions.push({ dispose: () => stringEditTracker.stop() });

    const watcher = new WorkspaceWatcher(
      workspacePath,
      sessionsRepo,
      fileStatesRepo,
      patchesRepo,
      journalManager,
      sidebarProvider,
      stringEditTracker
    );

    const coordinator = new SessionCoordinator(sessionsRepo, watcher);
    const rollbackExecutor = new HunkRollbackExecutor(
      patchesRepo, journalManager, fileStatesRepo,
      (filePath) => watcher.suppressNextChangeFor(filePath)
    );

    const gutterDecorator = new GutterDecorator(patchesRepo);
    const statusBarManager = new StavrengStatusBarManager(sessionsRepo, patchesRepo);
    context.subscriptions.push(statusBarManager);

    // Register Custom Base Document Provider
    const baseDocumentProvider = new BaseDocumentProvider(journalManager);
    context.subscriptions.push(
      vscode.workspace.registerTextDocumentContentProvider('stavreng-base', baseDocumentProvider)
    );

    // Helper: register a command safely — if it already exists (hot-reload),
    // log a warning instead of crashing the entire activation.
    function safeRegister(id: string, handler: (...args: any[]) => any) {
      try {
        context.subscriptions.push(vscode.commands.registerCommand(id, handler));
      } catch (e: any) {
        console.warn(`[Stavreng] Command '${id}' already registered (hot-reload?): ${e.message}`);
      }
    }

    // Register Single Webview View Provider for Sidebar — do this FIRST so the
    // terminal always works even if some commands fail to register.
    try {
      context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
          StavrengSidebarProvider.viewType,
          sidebarProvider,
          {
            // Keep the webview alive while the sidebar is hidden.
            webviewOptions: { retainContextWhenHidden: true }
          }
        )
      );
    } catch (e: any) {
      console.warn(`[Stavreng] registerWebviewViewProvider failed: ${e.message}`);
    }
    // Ensure the PTY is killed and scrollback is flushed when the extension deactivates
    context.subscriptions.push(sidebarProvider);

    // Register Quick Launcher
    safeRegister('stavreng.launchAgent', async () => {
      const mode = await vscode.window.showQuickPick([
        { label: '$(cloud) Cloud Agent (Native)', description: 'Run a standard agent (agy, claude, opencode, codex)' },
        { label: '$(server) Local LLM Agent', description: 'Run via Ollama or LM Studio' }
      ], { placeHolder: 'Select Agent Mode' });

      if (!mode) return;

      let command = '';

      if (mode.label.includes('Cloud Agent')) {
        const agent = await vscode.window.showQuickPick(['agy', 'claude', 'opencode', 'codex'], { placeHolder: 'Select the agent to launch' });
        if (!agent) return;
        command = agent;
      } else {
        const provider = await vscode.window.showQuickPick(['Ollama', 'LM Studio'], { placeHolder: 'Select Local Provider' });
        if (!provider) return;

        const agent = await vscode.window.showQuickPick(['claude', 'opencode', 'codex'], { placeHolder: 'Select the agent (agy not supported for local)' });
        if (!agent) return;

        const model = await vscode.window.showInputBox({ placeHolder: 'Enter model name (e.g., minimax-m3:cloud)', prompt: 'Model Name' });
        if (!model) return;

        if (provider === 'Ollama') {
          if (agent === 'codex') {
            command = `codex --profile ollama-launch --model ${model}`;
          } else {
            command = `ollama launch ${agent} --model ${model}`;
          }
        } else {
          // LM Studio
          command = `$env:OPENAI_API_BASE="http://localhost:1234/v1"; ${agent}`;
        }
      }

      // Send to terminal
      vscode.commands.executeCommand('stavreng-sidebar.focus');
      setTimeout(() => {
        sidebarProvider.sendCommandToTerminal(command);
      }, 300);
    });

    // Register Conversation History Overlay
    safeRegister('stavreng.showHistory', async () => {
      const history = sidebarProvider.getConversationHistory();
      if (!history || history.length === 0) {
        vscode.window.showInformationMessage('No conversation history found.');
        return;
      }

      const quickPickItems: (vscode.QuickPickItem & { sessionId: string })[] = history.map(s => {
          const date = new Date(s.timestamp);
          return {
            label: `$(history) ${s.title.length > 50 ? s.title.substring(0, 50) + '...' : s.title}`,
            description: `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`,
            sessionId: s.id
          };
      });

      // Add clear history option
      quickPickItems.push({
        label: `$(trash) Clear All History`,
        description: 'Permanently delete all saved sessions',
        sessionId: 'CLEAR_ALL'
      });

      const selected = await vscode.window.showQuickPick(quickPickItems, { placeHolder: 'Select a past session to view its history' });
      if (selected) {
        if (selected.sessionId === 'CLEAR_ALL') {
          const confirm = await vscode.window.showWarningMessage('Are you sure you want to clear all history?', 'Yes', 'No');
          if (confirm === 'Yes') {
            sidebarProvider.clearConversationHistory();
            vscode.window.showInformationMessage('History cleared.');
          }
          return;
        }
        vscode.commands.executeCommand('stavreng-sidebar.focus');
        sidebarProvider.restoreConversation(selected.sessionId);
      }
    });

    // Automatically start tracking session when terminal CLI launches
    context.subscriptions.push(
      sidebarProvider.onDidLaunchAgentCli(async () => {
        const activeSession = coordinator.getActiveSession();
        if (!activeSession) {
          // No active session: Start a new tracking session immediately and silently
          const session = await coordinator.startSession('AI Agent', workspacePath);
          vscode.window.showInformationMessage(`Stavreng: Session started for ${session.agentName}`);
          
          sidebarProvider.refresh();
          if (vscode.window.activeTextEditor) {
            gutterDecorator.refresh(vscode.window.activeTextEditor);
          }
          statusBarManager.updateVisibility();
        }
      })
    );

    // Wire watcher → UI refresh
    watcher.onFileMutated = (mutatedFilePath: string) => {
      const editor = vscode.window.activeTextEditor;
      if (editor && normalizePath(editor.document.uri.fsPath) === normalizePath(mutatedFilePath)) {
        gutterDecorator.refresh(editor);
      }
      sidebarProvider.refresh();
      statusBarManager.updateVisibility();
    };

  // Review Webview Panel Manager
  const webviewReview = new StavrengReviewWebview(
    context,
    sessionsRepo,
    patchesRepo,
    async (patchIds) => {
      // Accept callback (from webview)
      for (const id of patchIds) {
        await rollbackExecutor.acceptPatch(id);
      }
      vscode.window.showInformationMessage('Changes successfully accepted.');
      gutterDecorator.refresh(vscode.window.activeTextEditor);
      sidebarProvider.refresh();
      statusBarManager.updateVisibility();
    },
    async (patchIds) => {
      // Reject callback
      for (const id of patchIds) {
        const res = await rollbackExecutor.rollbackHunk(id);
        if (!res.success) {
          vscode.window.showErrorMessage(`Rollback failed for one or more hunks: ${res.error}`);
        }
      }
      vscode.window.showInformationMessage('Changes successfully rolled back.');
      gutterDecorator.refresh(vscode.window.activeTextEditor);
      sidebarProvider.refresh();
      statusBarManager.updateVisibility();
    }
  );

  // Gutter Decoration event hooks
  vscode.window.onDidChangeActiveTextEditor(editor => {
    gutterDecorator.refresh(editor);
  }, null, context.subscriptions);

  vscode.workspace.onDidChangeTextDocument(event => {
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document === event.document) {
      gutterDecorator.refresh(editor);
    }
  }, null, context.subscriptions);

  // 1. Start Session command
  const startSessionCmd = vscode.commands.registerCommand('stavreng.startSession', async () => {
    const agentName = await vscode.window.showInputBox({
      prompt: 'Enter the AI Agent / tool name',
      placeHolder: 'e.g., Aider, Claude Dev, Cursor',
      value: 'AI Agent'
    });

    if (!agentName) return;

    await coordinator.startSession(agentName, workspacePath);
    sidebarProvider.setAgentRunning(true);
    vscode.window.showInformationMessage(`Stavreng is now tracking mutations from: ${agentName}`);
    sidebarProvider.refresh();
    gutterDecorator.refresh(vscode.window.activeTextEditor);
  });
  context.subscriptions.push(startSessionCmd);

  // 2. Stop Session command
  const stopSessionCmd = vscode.commands.registerCommand('stavreng.stopSession', async (force?: boolean) => {
    if (!force && sidebarProvider.isAgentRunning()) {
      vscode.window.showWarningMessage('An agent is currently running. Please exit the agent before stopping the tracking session.');
      return;
    }

    const activeSession = sessionsRepo.getActiveSession();

    coordinator.stopSession();
    sidebarProvider.resetAgentState();
    vscode.window.showInformationMessage('Stavreng session stopped.');
    
    if (activeSession) {
      const patches = patchesRepo.getBySession(activeSession.id);
      if (patches.length === 0) {
        // Auto-delete the session if it captured no file changes
        await vscode.commands.executeCommand('stavreng.deleteSession', activeSession.id, true);
      }
    }

    sidebarProvider.refresh();
    gutterDecorator.refresh(vscode.window.activeTextEditor);
  });
  context.subscriptions.push(stopSessionCmd);

  // 3. Review Hunk Diff command (Legacy side-by-side)
  const reviewHunkDiffCmd = vscode.commands.registerCommand('stavreng.reviewHunkDiff', (patchId: string) => {
    const patch = patchesRepo.getById(patchId);
    if (!patch) return;

    const fileState = fileStatesRepo.getByFileAndSession(patch.filePath, patch.sessionId);
    if (fileState) {
      const fileName = path.basename(patch.filePath);
      const baseUri = vscode.Uri.parse(`stavreng-base://authority${patch.filePath}?${fileState.baseSha256}`);
      const liveUri = vscode.Uri.file(patch.filePath);
      
      vscode.commands.executeCommand(
        'vscode.diff',
        baseUri,
        liveUri,
        `Stavreng: ${fileName} ⟷ Baseline`
      );
    }
  });
  context.subscriptions.push(reviewHunkDiffCmd);

  // 12. Open Custom Review Tab command
  const openCustomReviewTabCmd = vscode.commands.registerCommand('stavreng.openCustomReviewTab', (item: any) => {
    let filePath: string | undefined;
    let sessionId: string | undefined;

    if (typeof item === 'string') {
      filePath = item;
    } else if (item && typeof item === 'object') {
      filePath = item.filePath;
      sessionId = item.sessionId;
    } else {
      filePath = vscode.window.activeTextEditor?.document.uri.fsPath;
      sessionId = sessionsRepo.getActiveSession()?.id;
    }

    if (!filePath) return;
    filePath = normalizePath(filePath);

    let filePatches = patchesRepo.getPatches()
      .filter(p => normalizePath(p.filePath) === filePath);

    if (sessionId) {
      filePatches = filePatches.filter(p => p.sessionId === sessionId);
    } else {
      const activeSessionId = sessionsRepo.getActiveSession()?.id;
      const pendingForFile = filePatches.filter(p => p.status === 'PENDING');
      const targetSessionId = pendingForFile.find(p => p.sessionId === activeSessionId)?.sessionId 
        ?? pendingForFile[0]?.sessionId 
        ?? filePatches.find(p => p.sessionId === activeSessionId)?.sessionId 
        ?? filePatches[0]?.sessionId;
      if (targetSessionId) {
        filePatches = filePatches.filter(p => p.sessionId === targetSessionId);
      }
    }

    if (filePatches.length === 0) {
      vscode.window.showInformationMessage('No changes found to review for this file.');
      return;
    }

    const pendingPatches = filePatches.filter(p => p.status === 'PENDING');
    if (pendingPatches.length > 0) {
      webviewReview.show(pendingPatches, false);
    } else {
      webviewReview.show(filePatches, true);
    }
  });
  context.subscriptions.push(openCustomReviewTabCmd);

  // 4. Accept Hunk command (from CodeLens / hover links)
  const acceptHunkCmd = vscode.commands.registerCommand('stavreng.acceptHunk', async (patchId: string) => {
    await rollbackExecutor.acceptPatch(patchId);
    vscode.window.showInformationMessage('Hunk changes accepted.');
    gutterDecorator.refresh(vscode.window.activeTextEditor);
    sidebarProvider.refresh();
    webviewReview.refreshIfOpen();
  });
  context.subscriptions.push(acceptHunkCmd);

  // 5. Reject Hunk command
  const rejectHunkCmd = vscode.commands.registerCommand('stavreng.rejectHunk', async (patchId: string) => {
    const res = await rollbackExecutor.rollbackHunk(patchId);
    if (res.success) {
      vscode.window.showInformationMessage('Hunk successfully rolled back.');
    } else {
      vscode.window.showErrorMessage(`Rollback failed: ${res.error}`);
    }
    gutterDecorator.refresh(vscode.window.activeTextEditor);
    sidebarProvider.refresh();
    webviewReview.refreshIfOpen();
  });
  context.subscriptions.push(rejectHunkCmd);

  // 6. Show Timeline command
  const showTimelineCmd = vscode.commands.registerCommand('stavreng.showTimeline', () => {
    vscode.commands.executeCommand('workbench.view.extension.stavreng-explorer');
  });
  context.subscriptions.push(showTimelineCmd);

  // 7. Review File Diff command (no split screen)
  const reviewFileDiffCmd = vscode.commands.registerCommand('stavreng.reviewFileDiff', (item: any) => {
    let filePath: string | undefined;
    let sessionId: string | undefined;

    if (typeof item === 'string') {
      filePath = item;
    } else if (item && typeof item === 'object') {
      filePath = item.filePath;
      sessionId = item.sessionId;
    } else {
      filePath = vscode.window.activeTextEditor?.document.uri.fsPath;
      sessionId = sessionsRepo.getActiveSession()?.id;
    }

    if (!filePath) return;
    filePath = normalizePath(filePath);

    if (!sessionId) {
      const pendingPatch = patchesRepo.getPatches().find(
        p => normalizePath(p.filePath) === filePath && p.status === 'PENDING'
      );
      sessionId = pendingPatch?.sessionId ?? sessionsRepo.getActiveSession()?.id;
    }

    if (sessionId) {
      const fileState = fileStatesRepo.getByFileAndSession(filePath, sessionId);
      if (fileState) {
        const fileName = path.basename(filePath);
        const baseUri = vscode.Uri.parse(`stavreng-base://authority${filePath}?${fileState.baseSha256}`);
        const liveUri = vscode.Uri.file(filePath);
        vscode.commands.executeCommand(
          'vscode.diff',
          baseUri,
          liveUri,
          `Stavreng: ${fileName} ⟷ Baseline`,
          { preview: true }
        );
        return;
      }
    }
    
    vscode.window.showWarningMessage('No baseline file state found for diff review.');
  });
  context.subscriptions.push(reviewFileDiffCmd);

  // 8. Accept File Changes command
  const acceptFileChangesCmd = vscode.commands.registerCommand('stavreng.acceptFileChanges', async (item: any) => {
    let filePath: string | undefined;
    let sessionId: string | undefined;

    if (typeof item === 'string') {
      filePath = item;
    } else if (item && typeof item === 'object') {
      filePath = item.filePath;
      sessionId = item.sessionId;
    } else {
      filePath = vscode.window.activeTextEditor?.document.uri.fsPath;
      sessionId = sessionsRepo.getActiveSession()?.id;
    }

    if (!filePath) return;
    filePath = normalizePath(filePath);

    let pendingPatches = patchesRepo.getPatches()
      .filter(p => normalizePath(p.filePath) === filePath && p.status === 'PENDING');

    if (sessionId) {
      pendingPatches = pendingPatches.filter(p => p.sessionId === sessionId);
    }

    if (pendingPatches.length === 0) return;

    for (const patch of pendingPatches) {
      await rollbackExecutor.acceptPatch(patch.id);
    }

    vscode.window.showInformationMessage(`Accepted all changes in ${path.basename(filePath)}.`);

    // Refresh UI
    gutterDecorator.refresh(vscode.window.activeTextEditor);
    sidebarProvider.refresh();
    statusBarManager.updateVisibility();
    webviewReview.refreshIfOpen();
  });
  context.subscriptions.push(acceptFileChangesCmd);

  // 9. Reject File Changes command
  const rejectFileChangesCmd = vscode.commands.registerCommand('stavreng.rejectFileChanges', async (item: any) => {
    let filePath: string | undefined;
    let sessionId: string | undefined;

    if (typeof item === 'string') {
      filePath = item;
    } else if (item && typeof item === 'object') {
      filePath = item.filePath;
      sessionId = item.sessionId;
    } else {
      filePath = vscode.window.activeTextEditor?.document.uri.fsPath;
      sessionId = sessionsRepo.getActiveSession()?.id;
    }

    if (!filePath) return;
    filePath = normalizePath(filePath);

    let pendingPatches = patchesRepo.getPatches()
      .filter(p => normalizePath(p.filePath) === filePath && p.status === 'PENDING');

    if (sessionId) {
      pendingPatches = pendingPatches.filter(p => p.sessionId === sessionId);
    }

    if (pendingPatches.length === 0) return;

    // Sort descending by line number to prevent offset corruption
    pendingPatches.sort((a, b) => b.modifiedStartLine - a.modifiedStartLine);

    for (const patch of pendingPatches) {
      const res = await rollbackExecutor.rollbackHunk(patch.id);
      if (!res.success) {
        vscode.window.showErrorMessage(`Failed to reject change in ${path.basename(filePath)}: ${res.error}`);
        break;
      }
    }

    vscode.window.showInformationMessage(`Rejected and reverted all changes in ${path.basename(filePath)}.`);

    // Refresh UI
    gutterDecorator.refresh(vscode.window.activeTextEditor);
    sidebarProvider.refresh();
    statusBarManager.updateVisibility();
    webviewReview.refreshIfOpen();
  });
  context.subscriptions.push(rejectFileChangesCmd);

  // 10. Accept All Session Changes command
  const acceptAllSessionCmd = vscode.commands.registerCommand('stavreng.acceptAllSession', async (item: any) => {
    let sessionId: string | undefined;

    if (typeof item === 'string') {
      sessionId = item;
    } else if (item && typeof item === 'object') {
      sessionId = item.sessionId;
    } else {
      sessionId = sessionsRepo.getActiveSession()?.id;
    }

    if (!sessionId) {
      vscode.window.showWarningMessage('No active session to accept changes for.');
      return;
    }

    const pendingPatches = patchesRepo.getBySession(sessionId)
      .filter(p => p.status === 'PENDING');

    if (pendingPatches.length === 0) return;

    for (const patch of pendingPatches) {
      await rollbackExecutor.acceptPatch(patch.id);
    }

    vscode.window.showInformationMessage(`Accepted all changes for the session.`);

    // Refresh UI
    gutterDecorator.refresh(vscode.window.activeTextEditor);
    sidebarProvider.refresh();
    statusBarManager.updateVisibility();
    webviewReview.refreshIfOpen();
  });
  context.subscriptions.push(acceptAllSessionCmd);

  // 11. Reject All Session Changes command
  const rejectAllSessionCmd = vscode.commands.registerCommand('stavreng.rejectAllSession', async (item: any) => {
    let sessionId: string | undefined;

    if (typeof item === 'string') {
      sessionId = item;
    } else if (item && typeof item === 'object') {
      sessionId = item.sessionId;
    } else {
      sessionId = sessionsRepo.getActiveSession()?.id;
    }

    if (!sessionId) {
      vscode.window.showWarningMessage('No active session to reject changes for.');
      return;
    }

    const pendingPatches = patchesRepo.getBySession(sessionId)
      .filter(p => p.status === 'PENDING');

    if (pendingPatches.length === 0) return;

    // Group by file path
    const patchesByFile: { [path: string]: typeof pendingPatches } = {};
    for (const patch of pendingPatches) {
      if (!patchesByFile[patch.filePath]) {
        patchesByFile[patch.filePath] = [];
      }
      patchesByFile[patch.filePath].push(patch);
    }

    // Revert per file, sorting descending
    for (const filePath of Object.keys(patchesByFile)) {
      const filePatches = patchesByFile[filePath];
      filePatches.sort((a, b) => b.modifiedStartLine - a.modifiedStartLine);
      for (const patch of filePatches) {
        const res = await rollbackExecutor.rollbackHunk(patch.id);
        if (!res.success) {
          vscode.window.showErrorMessage(`Failed to reject change in ${path.basename(filePath)}: ${res.error}`);
          break;
        }
      }
    }

    vscode.window.showInformationMessage(`Rejected and reverted all changes for the session.`);

    // Refresh UI
    gutterDecorator.refresh(vscode.window.activeTextEditor);
    sidebarProvider.refresh();
    statusBarManager.updateVisibility();
    webviewReview.refreshIfOpen();
  });
  context.subscriptions.push(rejectAllSessionCmd);

  // 13. Delete Session command
  const deleteSessionCmd = vscode.commands.registerCommand('stavreng.deleteSession', async (item: any, forceSilent?: boolean) => {
    let sessionId: string | undefined;

    if (typeof item === 'string') {
      sessionId = item;
    } else if (item && typeof item === 'object') {
      sessionId = item.sessionId;
    } else {
      sessionId = sessionsRepo.getActiveSession()?.id;
    }

    if (!sessionId) {
      if (!forceSilent) vscode.window.showWarningMessage('No session selected to delete.');
      return;
    }

    const session = sessionsRepo.getById(sessionId);
    if (!session) {
      if (!forceSilent) vscode.window.showWarningMessage('Session not found.');
      return;
    }

    const pendingPatches = patchesRepo.getBySession(sessionId)
      .filter(p => p.status === 'PENDING');

    if (pendingPatches.length > 0) {
      if (!forceSilent) {
        // Forceful completion warning
        const selection = await vscode.window.showWarningMessage(
          `The session "${session.agentName}" has pending changes. Deleting it will forcefully complete it and permanently save these changes on disk. Do you want to proceed?`,
          'Force Complete & Delete', 'Cancel'
        );

        if (selection !== 'Force Complete & Delete') {
          return;
        }
      }

      // Force complete: accept all pending patches
      for (const patch of pendingPatches) {
        await rollbackExecutor.acceptPatch(patch.id);
      }
    } else {
      if (!forceSilent) {
        // Simple confirmation
        const selection = await vscode.window.showWarningMessage(
          `Are you sure you want to delete the session "${session.agentName}" and all its history?`,
          'Delete', 'Cancel'
        );

        if (selection !== 'Delete') {
          return;
        }
      }
    }

    // Perform cleanup:
    const activeSession = sessionsRepo.getActiveSession();
    const isDeletingActive = activeSession && activeSession.id === sessionId;

    // 1. Delete session from repository
    sessionsRepo.delete(sessionId);

    if (isDeletingActive) {
      sidebarProvider.resetAgentState();
    }

    // 2. Delete patches of this session
    patchesRepo.deleteBySession(sessionId);

    // 3. Delete file states of this session
    fileStatesRepo.deleteBySession(sessionId);

    // Line ownership is no longer tracked — nothing else to clean up here.

    if (!forceSilent) {
      vscode.window.showInformationMessage(`Session "${session.agentName}" was successfully deleted.`);
    }

    // Refresh all UI elements
    sidebarProvider.refresh();
    if (vscode.window.activeTextEditor) {
      gutterDecorator.refresh(vscode.window.activeTextEditor);
    }
    statusBarManager.updateVisibility();
    webviewReview.refreshIfOpen();
  });
  context.subscriptions.push(deleteSessionCmd);

  // Initial decoration & status bar scan
  if (vscode.window.activeTextEditor) {
    gutterDecorator.refresh(vscode.window.activeTextEditor);
    statusBarManager.updateVisibility();
  }

  // Resume coordinator if there was an active session before restart
  coordinator.getActiveSession();

  // ── Snapshot workspace & reveal terminal ─────────────────────────────
  // This runs AFTER all commands are registered so the terminal is available
  // but still BEFORE the user can interact with it (the spinner is shown).
  // Once snapshotWorkspace resolves, every file has a baseline and we can
  // safely let agents make edits without any race conditions.
  watcher.snapshotWorkspace().then(() => {
    sidebarProvider.setExtensionReady();
    console.log('[Stavreng] Workspace indexed. Terminal is now ready.');
  }).catch(err => {
    console.error('[Stavreng] Snapshot failed, revealing terminal anyway:', err);
    sidebarProvider.setExtensionReady();
  });

  } catch (err) {
    console.error('Stavreng extension activation failed:', err);
  }
}

export function deactivate() {
  // Graceful cleanup if needed
}
