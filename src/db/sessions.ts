import { SafeDatabase } from './engine.js';
import { Session } from './types.js';

export class SessionsRepository {
  constructor(private db: SafeDatabase) {}

  public create(session: Session): void {
    this.db.getSessions().push(session);
    this.db.save();
  }

  public getById(id: string): Session | undefined {
    return this.db.getSessions().find(s => s.id === id);
  }

  public getActiveSession(): Session | undefined {
    return this.db.getSessions().find(s => s.status === 'ACTIVE');
  }

  public updateStatus(id: string, status: Session['status'], endedAt?: string): void {
    const session = this.getById(id);
    if (session) {
      session.status = status;
      if (endedAt) {
        session.endedAt = endedAt;
      }
      this.db.save();
    }
  }

  public list(): Session[] {
    return this.db.getSessions();
  }

  public delete(id: string): void {
    const sessions = this.db.getSessions();
    const index = sessions.findIndex(s => s.id === id);
    if (index !== -1) {
      sessions.splice(index, 1);
      this.db.save();
    }
  }
}
