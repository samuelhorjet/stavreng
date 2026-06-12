import * as vscode from 'vscode';
import { LineOwnershipRepository } from '../db/lineOwnership.js';
import { normalizePath } from '../db/pathUtils.js';

export class HumanTracker {
  private disposable: vscode.Disposable | null = null;

  constructor(private lineOwnershipRepo: LineOwnershipRepository) {}

  public start(): void {
    if (this.disposable) return;

    this.disposable = vscode.workspace.onDidChangeTextDocument(event => {
      const document = event.document;
      // Skip tracking of files inside .stavreng
      if (document.uri.fsPath.includes('.stavreng')) return;

      // Skip events with no actual content changes.
      // VS Code fires a zero-change event when it reloads a file from disk after an
      // external write — this is NOT a user edit, so we must ignore it.
      if (event.contentChanges.length === 0) return;

      // If the document is not dirty after the change, VS Code treated this as a
      // programmatic/external update (e.g. reload from disk). Skip it.
      if (!document.isDirty) return;

      const filePath = normalizePath(document.uri.fsPath);

      event.contentChanges.forEach(change => {
        const startLine = change.range.start.line + 1; // 1-indexed
        const endLine = change.range.end.line + 1; // 1-indexed
        const deletedLinesCount = endLine - startLine;
        
        // Count newlines in inserted text
        const insertedLines = change.text.split('\n');
        const insertedLinesCount = insertedLines.length - 1;
        
        // Calculate delta (positive for additions, negative for deletions)
        const delta = insertedLinesCount - deletedLinesCount;

        // 1. Shift existing records
        if (delta !== 0) {
          this.lineOwnershipRepo.shiftOwnership(filePath, startLine + deletedLinesCount, delta);
        }

        // 2. Mark newly inserted/modified lines as HUMAN owned
        const newLinesCount = insertedLines.length;
        const humanLines: { lineNumber: number; owner: 'HUMAN'; associatedPatchId: null }[] = [];
        for (let i = 0; i < newLinesCount; i++) {
          humanLines.push({
            lineNumber: startLine + i,
            owner: 'HUMAN',
            associatedPatchId: null
          });
        }
        
        if (humanLines.length > 0) {
          this.lineOwnershipRepo.setOwnershipBulk(filePath, humanLines);
        }
      });
    });
  }

  public stop(): void {
    if (this.disposable) {
      this.disposable.dispose();
      this.disposable = null;
    }
  }
}
