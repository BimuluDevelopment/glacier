import type { WebSocket } from 'ws';
import { errors as joseErrors } from 'jose';
import {
  POWER_ACTIONS,
  WS_EVENTS,
  hasPermission,
  type PowerAction,
  type ServerPermission,
  type WebsocketTokenClaims,
  type WsMessage,
} from '@glacier/shared';
import type { DaemonConfig } from '../config';
import { verifyPanelToken } from '../lib/jwt';
import type { Logger } from '../logger';
import type { ServerInstance } from '../server/server';

const AUTH_TIMEOUT_MS = 10_000;
const EXPIRY_WARNING_MS = 60_000;
const MAX_MESSAGES_PER_SECOND = 20;
const MAX_MESSAGE_BYTES = 8 * 1024;

/**
 * One browser console connection. The browser authenticates with a panel-signed JWT and
 * re-authenticates with a fresh token before it expires; permissions come from the token.
 */
export function handleConsoleSocket(socket: WebSocket, server: ServerInstance, config: DaemonConfig, log: Logger) {
  let permissions: string[] | null = null;
  let userId: string | null = null;
  let expiryTimers: NodeJS.Timeout[] = [];
  let windowStart = Date.now();
  let messagesInWindow = 0;

  const send = (event: string, ...args: string[]) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ event, args } satisfies WsMessage));
  };
  const can = (p: ServerPermission) => permissions !== null && hasPermission(permissions, p);

  const authTimer = setTimeout(() => {
    if (!permissions) socket.close(4001, 'Authentication timed out');
  }, AUTH_TIMEOUT_MS);

  const listeners = {
    console: (line: string) => can('control.console') && send(WS_EVENTS.CONSOLE_OUTPUT, line),
    install: (line: string) => can('control.console') && send(WS_EVENTS.INSTALL_OUTPUT, line),
    state: (state: string) => permissions && send(WS_EVENTS.STATUS, state),
    stats: (usage: unknown) => permissions && send(WS_EVENTS.STATS, JSON.stringify(usage)),
    message: (text: string) => can('control.console') && send(WS_EVENTS.DAEMON_MESSAGE, text),
    'install-started': () => permissions && send(WS_EVENTS.INSTALL_STARTED),
    'install-completed': (ok: boolean) => permissions && send(WS_EVENTS.INSTALL_COMPLETED, String(ok)),
    'backup-completed': (backup: string, ok: boolean) => permissions && send(WS_EVENTS.BACKUP_COMPLETED, backup, String(ok)),
    'restore-completed': (backup: string, ok: boolean) => permissions && send(WS_EVENTS.BACKUP_RESTORE_COMPLETED, backup, String(ok)),
    deny: (users: string[]) => {
      if (userId && users.includes(userId)) {
        permissions = null;
        send(WS_EVENTS.JWT_ERROR, 'Your access to this server was changed.');
        socket.close(4005, 'Access revoked');
      }
    },
  };
  for (const [event, fn] of Object.entries(listeners)) server.on(event as any, fn as any);

  async function authenticate(token: string) {
    try {
      const payload = await verifyPanelToken<WebsocketTokenClaims>(token, config);
      if (payload.server !== server.uuid) throw new Error('Token is for a different server');
      if (!server.tokenAllowed(payload.sub, payload.iat)) throw new Error('This token has been revoked');
      const firstAuth = permissions === null;
      userId = payload.sub;
      permissions = Array.isArray(payload.permissions) ? payload.permissions : [];
      clearTimeout(authTimer);
      scheduleExpiry((payload.exp ?? 0) * 1000);
      send(WS_EVENTS.AUTH_SUCCESS);
      if (firstAuth) send(WS_EVENTS.STATUS, server.installing ? 'installing' : server.state);
    } catch (err) {
      const expired = err instanceof joseErrors.JWTExpired;
      send(expired ? WS_EVENTS.TOKEN_EXPIRED : WS_EVENTS.JWT_ERROR, (err as Error).message);
      if (!permissions) socket.close(4001, 'Authentication failed');
    }
  }

  function scheduleExpiry(expiresAt: number) {
    expiryTimers.forEach(clearTimeout);
    const now = Date.now();
    expiryTimers = [
      setTimeout(() => send(WS_EVENTS.TOKEN_EXPIRING), Math.max(0, expiresAt - now - EXPIRY_WARNING_MS)),
      setTimeout(() => {
        permissions = null;
        send(WS_EVENTS.TOKEN_EXPIRED);
        socket.close(4004, 'Token expired');
      }, Math.max(0, expiresAt - now)),
    ];
  }

  socket.on('message', async (raw: Buffer, isBinary: boolean) => {
    if (isBinary || raw.length > MAX_MESSAGE_BYTES) return;
    const now = Date.now();
    if (now - windowStart > 1000) {
      windowStart = now;
      messagesInWindow = 0;
    }
    if (++messagesInWindow > MAX_MESSAGES_PER_SECOND) return;

    let msg: WsMessage;
    try {
      msg = JSON.parse(raw.toString('utf8'));
    } catch {
      return;
    }
    const arg = msg.args?.[0] ?? '';

    if (msg.event === WS_EVENTS.AUTH) return authenticate(arg);
    if (!permissions) return;

    try {
      switch (msg.event) {
        case WS_EVENTS.SEND_LOGS:
          if (can('control.console')) for (const line of server.consoleHistory) send(WS_EVENTS.CONSOLE_OUTPUT, line);
          break;
        case WS_EVENTS.SEND_STATS:
          send(WS_EVENTS.STATS, JSON.stringify(server.resources()));
          break;
        case WS_EVENTS.SEND_COMMAND:
          if (!can('control.command')) return send(WS_EVENTS.DAEMON_ERROR, 'You cannot send commands to this server.');
          server.sendCommand(arg);
          break;
        case WS_EVENTS.SET_STATE: {
          if (!(POWER_ACTIONS as string[]).includes(arg)) return;
          const action = arg as PowerAction;
          if (!can(`control.${action}` as ServerPermission)) return send(WS_EVENTS.DAEMON_ERROR, `You cannot ${action} this server.`);
          await server.power(action);
          break;
        }
      }
    } catch (err) {
      send(WS_EVENTS.DAEMON_ERROR, (err as Error).message);
    }
  });

  socket.on('close', () => {
    clearTimeout(authTimer);
    expiryTimers.forEach(clearTimeout);
    for (const [event, fn] of Object.entries(listeners)) server.off(event as any, fn as any);
  });
  socket.on('error', (err) => log.debug({ err }, 'websocket error'));
}
