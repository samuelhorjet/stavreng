import * as vscode from 'vscode';
import { PatchesRepository } from '../db/patches.js';

export class GutterDecorator {
  private aiAddedDecoration: vscode.TextEditorDecorationType;
  private aiModifiedDecoration: vscode.TextEditorDecorationType;
  private aiRemovedDecoration: vscode.TextEditorDecorationType;

  constructor(
    patchesRepo: PatchesRepository
  ) {
    this.aiAddedDecoration = vscode.window.createTextEditorDecorationType({});
    this.aiModifiedDecoration = vscode.window.createTextEditorDecorationType({});
    this.aiRemovedDecoration = vscode.window.createTextEditorDecorationType({});
    void patchesRepo;
  }

  /**
   * Refreshes the gutter decorations for the given editor.
   * Clears all decorations to keep the editor clean.
   */
  public refresh(editor: vscode.TextEditor | undefined): void {
    if (!editor) return;
    editor.setDecorations(this.aiAddedDecoration, []);
    editor.setDecorations(this.aiModifiedDecoration, []);
    editor.setDecorations(this.aiRemovedDecoration, []);
  }
}

