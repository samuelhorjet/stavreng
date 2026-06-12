import { SafeDatabase } from './engine.js';
import { Patch } from './types.js';

export class PatchesRepository {
  constructor(private db: SafeDatabase) {}

  public create(patch: Patch): void {
    this.db.getPatches().push(patch);
    this.db.save();
  }

  public getPatches(): Patch[] {
    return this.db.getPatches();
  }

  public getById(id: string): Patch | undefined {
    return this.db.getPatches().find(p => p.id === id);
  }

  public getBySession(sessionId: string): Patch[] {
    return this.db.getPatches().filter(p => p.sessionId === sessionId);
  }

  public getByFileAndSession(filePath: string, sessionId: string): Patch[] {
    return this.db.getPatches().filter(
      p => p.filePath === filePath && p.sessionId === sessionId
    );
  }

  public updateStatus(id: string, status: Patch['status']): void {
    const patch = this.getById(id);
    if (patch) {
      patch.status = status;
      this.db.save();
    }
  }

  public delete(id: string): void {
    const patches = this.db.getPatches();
    const index = patches.findIndex(p => p.id === id);
    if (index !== -1) {
      patches.splice(index, 1);
      this.db.save();
    }
  }

  public deleteBySession(sessionId: string): void {
    const patches = this.db.getPatches();
    const filtered = patches.filter(p => p.sessionId !== sessionId);
    patches.length = 0;
    patches.push(...filtered);
    this.db.save();
  }
}
