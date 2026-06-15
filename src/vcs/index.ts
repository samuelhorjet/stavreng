/**
 * src/vcs/index.ts — re-exports everything from the vcs/ subsystem.
 * Import from here in extension.ts and watcher.ts.
 */
export { StringEditTracker } from './stringEditTracker.js';
export { HunkRollbackExecutor } from './rollback.js';
