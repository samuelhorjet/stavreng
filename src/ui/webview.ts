import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { Patch } from '../db/types.js';
import { SessionsRepository } from '../db/sessions.js';
import { PatchesRepository } from '../db/patches.js';

export class StavrengReviewWebview {
  private panel: vscode.WebviewPanel | null = null;
  private currentPatches: Patch[] = [];
  private isReadOnly = false;
  private currentFilePath?: string;
  private currentSessionId?: string;

  constructor(
    private context: vscode.ExtensionContext,
    private sessionsRepo: SessionsRepository,
    private patchesRepo: PatchesRepository,
    private onAcceptFile: (patchIds: string[]) => Promise<void>,
    private onRejectFile: (patchIds: string[]) => Promise<void>
  ) {}

  public show(patches: Patch[], readOnly = false): void {
    if (patches.length === 0) return;
    this.currentPatches = [...patches];
    this.isReadOnly = readOnly;
    this.currentFilePath = this.currentPatches[0].filePath;
    this.currentSessionId = this.currentPatches[0].sessionId;
    
    // Sort patches by line number
    this.currentPatches.sort((a, b) => a.modifiedStartLine - b.modifiedStartLine);
    const fileName = path.basename(this.currentFilePath);

    if (this.panel) {
      this.panel.title = `Review: ${fileName}`;
      this.panel.reveal(vscode.ViewColumn.Active);
      this.updatePanelContent();
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'stavrengReview',
      `Review: ${fileName}`,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        localResourceRoots: [this.context.extensionUri]
      }
    );

    this.updatePanelContent();

    this.panel.webview.onDidReceiveMessage(async message => {
      switch (message.command) {
        case 'acceptAll':
          await this.onAcceptFile(message.patchIds);
          this.refreshIfOpen();
          break;
        case 'rejectAll':
          await this.onRejectFile(message.patchIds);
          this.refreshIfOpen();
          break;
        case 'acceptHunk':
          await this.onAcceptFile([message.patchId]);
          this.refreshIfOpen();
          break;
        case 'rejectHunk':
          await this.onRejectFile([message.patchId]);
          this.refreshIfOpen();
          break;
      }
    });

