import * as fs from 'fs';
import * as path from 'path';
import { DatabaseSchema, Session, FileState, Patch } from './types.js';
import { normalizePath } from './pathUtils.js';

export class SafeDatabase {
  private dbPath: string;
  private metadataDir: string;
  private schema: DatabaseSchema;

  constructor(storagePath: string) {
    this.metadataDir = storagePath;
    this.dbPath = path.join(this.metadataDir, 'db.json');
    this.schema = {
      sessions: [],
      fileStates: [],
      patches: []
    };
    this.init();
  }

  private init() {
    if (!fs.existsSync(this.metadataDir)) {
      fs.mkdirSync(this.metadataDir, { recursive: true });
    }
    
    const journalDir = path.join(this.metadataDir, 'journal');
    if (!fs.existsSync(journalDir)) {
      fs.mkdirSync(journalDir, { recursive: true });
    }

    if (fs.existsSync(this.dbPath)) {
      try {
        const raw = fs.readFileSync(this.dbPath, 'utf8');
        const parsed = JSON.parse(raw);
        
        // Self-heal/normalize all paths from database on startup
        const sessions = (parsed.sessions || []).map((s: any) => ({
          ...s,
          workspacePath: normalizePath(s.workspacePath)
        }));
        const fileStates = (parsed.fileStates || []).map((fsState: any) => ({
          ...fsState,
          filePath: normalizePath(fsState.filePath)
        }));
        const patches = (parsed.patches || []).map((p: any) => ({
          ...p,
          filePath: normalizePath(p.filePath)
        }));

        this.schema = { sessions, fileStates, patches };
        this.save(); // Save the cleaned/normalized records back to disk
      } catch (err) {
        console.error('Stavreng DB initialization failed, recreating database', err);
        this.save();
      }
    } else {
      this.save();
    }
  }

  public save() {
    try {
      const tempPath = this.dbPath + '.tmp';
      fs.writeFileSync(tempPath, JSON.stringify(this.schema, null, 2), 'utf8');
      fs.renameSync(tempPath, this.dbPath);
    } catch (err) {
      console.error('Stavreng DB save failed', err);
    }
  }

  // Getters for Schema Collections
  public getSessions(): Session[] {
    return this.schema.sessions;
  }

  public getFileStates(): FileState[] {
    return this.schema.fileStates;
  }

  public getPatches(): Patch[] {
    return this.schema.patches;
  }
}
