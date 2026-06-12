import diff_match_patch_pkg from 'diff-match-patch';

export class SafeMergeEngine {
  private dmp: any;

  constructor() {
    this.dmp = new diff_match_patch_pkg.diff_match_patch();
  }

  /**
   * Reverts the AI changes (Base -> Agent) in the context of subsequent Human modifications (Current).
   * Calculates the difference Agent -> Base (the inverse diff) and applies it to Current.
   */
  public async executeAIReversion(
    baseContent: string,
    agentContent: string,
    currentContent: string
  ): Promise<{ success: boolean; mergedContent: string; hasConflicts: boolean }> {
    try {
      // Step 1: Compute inverse diff (AI content back to Base state)
      const undoDiffs = this.dmp.diff_main(agentContent, baseContent);
      this.dmp.diff_cleanupSemantic(undoDiffs);
      const undoPatches = this.dmp.patch_make(agentContent, undoDiffs);

      // Step 2: Apply inverse patches onto current live file
      const [patchedContent, results] = this.dmp.patch_apply(undoPatches, currentContent);
      const hasConflicts = results.some((success: boolean) => !success);

      return {
        success: true,
        mergedContent: patchedContent,
        hasConflicts
      };
    } catch (err) {
      console.error('Stavreng Merge Reversion failed', err);
      return {
        success: false,
        mergedContent: currentContent,
        hasConflicts: true
      };
    }
  }
}