    this.panel.onDidDispose(() => {
      this.panel = null;
      this.currentFilePath = undefined;
      this.currentSessionId = undefined;
    });
  }

  public refreshIfOpen(): void {
    if (!this.panel || !this.currentFilePath || !this.currentSessionId) return;

    const filePatches = this.patchesRepo.getPatches()
      .filter(p => p.filePath === this.currentFilePath && p.sessionId === this.currentSessionId);

    if (filePatches.length === 0) {
      this.panel.dispose();
      return;
    }

    const pendingPatches = filePatches.filter(p => p.status === 'PENDING');
    if (pendingPatches.length > 0) {
      this.currentPatches = pendingPatches;
      this.isReadOnly = false;
    } else {
      this.currentPatches = filePatches;
      this.isReadOnly = true;
    }

    this.currentPatches.sort((a, b) => a.modifiedStartLine - b.modifiedStartLine);
    this.updatePanelContent();
  }

  private updatePanelContent(): void {
    if (!this.panel || this.currentPatches.length === 0) return;

    const session = this.sessionsRepo.getById(this.currentPatches[0].sessionId);
    const agentName = session ? session.agentName : 'AI Agent';
    
    this.panel.webview.html = this.getHtmlContent(this.currentPatches, agentName, this.isReadOnly);
  }

  private getHtmlContent(patches: Patch[], agentName: string, readOnly: boolean): string {
    const patchIdsStr = JSON.stringify(patches.map(p => p.id));
    
    let fullHtml = '';
    let liveLines: string[] = [];
    try {
      const rawCode = fs.readFileSync(patches[0].filePath, 'utf8');
      liveLines = rawCode.split(/\r?\n/);
    } catch (e) {
      liveLines = ['Error reading live file context.'];
    }

    let currentLiveLine = 1;

    for (const patch of patches) {
      // 1. Unchanged lines
      while (currentLiveLine < patch.modifiedStartLine && currentLiveLine <= liveLines.length) {
        fullHtml += this.renderNormalLine(currentLiveLine, liveLines[currentLiveLine - 1]);
        currentLiveLine++;
      }

      // 2. Render patch block with hover controls
      fullHtml += `<div class="patch-block" data-patch-id="${patch.id}">`;
      if (!readOnly) {
        fullHtml += `
          <div class="patch-actions">
            <button class="btn-accept-hunk" onclick="acceptHunk('${patch.id}')" title="Accept this hunk">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>
              Accept
            </button>
            <button class="btn-reject-hunk" onclick="rejectHunk('${patch.id}')" title="Reject and revert this hunk">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
              Reject
            </button>
          </div>
        `;
      }

      let patchLineNum = patch.modifiedStartLine;
      const lines = patch.hunkDiff.split('\n');
      for (const line of lines) {
        // Skip unified diff metadata markers (e.g. "\ No newline at end of file")
        if (line.startsWith('\\')) continue;
        if (line === '') continue;

        if (line.startsWith('+')) {
          fullHtml += this.renderAddedLine(patchLineNum++, line.slice(1));
        } else if (line.startsWith('-')) {
          fullHtml += this.renderRemovedLine(line.slice(1));
        } else {
          // Context line (starts with space) — show as unchanged
          fullHtml += this.renderNormalLine(patchLineNum++, line.slice(1));
        }
      }
      fullHtml += `</div>`; // Close patch-block
      
      currentLiveLine = patch.modifiedStartLine + patch.modifiedLineCount;
    }

    // 3. Remaining unchanged lines
    while (currentLiveLine <= liveLines.length) {
      fullHtml += this.renderNormalLine(currentLiveLine, liveLines[currentLiveLine - 1]);
      currentLiveLine++;
    }

    const titleText = path.basename(patches[0].filePath);
    const subtitleText = readOnly 
      ? `Agent: ${agentName} &bull; Reviewed changes`
      : `Agent: ${agentName} &bull; ${patches.length} pending changes`;

    const headerActions = readOnly ? '' : `
      <div class="actions">
        <button class="btn-reject" onclick="sendMessage('rejectAll')">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
          Reject All
        </button>
        <button class="btn-accept" onclick="sendMessage('acceptAll')">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>
          Accept All
        </button>
      </div>
    `;

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Review Changes</title>
  <style>
    :root {
      --bg-color: var(--vscode-editor-background);
      --text-color: var(--vscode-editor-foreground);
      --accent-color: var(--vscode-button-background);
      --accent-hover: var(--vscode-button-hoverBackground);
      --border-color: rgba(150, 150, 150, 0.2);
    }
    
    body {
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif);
      color: var(--text-color);
      background-color: var(--bg-color);
      padding: 0;
      margin: 0;
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
    }

    .sticky-header {
      position: sticky;
      top: 0;
      z-index: 100;
      background: var(--bg-color);
      border-bottom: 1px solid var(--border-color);
      padding: 16px 24px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
    }

    .header-title {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    h1 {
      margin: 0;
      font-size: 18px;
      font-weight: 600;
    }

    .meta-info {
      font-size: 12px;
      opacity: 0.7;
    }

    .actions {
      display: flex;
      gap: 12px;
    }

    button {
      padding: 8px 16px;
      border-radius: 4px;
      font-weight: 600;
      font-size: 13px;
      cursor: pointer;
      border: 1px solid transparent;
      display: flex;
      align-items: center;
      gap: 6px;
      transition: all 0.2s ease;
    }

    .btn-accept {
      background-color: #2ea043;
      color: #ffffff;
    }

    .btn-accept:hover {
      background-color: #2c974b;
    }

    .btn-reject {
      background-color: transparent;
      border-color: var(--border-color);
      color: var(--text-color);
    }

    .btn-reject:hover {
      background-color: rgba(248, 81, 73, 0.1);
      border-color: #f85149;
      color: #f85149;
    }

    .scroll-container {
      flex: 1;
      overflow-y: auto;
      padding: 0;
    }

    .diff-container {
      font-family: var(--vscode-editor-font-family, "Courier New", Courier, monospace);
      font-size: var(--vscode-editor-font-size, 13px);
      line-height: 1.5;
      padding: 16px 0;
      overflow-x: auto;
    }

    .diff-line {
      display: flex;
      padding: 0 16px 0 0;
    }

    .line-num {
      width: 50px;
      flex-shrink: 0;
      user-select: none;
      color: var(--vscode-editorLineNumber-foreground, #858585);
      text-align: right;
      padding-right: 16px;
      font-size: 0.9em;
    }

    .diff-char {
      width: 20px;
      flex-shrink: 0;
      user-select: none;
      opacity: 0.5;
    }

    .diff-content {
      white-space: pre;
      flex: 1;
    }

    .diff-line.added {
      background-color: rgba(46, 160, 67, 0.15);
    }
    .diff-line.added .diff-content, .diff-line.added .diff-char {
      color: #7ee787;
    }

    .diff-line.removed {
      background-color: rgba(248, 81, 73, 0.15);
    }
    .diff-line.removed .diff-content, .diff-line.removed .diff-char {
      color: #ff7b72;
    }

    .diff-line.normal {
      opacity: 0.8;
    }

    /* Individual Hunk Hover Styles */
    .patch-block {
      position: relative;
      border: 1px solid transparent;
      border-radius: 4px;
      margin: 8px 0;
      transition: all 0.2s ease;
    }
    
    .patch-block:hover {
      border-color: var(--border-color);
      background-color: rgba(128, 128, 128, 0.03);
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
    }

    .patch-actions {
      position: absolute;
      top: 6px;
      right: 12px;
      display: none;
      gap: 8px;
      z-index: 10;
    }

    .patch-block:hover .patch-actions {
      display: flex;
    }

    .btn-accept-hunk {
      background-color: #2ea043;
      color: #ffffff;
      border: none;
      padding: 4px 10px;
      font-size: 11px;
      border-radius: 3px;
      cursor: pointer;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 4px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.15);
    }
    
    .btn-accept-hunk:hover {
      background-color: #2c974b;
    }

    .btn-reject-hunk {
      background-color: #f85149;
      color: #ffffff;
      border: none;
      padding: 4px 10px;
      font-size: 11px;
      border-radius: 3px;
      cursor: pointer;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 4px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.15);
    }

    .btn-reject-hunk:hover {
      background-color: #da3633;
    }
  </style>
