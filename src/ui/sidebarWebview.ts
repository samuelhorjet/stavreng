import * as vscode from 'vscode';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';
import { SessionsRepository } from '../db/sessions.js';
import { PatchesRepository } from '../db/patches.js';

export class StavrengSidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'stavreng-sidebar';

  private view?: vscode.WebviewView;
  private ptyProcess?: ChildProcess;
  private ptyDataListener?: { dispose: () => void };
  private ptyExitListener?: { dispose: () => void };
  private isAgentActive = false;
  private isInAgentCli = false;
  private idleTimer?: NodeJS.Timeout;
  private lineBuffer = '';

  /** Scrollback buffer: stores all raw PTY output so we can replay it when
   *  the webview is torn down (sidebar hidden) and recreated (sidebar shown). */
  private terminalScrollback = '';
  private static readonly MAX_SCROLLBACK = 400_000; // ~400 KB, ~3000 lines

  // Conversation History (1 record = 1 terminal lifecycle)
  private conversationHistory: { id: string, title: string, timestamp: number, scrollback: string }[] = [];
  private currentHistoryTitle = '';
  private currentHistoryBuffer = '';
  private scrollbackSaveTimer?: NodeJS.Timeout;

  private lastCols = 80;
  private lastRows = 24;
  private lastInputTime = 0;
  private lastResizeTime = 0;   // suppress running-state from resize redraws
  private lastMouseEventTime = 0; // suppress running-state from mouse-scroll redraws

  private _onDidChangeAgentStatus = new vscode.EventEmitter<boolean>();
  public readonly onDidChangeAgentStatus = this._onDidChangeAgentStatus.event;

  private _onDidLaunchAgentCli = new vscode.EventEmitter<void>();
  public readonly onDidLaunchAgentCli = this._onDidLaunchAgentCli.event;

  constructor(
    private readonly workspacePath: string,
    private readonly context: vscode.ExtensionContext,
    private readonly sessionsRepo: SessionsRepository,
    private readonly patchesRepo: PatchesRepository
  ) {
    this.terminalScrollback = this.context.workspaceState.get<string>('stavreng.terminalScrollback', '');
    this.conversationHistory = this.context.workspaceState.get<any[]>('stavreng.conversationHistory', []);
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  public isAgentRunning(): boolean {
    return this.isInAgentCli || this.isAgentActive;
  }

  public dispose() {
    // Flush any pending scrollback save
    if (this.scrollbackSaveTimer) {
      clearTimeout(this.scrollbackSaveTimer);
      this.context.workspaceState.update('stavreng.terminalScrollback', this.terminalScrollback);
    }
    this.destroyPty();
  }

  public setAgentRunning(active: boolean) {
    if (this.isAgentActive !== active) {
      this.isAgentActive = active;
      if (!active && this.idleTimer) {
        clearTimeout(this.idleTimer);
        this.idleTimer = undefined;
      }
      this._onDidChangeAgentStatus.fire(active);
      this.refresh();
      if (this.view) {
        this.view.webview.postMessage({ command: 'status', active: this.isAgentActive, inCli: this.isInAgentCli });
      }
      if (active && !this.isInAgentCli) {
        this.setInAgentCli(true);
      }
    }
  }

  public resetAgentState() {
    this.isAgentActive = false;
    this.isInAgentCli = false;
    this.lineBuffer = '';
    this.lastInputTime = 0; // CRITICAL: Reset input time to prevent shell startup signals from triggering agent detection
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
    this._onDidChangeAgentStatus.fire(false);
    this.refresh();
    if (this.view) {
      this.view.webview.postMessage({ command: 'status', active: false, inCli: false });
    }
  }

  private hasCapturedAgentPrompt = false;

  public sendCommandToTerminal(command: string) {
    // The ptyProcess is the bridge subprocess which only speaks JSON.
    // Use sendBridgeMessage to wrap the text as a 'write' action.
    this.lastInputTime = Date.now(); // Treat as user typing to enable agent detection
    if (!this.isInAgentCli && (!this.currentHistoryTitle || this.currentHistoryTitle === 'AI Session')) {
      this.currentHistoryTitle = command.trim();
    }
    this.sendBridgeMessage({ action: 'write', data: command + '\r' });
  }

  public refresh(): void {
    if (this.view) {
      this.sendStateMessage();
    }
  }

  private setInAgentCli(inCli: boolean) {
    if (this.isInAgentCli !== inCli) {
      this.isInAgentCli = inCli;
      if (inCli) {
        this._onDidLaunchAgentCli.fire();
        // We do NOT reset currentHistoryTitle here, because it's captured in handleInput just before this.
      } else {
        // Agent exited. We only pause recording, we do NOT save to history yet.
        // History is saved when the terminal lifecycle ends (user clicks New Terminal).
      }
      if (this.view) {
        this.view.webview.postMessage({ command: 'status', active: this.isAgentActive, inCli: this.isInAgentCli });
      }
    }
  }

  private saveCurrentSessionToHistory() {
    if (!this.currentHistoryBuffer.trim()) return;
    const title = this.currentHistoryTitle || 'AI Session';
    this.conversationHistory.unshift({
      id: Date.now().toString(),
      title,
      timestamp: Date.now(),
      scrollback: this.currentHistoryBuffer
    });
    // Keep only last 50 sessions to save space
    if (this.conversationHistory.length > 50) {
      this.conversationHistory = this.conversationHistory.slice(0, 50);
    }
    this.context.workspaceState.update('stavreng.conversationHistory', this.conversationHistory);
  }

  public getConversationHistory() {
    return this.conversationHistory;
  }

  public clearConversationHistory() {
    this.conversationHistory = [];
    this.context.workspaceState.update('stavreng.conversationHistory', []);
  }

  public restoreConversation(id: string) {
    const session = this.conversationHistory.find(s => s.id === id);
    if (session) {
      // Do NOT overwrite this.terminalScrollback. We want to keep the active session intact.
      if (this.view) {
        this.view.webview.postMessage({ 
          command: 'show-history-view', 
          data: session.scrollback,
          title: session.title
        });
      }
    }
  }

  // ─── Shell Detection ──────────────────────────────────────────────────────

  private getShellConfig(): { shell: string; args: string[] } {
    if (os.platform() === 'win32') {
      const shell = this.findExecutableOnPath(['pwsh.exe', 'powershell.exe']);
      return { shell, args: [] };
    } else if (os.platform() === 'darwin') {
      const userShell = process.env.SHELL;
      if (userShell && this.executableExists(userShell)) { return { shell: userShell, args: [] }; }
      return { shell: '/bin/zsh', args: [] };
    } else {
      const userShell = process.env.SHELL;
      if (userShell && this.executableExists(userShell)) { return { shell: userShell, args: [] }; }
      return { shell: this.findExecutableOnPath(['bash', 'sh']), args: [] };
    }
  }

  private findExecutableOnPath(names: string[]): string {
    const dirs = (process.env.PATH ?? '').split(path.delimiter);
    for (const name of names) {
      if (path.isAbsolute(name) && this.executableExists(name)) {
        return name;
      }
      for (const dir of dirs) {
        if (!dir) { continue; }
        const full = path.join(dir, name);
        if (this.executableExists(full)) {
          return full;
        }
      }
    }
    return names[names.length - 1];
  }

  private executableExists(filePath: string): boolean {
    try {
      return fs.statSync(filePath).isFile();
    } catch {
      return false;
    }
  }

  // ─── PTY Lifecycle ────────────────────────────────────────────────────────

  private startPty(cols?: number, rows?: number) {
    if (cols) this.lastCols = cols;
    if (rows) this.lastRows = rows;

    this.destroyPty();

    const bridgePath = path.join(__dirname, 'ptyBridge.js');
    const { shell, args } = this.getShellConfig();

    try {
      this.ptyProcess = spawn('node', [bridgePath], {
        cwd: this.workspacePath,
        env: process.env,
        shell: false
      });

      let buffer = '';
      const onData = (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        let lineEndIndex;
        while ((lineEndIndex = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, lineEndIndex).trim();
          buffer = buffer.slice(lineEndIndex + 1);
          if (line) {
            this.handleBridgeMessage(line);
          }
        }
      };

      this.ptyProcess.stdout!.on('data', onData);
      
      this.ptyDataListener = {
        dispose: () => {
          if (this.ptyProcess && this.ptyProcess.stdout) {
            this.ptyProcess.stdout.off('data', onData);
          }
        }
      };

      this.ptyProcess.stderr!.on('data', (chunk: Buffer) => {
        console.error('[Stavreng PTY Bridge Stderr]:', chunk.toString('utf8'));
      });

      const onExit = (code: number | null) => {
        this.handlePtyOutput(`\r\n[Stavreng] PTY Bridge exited (code ${code}). Restarting...\r\n`);
        setTimeout(() => this.startPty(this.lastCols, this.lastRows), 1000);
      };
      this.ptyProcess.on('exit', onExit);

      this.ptyExitListener = {
        dispose: () => {
          if (this.ptyProcess) {
            this.ptyProcess.off('exit', onExit);
          }
        }
      };

      // Send spawn command to bridge
      this.sendBridgeMessage({
        action: 'spawn',
        shell,
        args,
        cols: this.lastCols,
        rows: this.lastRows,
        cwd: this.workspacePath
      });

    } catch (err: any) {
      const msg = `\r\n[Stavreng] Failed to start PTY Bridge: ${err.message}\r\n`;
      this.handlePtyOutput(msg);
      console.error('[Stavreng Terminal]', err);
    }
  }

  private destroyPty() {
    this.ptyDataListener?.dispose();
    this.ptyExitListener?.dispose();
    this.ptyDataListener = undefined;
    this.ptyExitListener = undefined;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
    if (this.ptyProcess) {
      try {
        this.sendBridgeMessage({ action: 'kill' });
        this.ptyProcess.kill();
      } catch {}
      this.ptyProcess = undefined;
    }
  }

  private handleBridgeMessage(line: string) {
    try {
      const msg = JSON.parse(line);
      switch (msg.event) {
        case 'spawned':
          console.log(`[Stavreng Terminal] PTY spawned with PID ${msg.pid}`);
          break;
        case 'output':
          this.handlePtyOutput(msg.data);
          break;
        case 'exit':
          this.handlePtyOutput(`\r\n[Stavreng] Shell process exited (code ${msg.code}, signal ${msg.signal}). Starting a new session...\r\n`);
          setTimeout(() => this.startPty(this.lastCols, this.lastRows), 1000);
          break;
        case 'error':
          this.handlePtyOutput(`\r\n[Stavreng Terminal Error] ${msg.message}\r\n`);
          console.error('[Stavreng Terminal Bridge Error]:', msg.message);
          break;
      }
    } catch (err: any) {
      console.error(`[Stavreng Terminal] Error parsing bridge message: ${err.message}. Line: ${line}`);
    }
  }

  private sendBridgeMessage(msg: any) {
    if (this.ptyProcess && this.ptyProcess.stdin && this.ptyProcess.stdin.writable) {
      this.ptyProcess.stdin.write(JSON.stringify(msg) + '\n');
    }
  }

  private isAgentPrompt(clean: string): boolean {
    const trimmed = clean.trim();
    if (!trimmed) return false;

    if (/>\s*$/.test(trimmed) || /\?\s*$/.test(trimmed)) {
      return true;
    }
    if (/\[[yYnN]\/[yYnN]\]\s*$/.test(trimmed) || /\([yYnN]\/[yYnN]\)\s*$/.test(trimmed)) {
      return true;
    }
    if (trimmed.includes('? for shortcuts') || trimmed.includes('to switch') || trimmed.includes('to leave')) {
      return true;
    }
    return false;
  }

  private handlePtyOutput(data: string) {
    // Accumulate scrollback so we can replay it when the webview re-opens
    this.terminalScrollback += data;
    if (this.terminalScrollback.length > StavrengSidebarProvider.MAX_SCROLLBACK) {
      // Drop oldest 20% to avoid constant trimming while keeping recent history
      this.terminalScrollback = this.terminalScrollback.slice(
        Math.floor(StavrengSidebarProvider.MAX_SCROLLBACK * 0.2)
      );
    }
    
    // Persist to disk using a debounce to prevent freezing the extension host
    if (this.scrollbackSaveTimer) {
      clearTimeout(this.scrollbackSaveTimer);
    }
    this.scrollbackSaveTimer = setTimeout(() => {
      this.context.workspaceState.update('stavreng.terminalScrollback', this.terminalScrollback);
    }, 1000);

    if (this.view) {
      this.view.webview.postMessage({ command: 'output', data });
    }

    // ── Layer 1: Alternate Screen Buffer ──────────────────────────────────
    // Full-screen TUI agents (Claude Code, Open Code) enter the alternate
    // screen buffer. curl, npm, git, pnpm, etc. never do.
    // Guard: only trigger after the user has typed something (lastInputTime > 0)
    // to avoid false-positives from the shell itself on startup.
    const userHasTyped = this.lastInputTime > 0;
    if (userHasTyped) {
      if (data.includes('\x1b[?1049h') || data.includes('\x1b[?47h')) {
        this.setInAgentCli(true);
        this.setAgentRunning(true);
      }
    }
    if (data.includes('\x1b[?1049l') || data.includes('\x1b[?47l')) {
      this.setInAgentCli(false);
      this.setAgentRunning(false);
      if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = undefined; }
      return;
    }

    // ── Layer 2: Interactive TUI Stdin Takeover signals ────────────────────
    // Inline TUI agents (agy/Antigravity CLI, Codex/React Ink, Aider, etc.)
    // don't use the alternate screen — instead they signal stdin takeover via
    // one or more of these sequences. curl, npm, git, pnpm NEVER emit these.
    //
    // IMPORTANT: PowerShell itself emits \x1b[?9001h and \x1b[?1004h on startup.
    // We must NOT trigger agent detection from these shell-startup signals.
    // Solution: only honour enter-signals AFTER the user has typed something.
    //
    // Detection priority (earliest-fired first for agy):
    //   \x1b[?9001h  Win32 extended input mode  ← agy emits this FIRST (but so does PSReadLine!)
    //   \x1b[?1004h  Focus-in/out event tracking ← agy emits this second (also PSReadLine)
    //   \x1b[?2004h  Bracketed paste mode        ← Codex, aider, most others
    //
    // Exit signals (any one of these means the agent exited):
    //   \x1b[?9001l / \x1b[?1004l / \x1b[?2004l
    const enterSignals = ['\x1b[?9001h', '\x1b[?1004h', '\x1b[?2004h'];
    const exitSignals  = ['\x1b[?9001l', '\x1b[?1004l', '\x1b[?2004l'];

    if (userHasTyped && enterSignals.some(s => data.includes(s))) {
      this.setInAgentCli(true);
      this.setAgentRunning(true);
      this.hasCapturedAgentPrompt = false; // Reset prompt capture flag for new agent
    }
    if (exitSignals.some(s => data.includes(s)) && this.isInAgentCli) {
      this.setInAgentCli(false);
      this.setAgentRunning(false);
      if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = undefined; }
      return;
    }


    // Record into history buffer ONLY if an agent is active
    if (this.isInAgentCli) {
      this.currentHistoryBuffer += data;
    }

    const clean = data
      .replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '')
      .trimEnd();

    if (!clean) return;

    // Fallback: if we returned to system shell prompt, ensure state resets
    if (this.isSystemShellPrompt(clean)) {
      this.setInAgentCli(false);
      this.setAgentRunning(false);
      if (this.idleTimer) {
        clearTimeout(this.idleTimer);
        this.idleTimer = undefined;
      }
      return;
    }

    // If we are currently inside an active agent CLI session, manage the
    // idle/running state based on output activity
    if (this.isInAgentCli) {
      const isEcho        = (Date.now() - this.lastInputTime      < 150)  && (clean.length < 8);
      const isResizeDraw  = (Date.now() - this.lastResizeTime     < 1000);
      const isMouseDraw   = (Date.now() - this.lastMouseEventTime < 800);

      if (!this.isAgentPrompt(clean) && !isEcho && !isResizeDraw && !isMouseDraw) {
        this.setAgentRunning(true);
      }

      if (this.isAgentActive) {
        if (this.idleTimer) {
          clearTimeout(this.idleTimer);
        }
        this.idleTimer = setTimeout(() => {
          if (this.isAgentPrompt(clean)) {
            this.setAgentRunning(false);
          } else {
            this.idleTimer = setTimeout(() => {
              this.setAgentRunning(false);
            }, 1200);
          }
        }, 800);
      }
    }
  }

  private isSystemShellPrompt(clean: string): boolean {
    if (/(?:PS\s+)?[a-zA-Z]:\\[^>]*>\s*$/i.test(clean)) {
      return true;
    }
    if (/[a-zA-Z0-9_-]+@[a-zA-Z0-9_-]+:.*[\$#%]\s*$/.test(clean)) {
      return true;
    }
    if (/[\$#%]\s*$/.test(clean)) {
      return true;
    }
    return false;
  }

  private handleInput(data: string) {
    this.lastInputTime = Date.now();

    // Detect mouse-event VT sequences emitted by xterm when the agent
    // has enabled mouse reporting (e.g. agy's \x1b[?9001h). Scrolling
    // or clicking generates these, and the agent responds with redraws
    // that should NOT flip the badge to "Running".
    // Standard: \x1b[M<btn><x><y>   SGR: \x1b[<digits>M / \x1b[<digits>m
    if (data.includes('\x1b[M') || /\x1b\[<[\d;]+[Mm]/.test(data)) {
      this.lastMouseEventTime = Date.now();
    }

    this.sendBridgeMessage({ action: 'write', data });

    const cleanData = data.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');

    for (let i = 0; i < cleanData.length; i++) {
      const ch = cleanData[i];
      if (ch === '\r' || ch === '\n') {
        // Pressing Enter while inside agent CLI = user sent a message → Running
        if (this.isInAgentCli) {
          // Reset mouse/resize suppression so the agent response isn't silenced
          this.lastMouseEventTime = 0;
          this.lastResizeTime = 0;
          this.setAgentRunning(true);
          
          if (!this.hasCapturedAgentPrompt && this.lineBuffer.trim().length > 0) {
            this.currentHistoryTitle = this.lineBuffer.trim();
            this.hasCapturedAgentPrompt = true;
          }
        } else if (!this.currentHistoryTitle || this.currentHistoryTitle === 'AI Session') {
          // Capture the user's first command that launched the agent
          this.currentHistoryTitle = this.lineBuffer.trim();
        }
        this.lineBuffer = '';
      } else if (ch === '\x7f' || ch === '\b') {
        if (this.lineBuffer.length > 0) {
          this.lineBuffer = this.lineBuffer.slice(0, -1);
        }
      } else if (ch === '\x03') { // Ctrl+C
        this.setAgentRunning(false);
        this.lineBuffer = '';
      } else if (ch === '\x1b') { // Escape key
        this.lineBuffer = '';
      } else if (ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) < 127) {
        this.lineBuffer += ch;
      }
    }
  }

  private handleResize(cols: number, rows: number) {
    this.lastResizeTime = Date.now(); // mark so resize-triggered redraws don't flip badge
    this.lastCols = cols;
    this.lastRows = rows;
    this.sendBridgeMessage({ action: 'resize', cols, rows });
  }

  // ─── VS Code WebviewView ──────────────────────────────────────────────────

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void | Thenable<void> {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri],
    };

    webviewView.webview.html = this.getHtmlContent(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (message) => {
      switch (message.command) {
        case 'ready':
          if (this.ptyProcess) {
            // Sidebar was just hidden and re-shown — PTY is still alive.
            // Replay the scrollback buffer so xterm catches up, then don't
            // restart the PTY (the shell is already running).
            if (this.terminalScrollback) {
              webviewView.webview.postMessage({ command: 'output', data: this.terminalScrollback });
            }
            // Re-sync size in case the panel was resized while hidden
            this.handleResize(message.cols, message.rows);
          } else {
            // Fresh extension load or the PTY died — start a brand-new shell.
            // Do NOT replay old scrollback here; it would interleave with the
            // new shell's startup output and freeze xterm. Users can browse
            // past sessions via the History button instead.
            this.startPty(message.cols, message.rows);
          }
          this.sendStateMessage();
          break;
        case 'new-terminal':
          if (this.isAgentRunning()) {
            vscode.window.showWarningMessage('An agent is currently running. Please exit the agent before starting a new terminal.');
            return;
          }

          const activeSession = this.sessionsRepo.getActiveSession();
          if (activeSession) {
            const answer = await vscode.window.showInformationMessage(
              'Do you want to end the current AI tracking session, or keep it active for the new terminal?',
              'End Session', 'Keep Active'
            );

            if (!answer) {
              // User dismissed the dialog, cancel the new terminal action
              return;
            }

            if (answer === 'End Session') {
              // Force stop the DB tracking session for the old terminal
              vscode.commands.executeCommand('stavreng.stopSession', true);
            }
          }

          // User requested a fresh terminal — finalize history & restart
          this.saveCurrentSessionToHistory();
          // Reset history state for the new terminal
          this.currentHistoryBuffer = '';
          this.currentHistoryTitle = '';
          
          this.terminalScrollback = '';
          this.context.workspaceState.update('stavreng.terminalScrollback', '');
          this.resetAgentState();
          if (this.view) {
            this.view.webview.postMessage({ command: 'new-terminal' });
          }
          this.startPty(this.lastCols, this.lastRows);
          break;
        case 'launch-agent':
          vscode.commands.executeCommand('stavreng.launchAgent');
          break;
        case 'show-history':
          vscode.commands.executeCommand('stavreng.showHistory');
          break;
        case 'input':
          this.handleInput(message.data);
          break;
        case 'resize':
          this.handleResize(message.cols, message.rows);
          break;
        case 'toggle-agent':
          this.setAgentRunning(message.active);
          break;
        case 'reset-terminal':
          this.startPty(this.lastCols, this.lastRows);
          break;
        case 'request-state':
          this.sendStateMessage();
          break;
        case 'start-session':
          vscode.commands.executeCommand('stavreng.startSession');
          break;
        case 'stop-session':
          vscode.commands.executeCommand('stavreng.stopSession');
          break;
        case 'delete-session':
          vscode.commands.executeCommand('stavreng.deleteSession', message.sessionId);
          break;
        case 'accept-session':
          vscode.commands.executeCommand('stavreng.acceptAllSession', message.sessionId);
          break;
        case 'reject-session':
          vscode.commands.executeCommand('stavreng.rejectAllSession', message.sessionId);
          break;
        case 'accept-file':
          vscode.commands.executeCommand('stavreng.acceptFileChanges', message.filePath);
          break;
        case 'reject-file':
          vscode.commands.executeCommand('stavreng.rejectFileChanges', message.filePath);
          break;
        case 'open-review':
          vscode.commands.executeCommand('stavreng.openCustomReviewTab', message.filePath);
          break;
        case 'resume-active-terminal':
          // Re-send the actual active terminal scrollback to restore view
          if (this.view) {
            this.view.webview.postMessage({ command: 'new-terminal' });
            setTimeout(() => {
              this.view?.webview.postMessage({ command: 'output', data: this.terminalScrollback });
              this.sendStateMessage(); // refresh badges and buttons
            }, 100);
          }
          break;
      }
    });

    webviewView.onDidDispose(() => {
      // The webview is torn down when the sidebar is hidden. We keep the PTY
      // alive so we can replay scrollback when the user re-opens the sidebar.
      // The PTY is only destroyed when the extension fully deactivates.
      this.view = undefined;
    });

    // Send initial status
    webviewView.webview.postMessage({ command: 'status', active: this.isAgentActive, inCli: this.isInAgentCli });
  }

  private sendStateMessage() {
    if (!this.view) return;

    const activeSession = this.sessionsRepo.getActiveSession();
    const sessions = this.sessionsRepo.list().sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    const pendingPatches = this.patchesRepo.getPatches().filter(p => p.status === 'PENDING');

    const sessionsData = sessions.map(s => {
      const patches = this.patchesRepo.getBySession(s.id);
      const uniqueFiles = Array.from(new Set(patches.map(p => p.filePath)));
      const filesData = uniqueFiles.map(filePath => {
        const filePatches = patches.filter(p => p.filePath === filePath);
        const added = filePatches.reduce((sum, p) => sum + p.modifiedLineCount, 0);
        const removed = filePatches.reduce((sum, p) => sum + p.originalLineCount, 0);
        const pending = filePatches.some(p => p.status === 'PENDING');
        const accepted = filePatches.some(p => p.status === 'ACCEPTED');
        return {
          filePath,
          fileName: path.basename(filePath),
          added,
          removed,
          status: pending ? 'Review Required' : accepted ? 'Accepted' : 'Rejected',
          pending
        };
      });

      return {
        id: s.id,
        agentName: s.agentName,
        status: s.status,
        startedAt: s.startedAt,
        endedAt: s.endedAt,
        files: filesData,
        hasPending: pendingPatches.some(p => p.sessionId === s.id)
      };
    });

    const uniquePendingFiles = Array.from(new Set(pendingPatches.map(p => p.filePath)));
    const pendingFilesData = uniquePendingFiles.map(filePath => {
      const filePatches = pendingPatches.filter(p => p.filePath === filePath);
      return {
        filePath,
        fileName: path.basename(filePath),
        count: filePatches.length
      };
    });

    this.view.webview.postMessage({
      command: 'state',
      activeSession: activeSession ? { id: activeSession.id, agentName: activeSession.agentName } : null,
      sessions: sessionsData,
      pendingFiles: pendingFilesData,
      isAgentActive: this.isAgentActive
    });
  }

  // ─── HTML Content ─────────────────────────────────────────────────────────

  private getHtmlContent(webview: vscode.Webview): string {
    const xtermCssUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'node_modules', '@xterm', 'xterm', 'css', 'xterm.css'));
    const xtermJsUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'node_modules', '@xterm', 'xterm', 'lib', 'xterm.js'));
    const xtermFitJsUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'node_modules', '@xterm', 'addon-fit', 'lib', 'addon-fit.js'));

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none';
                 script-src ${webview.cspSource} 'unsafe-inline' 'unsafe-eval';
                 style-src  ${webview.cspSource} 'unsafe-inline';
                 img-src    ${webview.cspSource} data: blob:;
                 font-src   ${webview.cspSource} data:;
                 connect-src *;">
  <title>Stavreng</title>
  <link rel="stylesheet" href="${xtermCssUri}">
  <script src="${xtermJsUri}"></script>
  <script src="${xtermFitJsUri}"></script>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    
    :root {
      --bg: var(--vscode-sideBar-background, #1e1e1e);
      --fg: var(--vscode-sideBar-foreground, #cccccc);
      --border: var(--vscode-sideBar-border, rgba(128,128,128,0.2));
      --active-tab-bg: var(--vscode-sideBarSectionHeader-background, rgba(128,128,128,0.12));
      --accent: var(--vscode-button-background, #007acc);
      --accent-hover: var(--vscode-button-hoverBackground, #0062a3);
      --accent-fg: var(--vscode-button-foreground, #ffffff);
      --danger: #f14c4c;
      --success: #23d18b;
      --card-bg: rgba(128, 128, 128, 0.06);
    }

    html, body {
      margin: 0; padding: 0; width: 100%; height: 100vh;
      display: flex; flex-direction: column; overflow: hidden;
      background: var(--bg);
      color: var(--fg);
      font-family: var(--vscode-font-family, sans-serif);
      font-size: var(--vscode-font-size, 13px);
    }

    /* Top Navigation bar */
    .nav-header {
      display: flex; flex-direction: column;
      flex-shrink: 0;
      border-bottom: 1px solid var(--border);
      background: var(--bg);
      z-index: 10;
    }

    .top-controls {
      display: flex; align-items: center; justify-content: space-between;
      padding: 5px 8px;
      background: rgba(128, 128, 128, 0.04);
      min-width: 0; /* allow flex children to shrink */
    }

    .brand-title {
      font-weight: 700;
      font-size: 10px;
      letter-spacing: 0.6px;
      text-transform: uppercase;
      opacity: 0.85;
      display: flex; align-items: center; gap: 3px;
      white-space: nowrap;
      flex-shrink: 0;
    }

    .guard-status {
      display: flex; align-items: center; gap: 4px;
      padding: 2px 6px; border-radius: 10px;
      font-size: 9px; font-weight: 600;
      cursor: pointer; transition: all 0.3s cubic-bezier(0.25, 0.8, 0.25, 1);
      white-space: nowrap;
    }

    .guard-status.idle {
      background: rgba(128, 128, 128, 0.15); color: var(--fg);
      border: 1px solid rgba(128, 128, 128, 0.3);
    }

    .guard-status.monitoring {
      background: rgba(0, 122, 204, 0.15); color: var(--accent, #3b8eea);
      border: 1px solid rgba(0, 122, 204, 0.35);
    }

    .guard-status.active {
      background: rgba(35, 209, 139, 0.15); color: var(--success);
      border: 1px solid rgba(35, 209, 139, 0.35);
      animation: pulse 2s infinite cubic-bezier(0.25, 0, 0, 1);
    }

    @keyframes pulse {
      0% { box-shadow: 0 0 0 0 rgba(35, 209, 139, 0.4); transform: scale(1); }
      50% { box-shadow: 0 0 0 6px rgba(35, 209, 139, 0); transform: scale(1.03); }
      100% { box-shadow: 0 0 0 0 rgba(35, 209, 139, 0); transform: scale(1); }
    }

    .session-actions {
      display: flex; align-items: center; gap: 3px;
      min-width: 0; flex-shrink: 1;
    }

    .btn-circle {
      background: none; border: none; cursor: pointer;
      width: 22px; height: 22px; border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      color: var(--fg); opacity: 0.6;
      transition: all 0.25s cubic-bezier(0.25, 0.8, 0.25, 1);
    }

    .btn-circle:hover {
      opacity: 1;
      background: rgba(128,128,128,0.2);
      transform: scale(1.12);
    }

    /* Tabs Bar */
    .tabs-bar {
      display: flex; border-top: 1px solid var(--border);
    }

    .tab-btn {
      flex: 1; text-align: center; padding: 10px 4px;
      background: none; border: none; color: var(--fg);
      font-size: 11px; font-weight: 600; cursor: pointer;
      opacity: 0.6; position: relative;
      transition: all 0.25s cubic-bezier(0.25, 0.8, 0.25, 1);
      display: flex; align-items: center; justify-content: center; gap: 6px;
    }

    .tab-btn:hover {
      opacity: 0.95;
      background: rgba(128, 128, 128, 0.05);
    }

    .tab-btn.active {
      opacity: 1;
      background: var(--active-tab-bg);
      color: var(--accent);
    }

    .tab-btn.active::after {
      content: '';
      position: absolute; bottom: 0; left: 0; width: 100%; height: 2px;
      background: var(--accent);
      animation: tabSlide 0.3s cubic-bezier(0.25, 0.8, 0.25, 1);
    }

    @keyframes tabSlide {
      from { transform: scaleX(0); }
      to { transform: scaleX(1); }
    }

    .badge-count {
      background: var(--accent); color: var(--accent-fg);
      font-size: 9px; font-weight: 700;
      padding: 1px 5px; border-radius: 8px;
      display: inline-block; min-width: 15px; text-align: center;
    }

    /* Content Area */
    .tab-content {
      flex: 1; overflow: hidden; position: relative;
      display: flex; flex-direction: column;
    }

    .panel {
      display: none; width: 100%; height: 100%;
      overflow-y: auto; padding: 12px;
    }

    .panel.active {
      display: flex; flex-direction: column;
      animation: fadeIn 0.3s cubic-bezier(0.25, 0.8, 0.25, 1);
    }

    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(8px); }
      to { opacity: 1; transform: translateY(0); }
    }

    /* Terminal panel specifically fills completely */
    #panel-terminal {
      padding: 0;
      min-height: 0; /* allow flex child to shrink below content size */
    }

    #terminal-wrap {
      flex: 1;
      min-height: 0; /* critical: without this, flex child ignores overflow */
      width: 100%;
      overflow: hidden;
      padding: 4px;
      background: var(--vscode-terminal-background, #1e1e1e);
    }
    /* xterm canvas layers must fill the wrap fully */
    #terminal-wrap .xterm            { height: 100%; }
    #terminal-wrap .xterm-viewport   { overflow-y: auto !important; }
    #terminal-wrap .xterm-screen     { }
    #terminal-wrap .xterm-screen     { }
    /* xterm scrollbar — webview body overrides */
    body::-webkit-scrollbar {
      width: 4px;
    }
    body::-webkit-scrollbar-thumb {
      background: rgba(255, 255, 255, 0.15);
      border-radius: 2px;
    }
    body::-webkit-scrollbar-track {
      background: transparent;
    }


    .btn-terminal-action {
      background: rgba(128,128,128,0.15);
      border: 1px solid rgba(128,128,128,0.2);
      border-radius: 4px;
      color: var(--fg); opacity: 0.7;
      cursor: pointer; padding: 2px 5px;
      font-size: 9px; font-weight: 600;
      display: flex; align-items: center; gap: 2px;
      transition: all 0.2s cubic-bezier(0.25, 0.8, 0.25, 1);
      white-space: nowrap;
    }
    .btn-terminal-action:not(.disabled):hover {
      opacity: 1;
      background: rgba(128,128,128,0.28);
      transform: scale(1.05);
    }
    .btn-terminal-action.disabled,
    .btn-icon.disabled {
      opacity: 0.3 !important;
      cursor: not-allowed !important;
      pointer-events: auto; /* allow hover for title */
    }
    .btn-icon:not(.disabled):hover {
      background: rgba(128,128,128,0.2);
    }

    .section-title {
      font-size: 11px; font-weight: 700; text-transform: uppercase;
      letter-spacing: 0.5px; margin-bottom: 8px; opacity: 0.5;
    }

    .session-card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      margin-bottom: 10px;
      padding: 10px 12px;
      transition: all 0.3s cubic-bezier(0.25, 0.8, 0.25, 1);
      animation: slideIn 0.35s cubic-bezier(0.25, 0.8, 0.25, 1) backwards;
    }

    @keyframes slideIn {
      from { opacity: 0; transform: translateY(12px) scale(0.98); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }

    .session-card:hover {
      border-color: rgba(128,128,128,0.4);
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
      transform: translateY(-2px);
    }

    .session-header {
      display: flex; align-items: center; justify-content: space-between;
      margin-bottom: 6px;
    }

    .session-name {
      font-weight: 600; font-size: 12px;
      display: flex; align-items: center; gap: 6px;
    }

    .session-status-badge {
      font-size: 9px; font-weight: 700; text-transform: uppercase;
      padding: 1px 6px; border-radius: 4px;
    }
    .session-status-badge.active { background: rgba(35,209,139,0.15); color: var(--success); }
    .session-status-badge.completed { background: rgba(128,128,128,0.15); color: var(--fg); opacity: 0.7; }

    .session-time {
      font-size: 10px; opacity: 0.5; margin-bottom: 8px;
    }

    .session-files {
      border-top: 1px solid rgba(128,128,128,0.1);
      padding-top: 6px;
      display: flex; flex-direction: column; gap: 4px;
    }

    .file-row {
      display: flex; align-items: center; justify-content: space-between;
      padding: 6px 8px; border-radius: 4px;
      transition: all 0.2s cubic-bezier(0.25, 0.8, 0.25, 1);
      cursor: pointer;
    }

    .file-row:hover {
      background: rgba(128,128,128,0.1);
      transform: translateX(4px);
    }

    .file-info {
      display: flex; align-items: center; gap: 6px; overflow: hidden;
    }

    .file-name {
      text-overflow: ellipsis; overflow: hidden; white-space: nowrap;
      font-weight: 500;
    }

    .file-stats {
      font-size: 10px; opacity: 0.6; flex-shrink: 0;
    }

    .stat-add { color: var(--success); font-weight: 600; }
    .stat-sub { color: var(--danger); font-weight: 600; }

    /* Button Actions */
    .actions-row {
      display: flex; align-items: center; gap: 6px; margin-top: 8px;
    }

    .btn-small {
      background: rgba(128, 128, 128, 0.1); border: 1px solid var(--border);
      color: var(--fg); cursor: pointer; padding: 4px 8px; border-radius: 4px;
      font-size: 10px; font-weight: 600; display: flex; align-items: center; gap: 4px;
      transition: all 0.2s cubic-bezier(0.25, 0.8, 0.25, 1);
    }

    .btn-small:hover {
      background: rgba(128, 128, 128, 0.25);
      transform: translateY(-1px);
    }

    .btn-small.danger:hover {
      background: rgba(241, 76, 76, 0.18);
      border-color: var(--danger);
      color: #ff6e6e;
    }

    .btn-small.primary {
      background: var(--accent); color: var(--accent-fg); border-color: transparent;
    }
    .btn-small.primary:hover {
      background: var(--accent-hover);
    }

    .btn-icon {
      background: none; border: none; cursor: pointer;
      color: var(--fg); opacity: 0.5; padding: 2px;
      transition: all 0.2s cubic-bezier(0.25, 0.8, 0.25, 1);
    }
    .btn-icon:hover {
      opacity: 1; color: var(--danger);
      transform: scale(1.15);
    }

    .empty-state {
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      height: 120px; opacity: 0.5; text-align: center; gap: 8px;
    }

    .pending-card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 8px 10px;
      margin-bottom: 8px;
      display: flex; align-items: center; justify-content: space-between;
      animation: slideIn 0.3s cubic-bezier(0.25, 0.8, 0.25, 1) backwards;
      transition: all 0.25s cubic-bezier(0.25, 0.8, 0.25, 1);
    }

    .pending-card:hover {
      border-color: rgba(128, 128, 128, 0.35);
      background: rgba(128, 128, 128, 0.09);
      transform: translateY(-1.5px);
    }

    .pending-actions {
      display: flex; gap: 4px;
    }
  </style>
</head>
<body>
  <div class="nav-header">
    <div class="top-controls">
      <div class="brand-title">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
        Stavreng
      </div>
      <div class="session-actions">
        <button id="btn-launch" class="btn-terminal-action" onclick="launchAgent()" title="Quick Launch AI Agent">
          🚀 Launch
        </button>
        <button id="btn-new" class="btn-terminal-action" onclick="newTerminal()" title="New terminal session">
          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          New
        </button>
        <span id="badge-guard" class="guard-status idle" onclick="toggleGuard()" title="Toggle Agent Guard State">🟢 Idle</span>
        <button class="btn-circle" onclick="showHistory()" title="Conversation History">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
        </button>
      </div>
    </div>
    
    <div class="tabs-bar">
      <button class="tab-btn active" onclick="switchTab('terminal')">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
        Terminal
      </button>
      <button class="tab-btn" onclick="switchTab('timeline')">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
        Timeline
      </button>
      <button class="tab-btn" onclick="switchTab('pending')">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
        Pending <span id="badge-pending" class="badge-count" style="display:none">0</span>
      </button>
    </div>
  </div>

  <div class="tab-content">
    <div id="panel-terminal" class="panel active">
      <div id="terminal-wrap"></div>
    </div>
    
    <div id="panel-timeline" class="panel">
      <div class="section-title">Sessions Log</div>
      <div id="timeline-list">
        <!-- Rendered dynamically -->
      </div>
    </div>

    <div id="panel-pending" class="panel">
      <div class="section-title">AI Changes Waiting Review</div>
      <div id="pending-list">
        <!-- Rendered dynamically -->
      </div>
    </div>
  </div>

  <script>
    (function () {
      const vscode = acquireVsCodeApi();
      let activeTab = 'terminal';
      let term = null;
      let fitAddon = null;
      let isAgentRunning = false;
      let isInAgentCli = false;
      let isHistoryView = false;

      // Initialize xterm.js
      function initTerminal() {
        const wrap = document.getElementById('terminal-wrap');
        const diag = document.getElementById('diag-status');
        const setStatus = (msg) => { if (diag) diag.textContent = msg; };
        
        setStatus('Step 1: Starting...');

        // Check xterm is available
        if (typeof Terminal === 'undefined') {
          setStatus('ERROR: xterm.js failed to load! Check CSP / network.');
          return;
        }
        setStatus('Step 2: xterm available, creating Terminal...');

        let termLocal;
        try {
          termLocal = new Terminal({
            cursorBlink: true,
            scrollback: 10000,
            fontFamily: 'Consolas, "Cascadia Code", "Courier New", monospace',
            fontSize: 12,
            lineHeight: 1.2,
            convertEol: false,
          });
          term = termLocal;
          setStatus('Step 3: Terminal object created');
        } catch(e) {
          setStatus('ERROR creating Terminal: ' + e.message);
          return;
        }

        try {
          if (typeof FitAddon !== 'undefined' && FitAddon.FitAddon) {
            fitAddon = new FitAddon.FitAddon();
            term.loadAddon(fitAddon);
            setStatus('Step 4: FitAddon loaded');
          } else {
            setStatus('Step 4: FitAddon not available');
          }
        } catch(e) {
          setStatus('ERROR loading FitAddon: ' + e.message);
        }

        try {
          setStatus('Step 5: Calling term.open(wrap)...');
          term.open(wrap);
          setStatus('Step 6: term.open() succeeded');
        } catch(e) {
          setStatus('ERROR in term.open: ' + e.message);
          return;
        }

        term.attachCustomKeyEventHandler(function (e) {
          const isCopy = (e.ctrlKey || e.metaKey) && e.key === 'c';
          const isCtrlA = (e.ctrlKey || e.metaKey) && e.key === 'a';
          const isCtrlZ = (e.ctrlKey || e.metaKey) && e.key === 'z';
          const isCtrlY = (e.ctrlKey || e.metaKey) && e.key === 'y';
          const isCtrlX = (e.ctrlKey || e.metaKey) && e.key === 'x';
          
          if (isCopy) {
            if (term.hasSelection()) {
              if (e.type === 'keydown') {
                const text = term.getSelection();
                navigator.clipboard.writeText(text);
              }
              return false;
            }
          }

          if (isCtrlA || isCtrlZ || isCtrlY || isCtrlX) {
            if (e.type === 'keydown') {
              let char = '';
              if (e.key === 'a') char = '\\x01';
              if (e.key === 'z') char = '\\x1a';
              if (e.key === 'y') char = '\\x19';
              if (e.key === 'x') char = '\\x18';
              
              if (char) {
                vscode.postMessage({ command: 'input', data: char });
              }
            }
            e.preventDefault();
            e.stopPropagation();
            return false;
          }
          
          return true;
        });

        function fit() {
          try {
            if (fitAddon) { fitAddon.fit(); }
            vscode.postMessage({ command: 'resize', cols: term.cols, rows: term.rows });
          } catch(e) {}
        }

        // Debounced fit: only fire at most once per animation frame to avoid
        // the resize loop where xterm rendering changes the container height
        // which triggers ResizeObserver which triggers PTY resize etc.
        let fitScheduled = false;
        function scheduleFit() {
          if (fitScheduled) return;
          fitScheduled = true;
          requestAnimationFrame(() => {
            fitScheduled = false;
            fit();
          });
        }

        // Initial fit — wait one frame so the layout is stable before we
        // measure and send 'ready' (avoids 0-row terminal on first paint)
        requestAnimationFrame(() => {
          setStatus('Step 7: Fitting and sending ready...');
          fit();
          vscode.postMessage({ command: 'ready', cols: term.cols, rows: term.rows });
          // Hide diag after ready sent - terminal should show up soon
          setTimeout(() => { if (diag) diag.style.display = 'none'; }, 3000);
        });

        new ResizeObserver(scheduleFit).observe(wrap);

        term.onData(function(data) {
          if (isHistoryView) return;
          vscode.postMessage({ command: 'input', data: data });
        });
      }

      // Tab Switching with Animations
      window.switchTab = function(tabId) {
        if (activeTab === tabId) return;

        // Deactivate old tab
        document.querySelector('.tab-btn.active').classList.remove('active');
        document.querySelector('.panel.active').classList.remove('active');

        // Activate new tab
        const newTabBtn = Array.from(document.querySelectorAll('.tab-btn')).find(btn => btn.outerHTML.includes(tabId));
        if (newTabBtn) newTabBtn.classList.add('active');

        const newPanel = document.getElementById('panel-' + tabId);
        newPanel.classList.add('active');

        activeTab = tabId;

        // When switching TO terminal, re-fit after the DOM fully paints.
        // Double rAF guarantees both the layout pass and the paint are done
        // before xterm measures its container — fixes the "scattered" layout.
        if (tabId === 'terminal' && fitAddon) {
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              try {
                fitAddon.fit();
                vscode.postMessage({ command: 'resize', cols: term.cols, rows: term.rows });
              } catch(e) {}
            });
          });
        }
      };

      // Header Controls Callbacks
      window.toggleGuard = function() {
        vscode.postMessage({ command: 'toggle-agent', active: !isAgentRunning });
      };
      window.launchAgent = function() {
        if (isInAgentCli) return;
        vscode.postMessage({ command: 'launch-agent' });
      };
      window.showHistory = function() {
        vscode.postMessage({ command: 'show-history' });
      };
      window.newTerminal = function() {
        if (isInAgentCli) return;
        vscode.postMessage({ command: 'new-terminal' });
      };

      // Sidebar Action delegates
      window.stopSession = function() {
        if (isInAgentCli) return;
        vscode.postMessage({ command: 'stop-session' });
      };
      window.deleteSession = function(sessionId, e) {
        if (e) e.stopPropagation();
        if (isInAgentCli) return;
        vscode.postMessage({ command: 'delete-session', sessionId });
      };
      window.acceptSession = function(sessionId, e) {
        if (e) e.stopPropagation();
        vscode.postMessage({ command: 'accept-session', sessionId });
      };
      window.rejectSession = function(sessionId, e) {
        if (e) e.stopPropagation();
        vscode.postMessage({ command: 'reject-session', sessionId });
      };
      window.acceptFile = function(filePath, e) {
        if (e) e.stopPropagation();
        vscode.postMessage({ command: 'accept-file', filePath });
      };
      window.rejectFile = function(filePath, e) {
        if (e) e.stopPropagation();
        vscode.postMessage({ command: 'reject-file', filePath });
      };
      window.openReview = function(filePath, e) {
        if (e) e.stopPropagation();
        vscode.postMessage({ command: 'open-review', filePath });
      };

      // State Rendering Functions
      function renderTimeline(sessions) {
        const list = document.getElementById('timeline-list');
        if (!sessions || sessions.length === 0) {
          list.innerHTML = \`<div class="empty-state">No historical sessions.</div>\`;
          return;
        }

        list.innerHTML = sessions.map((s, idx) => {
          const filesHtml = s.files.map(f => \`
            <div class="file-row" onclick="openReview('\${f.filePath}', event)">
              <div class="file-info">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                <span class="file-name" title="\${f.filePath}">\${f.fileName}</span>
              </div>
              <div class="file-stats">
                <span class="stat-add">+\${f.added}</span>/<span class="stat-sub">-\${f.removed}</span>
              </div>
            </div>
          \`).join('');

          const dateStr = new Date(s.startedAt).toLocaleString();
          const badgeClass = s.status === 'ACTIVE' ? 'active' : 'completed';
          
          let headerActions = '';
          if (s.hasPending) {
            headerActions = \`
              <div class="actions-row">
                <button class="btn-small primary" onclick="acceptSession('\${s.id}', event)">Accept All</button>
                <button class="btn-small" onclick="rejectSession('\${s.id}', event)">Reject All</button>
              </div>
            \`;
          }

          const btnClass = isInAgentCli ? 'btn-icon disabled' : 'btn-icon';
          const stopTitle = isInAgentCli ? 'The agent is running, stop the agent first before you can close this session' : 'Stop Session';
          const deleteTitle = isInAgentCli ? 'The agent is running, stop the agent first before you can close this session' : 'Delete Session';

          const cardActions = s.status === 'ACTIVE'
            ? \`<button class="\${btnClass} btn-stop-session" onclick="stopSession()" title="\${stopTitle}"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="4" y="4" width="16" height="16"/></svg></button>\`
            : \`<button class="\${btnClass} btn-stop-session" onclick="deleteSession('\${s.id}', event)" title="\${deleteTitle}"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>\`;

          return \`
            <div class="session-card" style="animation-delay: \${idx * 0.05}s">
              <div class="session-header">
                <span class="session-name">
                  \${s.agentName}
                  <span class="session-status-badge \${badgeClass}">\${s.status}</span>
                </span>
                \${cardActions}
              </div>
              <div class="session-time">\${dateStr}</div>
              <div class="session-files">
                \${filesHtml}
              </div>
              \${headerActions}
            </div>
          \`;
        }).join('');
      }

      function renderPending(pendingFiles) {
        const list = document.getElementById('pending-list');
        const badgePending = document.getElementById('badge-pending');
        
        let pendingCount = 0;
        pendingFiles.forEach(f => pendingCount += f.count);

        if (pendingCount > 0) {
          badgePending.textContent = pendingCount;
          badgePending.style.display = 'inline-block';
        } else {
          badgePending.style.display = 'none';
        }

        if (!pendingFiles || pendingFiles.length === 0) {
          list.innerHTML = \`<div class="empty-state">No changes pending review.</div>\`;
          return;
        }

        list.innerHTML = pendingFiles.map((f, idx) => \`
          <div class="pending-card" style="animation-delay: \${idx * 0.04}s" onclick="openReview('\${f.filePath}', event)">
            <div class="file-info" style="flex:1">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
              <span class="file-name" title="\${f.filePath}">\${f.fileName}</span>
              <span class="badge-count" style="margin-left:4px; font-size:9px">\${f.count}</span>
            </div>
            <div class="pending-actions">
              <button class="btn-small primary" onclick="acceptFile('\${f.filePath}', event)">Accept</button>
              <button class="btn-small danger" onclick="rejectFile('\${f.filePath}', event)">Reject</button>
            </div>
          </div>
        \`).join('');
      }

      // Backend Message Listener
      window.addEventListener('message', function (event) {
        const msg = event.data;
        switch (msg.command) {
          case 'output': {
            const diag2 = document.getElementById('diag-status');
            if (diag2 && diag2.style.display !== 'none') {
              diag2.textContent = 'OUTPUT received: ' + msg.data.length + ' bytes. term=' + (term ? 'ok' : 'NULL');
            }
            if (term) term.write(msg.data);
            break;
          }
          case 'new-terminal':
            if (term) {
              term.clear();
              term.reset();
            }
            break;
          case 'show-history-view':
            if (term) {
              term.clear();
              term.reset();
              isHistoryView = true;

              // Add the Read-Only Banner
              let banner = document.getElementById('history-banner');
              if (!banner) {
                banner = document.createElement('div');
                banner.id = 'history-banner';
                banner.style.position = 'absolute';
                banner.style.top = '0';
                banner.style.left = '0';
                banner.style.right = '0';
                banner.style.padding = '6px 10px';
                banner.style.background = 'var(--vscode-editorError-background, rgba(255, 50, 50, 0.15))';
                banner.style.color = 'var(--vscode-editorError-foreground, #ff8080)';
                banner.style.borderBottom = '1px solid var(--vscode-editorError-border, rgba(255, 50, 50, 0.4))';
                banner.style.zIndex = '100';
                banner.style.display = 'flex';
                banner.style.justifyContent = 'space-between';
                banner.style.alignItems = 'center';
                banner.style.fontSize = '11px';
                banner.style.fontWeight = '600';
                
                const titleSpan = document.createElement('span');
                banner.appendChild(titleSpan);

                const backBtn = document.createElement('button');
                backBtn.innerHTML = '⬅ Back to Active Terminal';
                backBtn.className = 'btn-small primary';
                backBtn.onclick = () => {
                  banner.style.display = 'none';
                  isHistoryView = false;
                  vscode.postMessage({ command: 'resume-active-terminal' });
                };
                banner.appendChild(backBtn);
                
                const wrap = document.getElementById('terminal-wrap');
                wrap.style.position = 'relative';
                wrap.appendChild(banner);
              }
              
              banner.children[0].textContent = 'Read-Only History: ' + msg.title;
              banner.style.display = 'flex';

              // Disable main header buttons
              document.getElementById('btn-launch')?.classList.add('disabled');
              document.getElementById('btn-new')?.classList.add('disabled');
              
              // Render text
              term.write(msg.data);
              
              // Switch to terminal tab
              switchTab('terminal');
            }
            break;
          case 'status':
            isAgentRunning = msg.active;
            isInAgentCli = msg.inCli;
            const badge = document.getElementById('badge-guard');
            
            if (isInAgentCli) {
              if (isAgentRunning) {
                badge.className = 'guard-status active';
                badge.textContent = '🤖 Running';
              } else {
                badge.className = 'guard-status monitoring';
                badge.textContent = '🤖 Active';
              }
            } else {
              badge.className = 'guard-status idle';
              badge.textContent = '🟢 Idle';
            }
            
            // Disable UI elements while running or active
            const btnLaunch = document.getElementById('btn-launch');
            const btnNew = document.getElementById('btn-new');
            const stopBtns = document.querySelectorAll('.btn-stop-session');
            
            if (isInAgentCli) {
              if (btnLaunch) {
                btnLaunch.classList.add('disabled');
                btnLaunch.title = 'The agent is running, stop the agent first before you can launch another agent';
              }
              if (btnNew) {
                btnNew.classList.add('disabled');
                btnNew.title = 'The agent is running, stop the agent first before you can open a new terminal';
              }
              stopBtns.forEach(btn => {
                btn.classList.add('disabled');
                btn.title = 'The agent is running, stop the agent first before you can close this session';
              });
            } else {
              if (btnLaunch) {
                btnLaunch.classList.remove('disabled');
                btnLaunch.title = 'Quick Launch AI Agent';
              }
              if (btnNew) {
                btnNew.classList.remove('disabled');
                btnNew.title = 'New terminal session';
              }
              stopBtns.forEach(btn => {
                btn.classList.remove('disabled');
                btn.title = btn.onclick && btn.onclick.toString().includes('deleteSession') ? 'Delete Session' : 'Stop Session';
              });
            }
            break;
          case 'state':
            renderTimeline(msg.sessions);
            renderPending(msg.pendingFiles);
            // Remove start/stop UI toggling logic as it has been replaced by History
            break;
        }
      });

      // Launch
      initTerminal();
    })();
  </script>
</body>
</html>`;
  }
}

