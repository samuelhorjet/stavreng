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
    const escapedAgentName = this.escapeHtml(agentName);
    const subtitleText = readOnly 
      ? `Agent: ${escapedAgentName} &bull; Reviewed changes`
      : `Agent: ${escapedAgentName} &bull; ${patches.length} pending changes`;

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

    const stylePath = vscode.Uri.joinPath(this.context.extensionUri, 'resources', 'review.css');
    const styleUri = this.panel!.webview.asWebviewUri(stylePath);
    
    const htmlPath = vscode.Uri.joinPath(this.context.extensionUri, 'resources', 'review.html').fsPath;
    let template = '';
    try {
      template = fs.readFileSync(htmlPath, 'utf8');
    } catch (err) {
      return `<!DOCTYPE html><html><body>Error loading review.html template.</body></html>`;
    }

    return template
      .replace('{{cspSource}}', this.panel!.webview.cspSource)
      .replace('{{styleUri}}', styleUri.toString())
      .replace('{{titleText}}', this.escapeHtml(titleText))
      .replace('{{subtitleText}}', subtitleText)
      .replace('{{headerActions}}', headerActions)
      .replace('{{fullHtml}}', fullHtml)
      .replace('{{patchIdsStr}}', patchIdsStr);
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
