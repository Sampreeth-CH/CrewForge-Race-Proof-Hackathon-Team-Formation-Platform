import { Request, Response } from 'express';
import { DatabaseManager } from '../db/client.ts';

export const CREWFORGE_CHANNEL = 'crewforge_events';

export type RealtimeEventType =
  | 'TEAM_CREATED'
  | 'TEAM_UPDATED'
  | 'MEMBER_JOINED'
  | 'MEMBER_LEFT'
  | 'MEMBER_REMOVED'
  | 'LEADER_CHANGED'
  | 'TEAM_DELETED'
  | 'JOIN_REQUEST_CREATED'
  | 'JOIN_REQUEST_UPDATED';

export interface RealtimeEvent {
  type: RealtimeEventType;
  hackathonId: string;
  teamId: string;
  timestamp: string;
  payload: Record<string, unknown>;
}

export class RealtimeEventHub {
  private clients = new Set<Response>();
  private unlisten: (() => Promise<void>) | null = null;
  private initialized = false;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  async init(db: DatabaseManager): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    this.unlisten = await db.listen(CREWFORGE_CHANNEL, (rawPayload) => {
      this.broadcastRaw(rawPayload);
    });

    this.heartbeatTimer = setInterval(() => {
      for (const client of this.clients) {
        try {
          client.write(': heartbeat\n\n');
        } catch {
          this.clients.delete(client);
        }
      }
    }, 20000);
    if (this.heartbeatTimer.unref) {
      this.heartbeatTimer.unref();
    }
  }

  subscribe(req: Request, res: Response): void {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    this.clients.add(res);
    res.write(
      `event: connected\ndata: ${JSON.stringify({ status: 'connected', timestamp: new Date().toISOString() })}\n\n`
    );

    req.on('close', () => {
      this.clients.delete(res);
    });
  }

  private broadcastRaw(rawPayload: string): void {
    let eventName = 'message';
    try {
      const parsed = JSON.parse(rawPayload) as Partial<RealtimeEvent>;
      if (parsed.type) eventName = parsed.type;
    } catch {
      // Keep default event name
    }

    const frame = `event: ${eventName}\ndata: ${rawPayload}\n\n`;
    for (const client of this.clients) {
      try {
        client.write(frame);
      } catch {
        this.clients.delete(client);
      }
    }
  }

  getClientCount(): number {
    return this.clients.size;
  }

  async shutdown(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.unlisten) {
      await this.unlisten();
      this.unlisten = null;
    }
    for (const client of this.clients) {
      try {
        client.end();
      } catch {
        // Ignore already-closed connections
      }
    }
    this.clients.clear();
    this.initialized = false;
  }
}

export const sseHub = new RealtimeEventHub();
