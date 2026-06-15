import * as fs from 'fs';
import * as path from 'path';

const DEFAULT_IGNORE_CONTENT = `# .stavreng-ignore
# Stavreng will not track changes to paths matching these patterns.
# Each line is a path segment or glob pattern. Lines starting with # are comments.
# You can commit this file to share ignore rules with your team.
#
# Examples:
#   node_modules/    — ignore a directory
#   *.lock           — ignore all .lock files
#   build/           — ignore a build output directory

# Package managers
node_modules/
.pnp/

# Version control
.git/

# Compiled output & build artifacts
target/
dist/
out/
build/
.next/
.nuxt/
.output/
__pycache__/
*.pyc

# Logs & temporary files
*.log
*.tmp
*.bak
*~

# Lock files (large, not human-edited)
*.lock
package-lock.json
yarn.lock
pnpm-lock.yaml
Cargo.lock

# Database & binary files
*.db
*.db-journal
*.db-wal
*.vsix
*.exe
*.dll
*.bin
*.zip
*.tar
*.gz

# Media files
*.ico
*.png
*.jpg
*.jpeg
*.gif
*.svg
*.mp4
*.webm
*.woff
*.woff2

# IDE / OS metadata
.DS_Store
Thumbs.db
.idea/
.vscode/

# Stavreng internal
.stavreng/
`;

export class IgnoreManager {
  private patterns: string[] = [];
  private ignoreFilePath: string;

  constructor(workspacePath: string) {
    this.ignoreFilePath = path.join(workspacePath, '.stavreng-ignore');
    this.ensureIgnoreFileExists();
    this.loadPatterns();
  }

  /**
   * Creates the .stavreng-ignore file with sensible defaults if it doesn't exist.
   */
  private ensureIgnoreFileExists(): void {
    if (!fs.existsSync(this.ignoreFilePath)) {
      try {
        fs.writeFileSync(this.ignoreFilePath, DEFAULT_IGNORE_CONTENT, 'utf8');
        console.log('[Stavreng] Created default .stavreng-ignore in workspace root.');
      } catch (err) {
        console.error('[Stavreng] Could not create .stavreng-ignore:', err);
      }
    }
  }

  /**
   * Reads and parses .stavreng-ignore into a list of active patterns.
   */
  public loadPatterns(): void {
    try {
      if (!fs.existsSync(this.ignoreFilePath)) {
        this.patterns = [];
        return;
      }
      const lines = fs.readFileSync(this.ignoreFilePath, 'utf8').split(/\r?\n/);
      this.patterns = lines
        .map(l => l.trim())
        .filter(l => l.length > 0 && !l.startsWith('#'));
      console.debug(`[Stavreng] Loaded ${this.patterns.length} ignore pattern(s) from .stavreng-ignore`);
    } catch (err) {
      console.error('[Stavreng] Failed to load .stavreng-ignore:', err);
      this.patterns = [];
    }
  }

  /**
   * Returns true if the given absolute file path matches any ignore pattern.
   * Uses simple substring/suffix matching that covers the vast majority of cases
   * without the overhead of a full glob library.
   */
  public shouldIgnorePath(filePath: string): boolean {
    // Normalize to forward slashes for consistent matching on all platforms
    const normalized = filePath.replace(/\\/g, '/');
    const segments = normalized.split('/');
    
    for (const pattern of this.patterns) {
      // Strip leading wildcards for simple matching
      const clean = pattern.replace(/^\*\*\//, '').replace(/\/$/, '');
      
      if (pattern.startsWith('*.')) {
        // Extension pattern: e.g. *.log, *.lock
        const ext = pattern.slice(1); // ".log"
        if (normalized.endsWith(ext)) return true;
      } else if (pattern.includes('*')) {
        // Simple wildcard: e.g. *.db-journal — check file name portion
        const fileName = segments[segments.length - 1] ?? '';
        const escapedPattern = clean.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
        if (new RegExp(`^${escapedPattern}$`).test(fileName)) return true;
      } else {
        // Directory or file segment: match anywhere in the path, avoiding partial segment matches
        if (clean.includes('/')) {
          if (
            normalized === clean ||
            normalized.startsWith(clean + '/') ||
            normalized.endsWith('/' + clean) ||
            normalized.includes('/' + clean + '/')
          ) return true;
        } else {
          if (segments.includes(clean)) return true;
        }
      }
    }
    return false;
  }

  /**
   * Returns a VS Code glob exclude pattern for use in workspace.findFiles().
   * This prevents the FSW from even loading ignored files into RAM during snapshotting.
   */
  public getExcludeGlob(): string {
    // Build a brace-expanded glob from the patterns. We map each pattern to
    // either a directory glob (**\/pattern\/**) or a file glob (**\/pattern).
    const parts: string[] = [];

    for (const pattern of this.patterns) {
      const clean = pattern.replace(/\/$/, '');
      if (pattern.endsWith('/')) {
        // Directory: **\/node_modules\/**
        parts.push(`**/${clean}/**`);
      } else {
        // File or extension: **\/pattern
        parts.push(`**/${clean}`);
      }
    }

    if (parts.length === 0) return '';
    return `{${parts.join(',')}}`;
  }
}
