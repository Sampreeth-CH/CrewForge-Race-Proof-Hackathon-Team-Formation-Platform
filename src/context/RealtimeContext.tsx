import React, { createContext, useContext, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { API_BASE } from '../lib/api';

export interface LiveEventItem {
  id: string;
  type: string;
  teamId: string;
  hackathonId: string;
  timestamp: string;
  payload: Record<string, unknown>;
}

interface RealtimeContextValue {
  connected: boolean;
  events: LiveEventItem[];
}

const RealtimeContext = createContext<RealtimeContextValue>({
  connected: false,
  events: [],
});

const EVENT_TYPES = [
  'TEAM_CREATED',
  'TEAM_UPDATED',
  'MEMBER_JOINED',
  'MEMBER_LEFT',
  'MEMBER_REMOVED',
  'LEADER_CHANGED',
  'TEAM_DELETED',
  'JOIN_REQUEST_CREATED',
  'JOIN_REQUEST_UPDATED',
];

export function RealtimeProvider({ children }: { children: React.ReactNode }) {
  const [connected, setConnected] = useState(false);
  const [events, setEvents] = useState<LiveEventItem[]>([]);
  const queryClient = useQueryClient();

  useEffect(() => {
    let source: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    const connect = () => {
      if (closed) return;
      source = new EventSource(`${API_BASE}/events/stream`, { withCredentials: true });

      source.addEventListener('connected', () => {
        setConnected(true);
      });

      const handleEvent = (type: string) => (ev: MessageEvent) => {
        try {
          const parsed = JSON.parse(ev.data) as {
            type: string;
            teamId: string;
            hackathonId: string;
            timestamp: string;
            payload: Record<string, unknown>;
          };
          setEvents((prev) => [
            {
              id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
              type: parsed.type || type,
              teamId: parsed.teamId,
              hackathonId: parsed.hackathonId,
              timestamp: parsed.timestamp || new Date().toISOString(),
              payload: parsed.payload || {},
            },
            ...prev.slice(0, 24),
          ]);
          void queryClient.invalidateQueries({ queryKey: ['teams'] });
          void queryClient.invalidateQueries({ queryKey: ['team', parsed.teamId] });
          void queryClient.invalidateQueries({ queryKey: ['analytics'] });
          void queryClient.invalidateQueries({ queryKey: ['audit-logs'] });
        } catch {
          // Ignore malformed event payloads
        }
      };

      EVENT_TYPES.forEach((eventType) => {
        source?.addEventListener(eventType, handleEvent(eventType));
      });

      source.onerror = () => {
        setConnected(false);
        source?.close();
        if (!closed) {
          reconnectTimer = setTimeout(connect, 2500);
        }
      };
    };

    connect();

    return () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      source?.close();
    };
  }, [queryClient]);

  return (
    <RealtimeContext.Provider value={{ connected, events }}>
      {children}
    </RealtimeContext.Provider>
  );
}

export function useRealtime() {
  return useContext(RealtimeContext);
}
