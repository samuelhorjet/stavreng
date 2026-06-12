import { SessionsRepository } from '../db/sessions.js';
import { WorkspaceWatcher } from './watcher.js';
import { HumanTracker } from './tracker.js';
import { Session } from '../db/types.js';

export class SessionCoordinator {
  private activeSession: Session | null = null;

  constructor(
    private sessionsRepo: SessionsRepository,
    private watcher: WorkspaceWatcher,
    private tracker: HumanTracker
  ) {}

  /**
   * Starts a new Stavreng tracking session.
   */
  public startSession(agentName: string, workspacePath: string): Session {
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

    // Start monitoring
    this.watcher.start();
    this.tracker.start();

    return newSession;
  }

  /**
   * Resumes the most recent session.
   */
  public resumeLastSession(): Session | null {
    // End any existing active sessions
    const active = this.sessionsRepo.getActiveSession();
    if (active) {
      this.stopSession(active.id);
    }

    const sessions = this.sessionsRepo.list().sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    if (sessions.length === 0) return null;

    const lastSession = sessions[0];
    this.sessionsRepo.updateStatus(lastSession.id, 'ACTIVE');
    
    // Refresh the in-memory object
    lastSession.status = 'ACTIVE';
    lastSession.endedAt = null;
    this.activeSession = lastSession;

    // Start monitoring
    this.watcher.start();
    this.tracker.start();

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
      this.tracker.stop();
    }
  }

  public getActiveSession(): Session | null {
    if (!this.activeSession) {
      const active = this.sessionsRepo.getActiveSession();
      if (active) {
        this.activeSession = active;
        // Resume watching/tracking
        this.watcher.start();
        this.tracker.start();
      }
    }
    return this.activeSession;
  }
}
