import { useCallback, useEffect, useRef, useState } from 'react';
import { WS_EVENTS, type PowerAction, type ServerResourceUsage, type WsMessage } from '@glacier/shared';
import { api } from '../../lib/api';

export type SocketState = 'connecting' | 'connected' | 'disconnected' | 'error';
/** `clear` is sent when a (re)connection is about to replay the console history. */
export type Line = { kind: 'console' | 'install' | 'daemon' | 'error' | 'clear'; text: string };

interface Credentials {
  token: string;
  socket: string;
}

/**
 * Connects straight to the node daemon's console websocket using short-lived credentials from
 * the panel, re-authenticates before the token expires and reconnects with backoff.
 */
export function useServerSocket(serverId: string, onLine: (line: Line) => void) {
  const [socketState, setSocketState] = useState<SocketState>('connecting');
  const [status, setStatus] = useState<string>('offline');
  const [stats, setStats] = useState<ServerResourceUsage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const onLineRef = useRef(onLine);
  onLineRef.current = onLine;

  useEffect(() => {
    let cancelled = false;
    let retry = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    const credentials = () => api.get<Credentials>(`/client/servers/${serverId}/websocket`);

    const connect = async () => {
      setSocketState('connecting');
      let creds: Credentials;
      try {
        creds = await credentials();
      } catch (err) {
        if (cancelled) return;
        setError((err as Error).message);
        setSocketState('error');
        scheduleRetry();
        return;
      }
      if (cancelled) return;

      const ws = new WebSocket(creds.socket);
      socketRef.current = ws;
      let authed = false;
      const send = (event: string, ...args: string[]) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ event, args }));

      ws.onopen = () => send(WS_EVENTS.AUTH, creds.token);
      ws.onmessage = async (ev) => {
        let msg: WsMessage;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        const arg = msg.args?.[0] ?? '';
        switch (msg.event) {
          case WS_EVENTS.AUTH_SUCCESS:
            // Re-authentication with a fresh token also answers "auth success"; only replay once.
            if (authed) break;
            authed = true;
            retry = 0;
            setSocketState('connected');
            setError(null);
            onLineRef.current({ kind: 'clear', text: '' });
            send(WS_EVENTS.SEND_LOGS);
            send(WS_EVENTS.SEND_STATS);
            break;
          case WS_EVENTS.STATUS:
            setStatus(arg);
            break;
          case WS_EVENTS.STATS:
            try {
              const s = JSON.parse(arg) as ServerResourceUsage;
              setStats(s);
              setStatus((cur) => (cur === 'installing' ? cur : s.state));
            } catch {
              // ignore malformed stats
            }
            break;
          case WS_EVENTS.CONSOLE_OUTPUT:
            onLineRef.current({ kind: 'console', text: arg });
            break;
          case WS_EVENTS.INSTALL_OUTPUT:
            onLineRef.current({ kind: 'install', text: arg });
            break;
          case WS_EVENTS.INSTALL_STARTED:
            setStatus('installing');
            onLineRef.current({ kind: 'daemon', text: 'Installation started.' });
            break;
          case WS_EVENTS.INSTALL_COMPLETED:
            setStatus('offline');
            onLineRef.current({ kind: 'daemon', text: arg === 'true' ? 'Installation completed.' : 'Installation failed.' });
            break;
          case WS_EVENTS.DAEMON_MESSAGE:
            onLineRef.current({ kind: 'daemon', text: arg });
            break;
          case WS_EVENTS.DAEMON_ERROR:
            onLineRef.current({ kind: 'error', text: arg });
            break;
          case WS_EVENTS.TOKEN_EXPIRING:
            try {
              send(WS_EVENTS.AUTH, (await credentials()).token);
            } catch {
              // The socket will close on expiry and reconnect.
            }
            break;
          case WS_EVENTS.JWT_ERROR:
            setError(arg);
            break;
        }
      };
      ws.onerror = () => setSocketState('error');
      ws.onclose = () => {
        if (socketRef.current === ws) socketRef.current = null;
        if (cancelled) return;
        setSocketState('disconnected');
        scheduleRetry();
      };
    };

    const scheduleRetry = () => {
      const delay = Math.min(30_000, 1000 * 2 ** retry++);
      retryTimer = setTimeout(() => void connect(), delay);
    };

    void connect();
    return () => {
      cancelled = true;
      clearTimeout(retryTimer);
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [serverId]);

  const send = useCallback((event: string, ...args: string[]) => {
    const ws = socketRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ event, args }));
  }, []);

  const power = useCallback((action: PowerAction) => send(WS_EVENTS.SET_STATE, action), [send]);
  const command = useCallback((cmd: string) => send(WS_EVENTS.SEND_COMMAND, cmd), [send]);

  return { socketState, status, stats, error, power, command };
}
