import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  BridgeConnectionState,
  BridgeStatusPayload,
  TelemetryLogEntry,
  TelemetryPacket,
  VideoSourceType,
} from '../core/types';

const MAX_LOG_LINES = 200;

export interface UseBridgeSocketReturn {
  bridgeState: BridgeConnectionState;
  bridgeStatus: BridgeStatusPayload | null;
  logs: TelemetryLogEntry[];
  logsPaused: boolean;
  setLogsPaused: (paused: boolean) => void;
  clearLogs: () => void;
  appendLog: (
    category: TelemetryLogEntry['category'],
    level: TelemetryLogEntry['level'],
    summary: string,
    payload?: unknown,
  ) => void;
  sendTelemetry: (packet: TelemetryPacket, isStateChange: boolean) => void;
  notifySourceChange: (source: VideoSourceType) => void;
  publishLatencyMs: number | null;
  authRequired: boolean;
  accessToken: string;
  setAccessToken: (token: string) => void;
  refreshStatus: () => Promise<void>;
  apiFetch: (url: string, init?: RequestInit) => Promise<Response>;
}

export function useBridgeSocket(): UseBridgeSocketReturn {
  const [bridgeState, setBridgeState] = useState<BridgeConnectionState>('reconnecting');
  const [bridgeStatus, setBridgeStatus] = useState<BridgeStatusPayload | null>(null);
  const [logs, setLogs] = useState<TelemetryLogEntry[]>([]);
  const [logsPaused, setLogsPaused] = useState(false);
  const [publishLatencyMs, setPublishLatencyMs] = useState<number | null>(null);
  const [authRequired, setAuthRequired] = useState(false);
  // Access token is kept strictly in React memory (never persisted to localStorage)
  const [accessToken, setAccessToken] = useState('');

  const wsRef = useRef<WebSocket | null>(null);
  const logsPausedRef = useRef(false);
  const reconnectTimerRef = useRef<number | null>(null);
  const backoffRef = useRef(1000);
  const tokenRef = useRef('');

  useEffect(() => {
    logsPausedRef.current = logsPaused;
  }, [logsPaused]);

  useEffect(() => {
    tokenRef.current = accessToken;
  }, [accessToken]);

  const pushLogEntry = useCallback((entry: TelemetryLogEntry) => {
    if (logsPausedRef.current) return;
    setLogs((prev) => {
      const next = [...prev, entry];
      return next.length > MAX_LOG_LINES ? next.slice(next.length - MAX_LOG_LINES) : next;
    });
  }, []);

  const appendLog = useCallback(
    (
      category: TelemetryLogEntry['category'],
      level: TelemetryLogEntry['level'],
      summary: string,
      payload?: unknown,
    ) => {
      pushLogEntry({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        timestamp: new Date().toISOString(),
        category,
        level,
        summary,
        payload,
      });
    },
    [pushLogEntry],
  );

  const clearLogs = useCallback(() => {
    setLogs([]);
  }, []);

  const apiFetch = useCallback(async (url: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (tokenRef.current) {
      headers.set('Authorization', `Bearer ${tokenRef.current}`);
    }
    const res = await fetch(url, { ...init, headers });
    if (res.status === 401) {
      setAuthRequired(true);
    } else if (res.ok) {
      setAuthRequired(false);
    }
    return res;
  }, []);

  const refreshStatus = useCallback(async () => {
    try {
      const res = await apiFetch('/api/status');
      if (res.ok) {
        const data = (await res.json()) as BridgeStatusPayload;
        setBridgeStatus(data);
      }
    } catch {
      // ignore transient network errors
    }
  }, [apiFetch]);

  useEffect(() => {
    let active = true;

    const connect = () => {
      if (!active) return;
      if (wsRef.current) {
        try {
          wsRef.current.close();
        } catch {
          // ignore
        }
      }

      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const tokenParam = tokenRef.current
        ? `?token=${encodeURIComponent(tokenRef.current)}`
        : '';
      const wsUrl = `${protocol}//${window.location.host}/ws${tokenParam}`;

      setBridgeState('reconnecting');
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        if (!active) return;
        backoffRef.current = 1000;
        setBridgeState('connected');
        setAuthRequired(false);
      };

      ws.onmessage = (event) => {
        if (!active) return;
        try {
          const msg = JSON.parse(String(event.data)) as Record<string, unknown>;
          if (msg.type === 'bridge:status' && msg.status) {
            setBridgeStatus(msg.status as BridgeStatusPayload);
          } else if (msg.type === 'bridge:log' && msg.entry) {
            pushLogEntry(msg.entry as TelemetryLogEntry);
          } else if (msg.type === 'telemetry:ack' && typeof msg.sentAt === 'number') {
            const rtt = Math.max(1, Math.round(performance.now() - msg.sentAt));
            setPublishLatencyMs(rtt);
          }
        } catch {
          // ignore malformed frames
        }
      };

      ws.onclose = () => {
        if (!active) return;
        setBridgeState('disconnected');
        const delay = backoffRef.current;
        backoffRef.current = Math.min(8000, backoffRef.current * 1.5);
        reconnectTimerRef.current = window.setTimeout(connect, delay);
      };

      ws.onerror = () => {
        // Check if /api/status returns 401 so we can prompt for LAN access token
        void refreshStatus();
      };
    };

    void refreshStatus();
    connect();

    return () => {
      active = false;
      if (reconnectTimerRef.current !== null) {
        clearTimeout(reconnectTimerRef.current);
      }
      if (wsRef.current) {
        try {
          wsRef.current.close();
        } catch {
          // ignore
        }
      }
    };
  }, [accessToken, pushLogEntry, refreshStatus]);

  const sendTelemetry = useCallback((packet: TelemetryPacket, isStateChange: boolean) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(
      JSON.stringify({
        type: 'telemetry',
        isStateChange,
        sentAt: performance.now(),
        payload: packet,
      }),
    );
  }, []);

  const notifySourceChange = useCallback((source: VideoSourceType) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'source:change', source }));
  }, []);

  return {
    bridgeState,
    bridgeStatus,
    logs,
    logsPaused,
    setLogsPaused,
    clearLogs,
    appendLog,
    sendTelemetry,
    notifySourceChange,
    publishLatencyMs,
    authRequired,
    accessToken,
    setAccessToken,
    refreshStatus,
    apiFetch,
  };
}