</head>
<body>
  <div class="sticky-header">
    <div class="header-title">
      <h1>${this.escapeHtml(titleText)}</h1>
      <span class="meta-info">${subtitleText}</span>
    </div>
    ${headerActions}
  </div>
  
  <div class="scroll-container">
    <div class="diff-container">
      ${fullHtml}
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const patchIds = ${patchIdsStr};
    
    function sendMessage(action) {
      vscode.postMessage({
        command: action,
        patchIds: patchIds
      });
    }

    function acceptHunk(patchId) {
      vscode.postMessage({
        command: 'acceptHunk',
        patchId: patchId
      });
    }

    function rejectHunk(patchId) {
      vscode.postMessage({
        command: 'rejectHunk',
        patchId: patchId
      });
    }
  </script>
</body>
</html>`;
  }

  private renderNormalLine(lineNum: number, text: string): string {
    return `<div class="diff-line normal"><span class="line-num">${lineNum}</span><span class="diff-char"> </span><span class="diff-content">${this.escapeHtml(text)}</span></div>`;
  }

  private renderAddedLine(lineNum: number, text: string): string {
    return `<div class="diff-line added"><span class="line-num">${lineNum}</span><span class="diff-char">+</span><span class="diff-content">${this.escapeHtml(text)}</span></div>`;
  }

  private renderRemovedLine(text: string): string {
    return `<div class="diff-line removed"><span class="line-num"></span><span class="diff-char">-</span><span class="diff-content">${this.escapeHtml(text)}</span></div>`;
  }

  private escapeHtml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
}
