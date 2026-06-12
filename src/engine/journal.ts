import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

export class JournalManager {
  private journalDir: string;

  constructor(storagePath: string) {
    this.journalDir = path.join(storagePath, 'journal');
    this.init();
  }

  private init() {
    if (!fs.existsSync(this.journalDir)) {
      fs.mkdirSync(this.journalDir, { recursive: true });
    }
  }

  /**
   * Calculates the SHA256 of a string content.
   */
  public calculateHash(content: string): string {
    return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
  }

  /**
   * Creates a backup of a file's current content.
   * Returns the SHA256 hash of the content.
   */
  public createBackup(_filePath: string, content: string): string {
    const sha256 = this.calculateHash(content);
    const backupPath = path.join(this.journalDir, `${sha256}.base`);

    if (!fs.existsSync(backupPath)) {
      fs.writeFileSync(backupPath, content, 'utf8');
    }
    return sha256;
  }

  /**
   * Gets the content of a backup by its hash.
   */
  public getBackupContent(sha256: string): string | null {
    const backupPath = path.join(this.journalDir, `${sha256}.base`);
    if (fs.existsSync(backupPath)) {
      return fs.readFileSync(backupPath, 'utf8');
    }
    return null;
  }

  /**
   * Checks if a backup exists.
   */
  public hasBackup(sha256: string): boolean {
    const backupPath = path.join(this.journalDir, `${sha256}.base`);
    return fs.existsSync(backupPath);
  }

  /**
   * Deletes a backup by hash.
   */
  public deleteBackup(sha256: string): void {
    const backupPath = path.join(this.journalDir, `${sha256}.base`);
    if (fs.existsSync(backupPath)) {
      fs.unlinkSync(backupPath);
    }
  }
}
