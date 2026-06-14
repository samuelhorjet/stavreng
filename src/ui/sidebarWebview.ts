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

  /**
   * Set to true once the extension has finished its workspace snapshot.
   * The terminal will NOT start until this is true.
   */
  private isExtensionReady = false;

  /** Saved cols/rows from the first 'ready' message, so PTY can start once extension is done. */
  private pendingReadyCols?: number;
  private pendingReadyRows?: number;

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

  // â”€â”€â”€ Public API â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

  /**
   * Called by extension.ts once snapshotWorkspace() has finished.
   * Flips the ready gate and starts the terminal if the webview was waiting.
   */
  public setExtensionReady(): void {
    this.isExtensionReady = true;
    if (this.view) {
      // Tell the webview to hide the spinner
      this.view.webview.postMessage({ command: 'ready' });
    }
    if (!this.ptyProcess) {
      // Webview sent 'ready' while we were still snapshotting â€” start PTY now
      this.startPty(this.pendingReadyCols, this.pendingReadyRows);
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

  // â”€â”€â”€ Shell Detection â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

  // â”€â”€â”€ PTY Lifecycle â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

    // â”€â”€ Layer 1: Alternate Screen Buffer â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

    // â”€â”€ Layer 2: Interactive TUI Stdin Takeover signals â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // Inline TUI agents (agy/Antigravity CLI, Codex/React Ink, Aider, etc.)
    // don't use the alternate screen â€” instead they signal stdin takeover via
    // one or more of these sequences. curl, npm, git, pnpm NEVER emit these.
    //
    // IMPORTANT: PowerShell itself emits \x1b[?9001h and \x1b[?1004h on startup.
    // We must NOT trigger agent detection from these shell-startup signals.
    // Solution: only honour enter-signals AFTER the user has typed something.
    //
    // Detection priority (earliest-fired first for agy):
    //   \x1b[?9001h  Win32 extended input mode  â† agy emits this FIRST (but so does PSReadLine!)
    //   \x1b[?1004h  Focus-in/out event tracking â† agy emits this second (also PSReadLine)
    //   \x1b[?2004h  Bracketed paste mode        â† Codex, aider, most others
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
        // Pressing Enter while inside agent CLI = user sent a message â†’ Running
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

  // â”€â”€â”€ VS Code WebviewView â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
            // Sidebar was just hidden and re-shown â€” PTY is still alive.
            // Replay the scrollback buffer so xterm catches up.
            if (this.terminalScrollback) {
              webviewView.webview.postMessage({ command: 'output', data: this.terminalScrollback });
            }
            this.handleResize(message.cols, message.rows);
          } else if (!this.isExtensionReady) {
            // Extension is still snapshotting the workspace.
            // Save the dimensions and start the PTY once we're ready.
            this.pendingReadyCols = message.cols;
            this.pendingReadyRows = message.rows;
            // The spinner is already shown via HTML; send the loading command to make it explicit.
            webviewView.webview.postMessage({ command: 'loading', message: 'Indexing workspace...' });
          } else {
            // Extension is ready and PTY is not running â€” start a brand-new shell.
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

          // User requested a fresh terminal â€” finalize history & restart
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

    // â”€â”€ Auto-focus terminal when VS Code window regains focus â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // When the user alt-tabs back to VS Code, the webview loses focus to the
    // editor. We post a 'focus-terminal' message so xterm calls term.focus()
    // automatically â€” no need to click the sidebar.
    const windowFocusDisposable = vscode.window.onDidChangeWindowState(state => {
      if (state.focused && this.view?.visible) {
        // Small delay to let VS Code finish its own focus restoration
        setTimeout(() => {
          this.view?.webview.postMessage({ command: 'focus-terminal' });
        }, 150);
      }
    });

    // Also refocus when the sidebar panel itself becomes visible
    // (e.g. user clicks the sidebar icon or switches back to this panel)
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        setTimeout(() => {
          this.view?.webview.postMessage({ command: 'focus-terminal' });
        }, 100);
      }
    });

    // Store disposables so they're cleaned up when the extension deactivates
    this.context.subscriptions.push(windowFocusDisposable);

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

      const totalAdded   = filesData.reduce((sum, f) => sum + f.added,   0);
      const totalRemoved = filesData.reduce((sum, f) => sum + f.removed, 0);

      return {
        id: s.id,
        agentName: s.agentName,
        status: s.status,
        startedAt: s.startedAt,
        endedAt: s.endedAt,
        files: filesData,
        hasPending: pendingPatches.some(p => p.sessionId === s.id),
        totalAdded,
        totalRemoved
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

  // â”€â”€â”€ HTML Content â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  //
  // The HTML template lives in media/sidebar.html and the styles in
  // media/sidebar.css.  This method loads both files at runtime and
  // substitutes the {{PLACEHOLDER}} tokens with the correct webview URIs.

  private getHtmlContent(webview: vscode.Webview): string {
    const xtermCssUri    = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'node_modules', '@xterm', 'xterm',        'css', 'xterm.css'));
    const xtermJsUri     = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'node_modules', '@xterm', 'xterm',        'lib', 'xterm.js'));
    const xtermFitJsUri  = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'node_modules', '@xterm', 'addon-fit',   'lib', 'addon-fit.js'));
    const sidebarCssUri  = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'src', 'ui', 'sidebar.css'));

    const extensionRoot = this.context.extensionUri.fsPath;
    const htmlTemplate  = fs.readFileSync(path.join(extensionRoot, 'src', 'ui', 'sidebar.html'), 'utf8');

    return htmlTemplate
      .replace(/{{CSP_SOURCE}}/g,    webview.cspSource)
      .replace('{{XTERM_CSS_URI}}',  xtermCssUri.toString())
      .replace('{{XTERM_JS_URI}}',   xtermJsUri.toString())
      .replace('{{XTERM_FIT_JS_URI}}', xtermFitJsUri.toString())
      .replace('{{SIDEBAR_CSS_URI}}', sidebarCssUri.toString());
  }
}

