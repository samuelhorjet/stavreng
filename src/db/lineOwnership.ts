import { SafeDatabase } from './engine.js';
import { LineOwnership } from './types.js';

export class LineOwnershipRepository {
  constructor(private db: SafeDatabase) {}

  public setOwnership(
    filePath: string,
    lineNumber: number,
    owner: 'HUMAN' | 'AI',
    associatedPatchId: string | null
  ): void {
    const list = this.db.getLineOwnership();
    const index = list.findIndex(
      lo => lo.filePath === filePath && lo.lineNumber === lineNumber
    );

    const record: LineOwnership = {
      filePath,
      lineNumber,
      owner,
      associatedPatchId,
      lastUpdatedAt: Date.now()
    };

    if (index !== -1) {
      list[index] = record;
    } else {
      list.push(record);
    }
    this.db.save();
  }

  public setOwnershipBulk(
    filePath: string,
    lines: { lineNumber: number; owner: 'HUMAN' | 'AI'; associatedPatchId: string | null }[]
  ): void {
    const list = this.db.getLineOwnership();
    const timestamp = Date.now();

    lines.forEach(item => {
      const index = list.findIndex(
        lo => lo.filePath === filePath && lo.lineNumber === item.lineNumber
      );

      const record: LineOwnership = {
        filePath,
        lineNumber: item.lineNumber,
        owner: item.owner,
        associatedPatchId: item.associatedPatchId,
        lastUpdatedAt: timestamp
      };

      if (index !== -1) {
        list[index] = record;
      } else {
        list.push(record);
      }
    });

    this.db.save();
  }

  public getOwnership(filePath: string, lineNumber: number): LineOwnership | undefined {
    return this.db.getLineOwnership().find(
      lo => lo.filePath === filePath && lo.lineNumber === lineNumber
    );
  }

  public getFileOwnership(filePath: string): LineOwnership[] {
    return this.db.getLineOwnership().filter(lo => lo.filePath === filePath);
  }

  public clearOwnershipForFile(filePath: string): void {
    const list = this.db.getLineOwnership();
    const filtered = list.filter(lo => lo.filePath !== filePath);
    
    // Clear array and push filtered back to preserve reference
    list.length = 0;
    list.push(...filtered);
    this.db.save();
  }

  /**
   * Shift line numbers in the register by delta for any lines >= startLine
   */
  public shiftOwnership(filePath: string, startLine: number, delta: number): void {
    if (delta === 0) return;

    const list = this.db.getLineOwnership();

    if (delta < 0) {
      // If we are deleting lines, we remove ownership of deleted lines (startLine to startLine + abs(delta) - 1)
      const absDelta = Math.abs(delta);
      const filtered = list.filter(
        lo => !(lo.filePath === filePath && lo.lineNumber >= startLine && lo.lineNumber < startLine + absDelta)
      );
      list.length = 0;
      list.push(...filtered);
    }

    // Now shift the remaining lines
    const remainingToShift = list.filter(
      lo => lo.filePath === filePath && lo.lineNumber >= (delta < 0 ? startLine : startLine)
    );

    remainingToShift.forEach(lo => {
      // If delta is negative, we already removed deleted lines.
      // If we are shifting, adjust line number.
      if (delta > 0) {
        lo.lineNumber += delta;
      } else {
        lo.lineNumber += delta; // delta is negative here
      }
      lo.lastUpdatedAt = Date.now();
    });

    this.db.save();
  }

  public deleteByPatchIds(patchIds: Set<string>): void {
    const list = this.db.getLineOwnership();
    const filtered = list.filter(lo => !lo.associatedPatchId || !patchIds.has(lo.associatedPatchId));
    list.length = 0;
    list.push(...filtered);
    this.db.save();
  }
}
