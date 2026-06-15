export interface Session {
  id: string;
  agentName: string;
  status: 'ACTIVE' | 'PAUSED' | 'COMPLETED' | 'ABANDONED';
  startedAt: string;
  endedAt: string | null;
  workspacePath: string;
}

export interface FileState {
  filePath: string;
  sessionId: string;
  baseSha256: string;
  currentSha256: string;
  lastModified: number;
}

export interface Patch {
  id: string;
  sessionId: string;
  filePath: string;
  status: 'PENDING' | 'ACCEPTED' | 'REJECTED';
  createdAt: number;
  originalStartLine: number;
  originalLineCount: number;
  modifiedStartLine: number;
  modifiedLineCount: number;
  hunkDiff: string;
  rawOriginal: string;
  rawModified: string;
}

export interface DatabaseSchema {
  sessions: Session[];
  fileStates: FileState[];
  patches: Patch[];
}
