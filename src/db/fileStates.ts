import { SafeDatabase } from './engine.js';
import { FileState } from './types.js';

export class FileStatesRepository {
  constructor(private db: SafeDatabase) {}

  public upsert(state: FileState): void {
    const states = this.db.getFileStates();
    const index = states.findIndex(
      fs => fs.filePath === state.filePath && fs.sessionId === state.sessionId
    );

    if (index !== -1) {
      states[index] = state;
    } else {
      states.push(state);
    }
    this.db.save();
  }

  public getByFileAndSession(filePath: string, sessionId: string): FileState | undefined {
    return this.db.getFileStates().find(
      fs => fs.filePath === filePath && fs.sessionId === sessionId
    );
  }

  public getBySession(sessionId: string): FileState[] {
    return this.db.getFileStates().filter(fs => fs.sessionId === sessionId);
  }

  public delete(filePath: string, sessionId: string): void {
    const states = this.db.getFileStates();
    const index = states.findIndex(
      fs => fs.filePath === filePath && fs.sessionId === sessionId
    );
    if (index !== -1) {
      states.splice(index, 1);
      this.db.save();
    }
  }

  public deleteBySession(sessionId: string): void {
    const states = this.db.getFileStates();
    const filtered = states.filter(fs => fs.sessionId !== sessionId);
    states.length = 0;
    states.push(...filtered);
    this.db.save();
  }
}
