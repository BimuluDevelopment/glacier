import { readFileSync } from 'node:fs';
import os from 'node:os';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import type Docker from 'dockerode';
import { z } from 'zod';
import { POWER_ACTIONS, type DaemonSystemInfo, type PowerAction } from '@glacier/shared';
import { panelOrigin, type DaemonConfig } from '../config';
import { safeEqual } from '../lib/crypto';
import { FileError } from '../fs/files';
import { ServerError } from '../server/server';
import type { ServerManager } from '../server/manager';
import { registerFileRoutes, registerTransferRoutes } from './files';
import { handleConsoleSocket } from './websocket';
import { pingMinecraft } from '../lib/slp';

export const VERSION = '0.1.0';

const uuidParam = z.object({ uuid: z.uuid() });

/** Create the Fastify instance (logger, CORS, websockets). Routes are added by `registerRoutes`. */
export async function createHttp(config: DaemonConfig) {
  const https = config.api.ssl.enabled
    ? { key: readFileSync(config.api.ssl.key), cert: readFileSync(config.api.ssl.cert) }
    : null;

  const app = Fastify({
    ...(https ? { https } : {}),
    bodyLimit: 1024 * 1024,
    logger: {
      level: config.debug ? 'debug' : 'info',
      transport: process.stdout.isTTY ? { target: 'pino-pretty', options: { singleLine: true } } : undefined,
      redact: ['req.headers.authorization'],
    },
  });

  await app.register(cors, { origin: allowedOrigins(config) });
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });
  return app;
}

function allowedOrigins(config: DaemonConfig) {
  return [panelOrigin(config), ...config.api.allowedOrigins];
}

export async function registerRoutes(app: FastifyInstance, config: DaemonConfig, docker: Docker, manager: ServerManager) {
  const origins = allowedOrigins(config);

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ServerError) return reply.status(err.statusCode).send({ error: 'server_error', message: err.message });
    if (err instanceof FileError) return reply.status(err.statusCode).send({ error: 'file_error', message: err.message });
    if (err instanceof z.ZodError) return reply.status(422).send({ error: 'validation', message: err.issues[0]?.message });
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) req.log.error({ err }, 'request failed');
    return reply.status(status).send({ error: 'error', message: err instanceof Error ? err.message : 'Unknown error' });
  });

  /** Everything except the websocket requires the panel's bearer token. */
  async function requirePanel(req: FastifyRequest) {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token || !safeEqual(token, config.token)) {
      throw Object.assign(new Error('Invalid or missing panel token.'), { statusCode: 401 });
    }
  }

  app.get('/api/servers/:uuid/ws', { websocket: true }, (socket, req) => {
    const origin = req.headers.origin;
    if (!origin || !origins.includes(origin)) {
      socket.close(4003, 'Origin not allowed');
      return;
    }
    const parsed = uuidParam.safeParse(req.params);
    const server = parsed.success ? manager.find(parsed.data.uuid) : undefined;
    if (!server) {
      socket.close(4004, 'Server not found');
      return;
    }
    handleConsoleSocket(socket, server, config, req.log);
  });

  await registerTransferRoutes(app, config, manager);

  app.register(async (api) => {
    api.addHook('onRequest', requirePanel);
    registerFileRoutes(api, manager, config);

    api.get('/api/servers/:uuid/stats/history', async (req) => {
      const { uuid } = uuidParam.parse(req.params);
      return { data: manager.get(uuid).resourceHistory() };
    });

    /** Minecraft status via Server List Ping on the server's primary port. */
    api.get('/api/servers/:uuid/minecraft/status', async (req) => {
      const { uuid } = uuidParam.parse(req.params);
      const server = manager.get(uuid);
      if (server.state !== 'running') return { online: false };
      const { ip, port } = server.config.allocations.default;
      return pingMinecraft(ip === '0.0.0.0' || ip === '::' ? '127.0.0.1' : ip, port);
    });

    api.get('/api/system', async (): Promise<DaemonSystemInfo> => {
      const dockerVersion = await docker
        .version()
        .then((v) => v.Version)
        .catch(() => null);
      return {
        version: VERSION,
        os: `${os.type()} ${os.release()}`,
        arch: os.arch(),
        kernel: os.release(),
        cpuCount: os.cpus().length,
        memoryTotal: os.totalmem(),
        dockerVersion,
        servers: manager.size,
        uptime: Math.round(process.uptime()),
      };
    });

    api.get('/api/servers', async () => ({
      data: manager.all().map((s) => ({ uuid: s.uuid, installing: s.installing, ...s.resources() })),
    }));

    api.post('/api/servers', async (req, reply) => {
      const body = z.object({ uuid: z.uuid(), startOnCompletion: z.boolean().default(true) }).parse(req.body);
      await manager.create(body.uuid, body.startOnCompletion);
      return reply.status(202).send({ ok: true });
    });

    api.get('/api/servers/:uuid', async (req) => {
      const { uuid } = uuidParam.parse(req.params);
      const server = manager.get(uuid);
      await server.diskUsage();
      return server.resources();
    });

    api.get('/api/servers/:uuid/logs', async (req) => {
      const { uuid } = uuidParam.parse(req.params);
      const { size } = z.object({ size: z.coerce.number().int().min(1).max(150).default(100) }).parse(req.query);
      return { data: manager.get(uuid).consoleHistory.slice(-size) };
    });

    api.post('/api/servers/:uuid/power', async (req, reply) => {
      const { uuid } = uuidParam.parse(req.params);
      const { action } = z.object({ action: z.enum(POWER_ACTIONS as [PowerAction, ...PowerAction[]]) }).parse(req.body);
      const server = manager.get(uuid);
      // Start/restart can take a while (image pulls); acknowledge right away and report progress over the websocket.
      void server.power(action).catch((err) => req.log.warn({ err, server: uuid, action }, 'power action failed'));
      return reply.status(202).send({ ok: true });
    });

    api.post('/api/servers/:uuid/commands', async (req) => {
      const { uuid } = uuidParam.parse(req.params);
      const { commands } = z.object({ commands: z.array(z.string().min(1).max(4096)).min(1).max(20) }).parse(req.body);
      const server = manager.get(uuid);
      for (const c of commands) server.sendCommand(c);
      return { ok: true };
    });

    api.post('/api/servers/:uuid/sync', async (req) => {
      const { uuid } = uuidParam.parse(req.params);
      await manager.get(uuid).sync();
      return { ok: true };
    });

    api.post('/api/servers/:uuid/reinstall', async (req, reply) => {
      const { uuid } = uuidParam.parse(req.params);
      const server = manager.get(uuid);
      if (server.installing) throw new ServerError('An installation is already running.');
      void server.install(true).catch((err) => req.log.error({ err, server: uuid }, 'reinstall failed'));
      return reply.status(202).send({ ok: true });
    });

    api.delete('/api/servers/:uuid', async (req) => {
      const { uuid } = uuidParam.parse(req.params);
      await manager.remove(uuid);
      return { ok: true };
    });
  });
}
