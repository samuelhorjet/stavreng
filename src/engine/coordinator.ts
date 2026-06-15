import { SessionsRepository } from '../db/sessions.js';
import { WorkspaceWatcher } from './watcher.js';
import { Session } from '../db/types.js';

export class SessionCoordinator {
  private activeSession: Session | null = null;

  constructor(
    private sessionsRepo: SessionsRepository,
    private watcher: WorkspaceWatcher
  ) {}

  /**
   * Starts a new Stavreng tracking session.
   *
   * After ending the old session, re-snapshots the workspace so the cache
   * reflects the current state of all files BEFORE this session's agent
   * begins editing. The isReady gate in handleFileChange prevents any FSW
   * events from being processed until the snapshot completes.
   */
  public async startSession(agentName: string, workspacePath: string): Promise<Session> {
    // End any existing active sessions
    const active = this.sessionsRepo.getActiveSession();
    if (active) {
      this.stopSession(active.id);
    }

    const sessionId = `session_${Date.now()}`;
    const newSession: Session = {
      id: sessionId,
      agentName,
      status: 'ACTIVE',
      startedAt: new Date().toISOString(),
      endedAt: null,
      workspacePath
    };

    this.sessionsRepo.create(newSession);
    this.activeSession = newSession;

    // Start watcher then take a fresh snapshot.
    // The isReady gate holds FSW events until the snapshot finishes.
    this.watcher.start();
    await this.watcher.refreshSnapshot();

    return newSession;
  }

  /**
   * Resumes the most recent session.
   */
  public async resumeLastSession(): Promise<Session | null> {
    const active = this.sessionsRepo.getActiveSession();
    const sessions = this.sessionsRepo.list().sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    if (sessions.length === 0) return null;

    const lastSession = sessions[0];
    if (active && active.id === lastSession.id) {
      return active;
    }

    if (active) {
      this.stopSession(active.id);
    }

    this.sessionsRepo.updateStatus(lastSession.id, 'ACTIVE', null);

    lastSession.status = 'ACTIVE';
    lastSession.endedAt = null;
    this.activeSession = lastSession;

    this.watcher.start();
    await this.watcher.refreshSnapshot();

    return lastSession;
  }

  /**
   * Stops tracking for a specific session (or the currently active session).
   */
  public stopSession(sessionId?: string): void {
    const targetId = sessionId || (this.activeSession ? this.activeSession.id : null);
    if (!targetId) return;

    this.sessionsRepo.updateStatus(targetId, 'COMPLETED', new Date().toISOString());

    if (this.activeSession && this.activeSession.id === targetId) {
      this.activeSession = null;
      this.watcher.stop();
    }
  }

  public getActiveSession(): Session | null {
    if (!this.activeSession) {
      const active = this.sessionsRepo.getActiveSession();
      if (active) {
        this.activeSession = active;
        this.watcher.start();
      }
    }
    return this.activeSession;
  }
}
