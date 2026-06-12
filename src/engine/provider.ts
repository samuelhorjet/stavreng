import * as vscode from 'vscode';
import { JournalManager } from './journal.js';

export class BaseDocumentProvider implements vscode.TextDocumentContentProvider {
  constructor(private journalManager: JournalManager) {}

  /**
   * Provides the content of the file from the baseline journal.
   * URI format: stavreng-base://authority/path?sha256
   */
  public provideTextDocumentContent(uri: vscode.Uri): string | vscode.ProviderResult<string> {
    const sha256 = uri.query;
    if (!sha256) {
      return '';
    }

    const content = this.journalManager.getBackupContent(sha256);
    if (content === null) {
      return '// Baseline file backup content not found in journal';
    }

    return content;
  }
}
