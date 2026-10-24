import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { Node } from '@prisma/client';
import { z } from 'zod';
import { PERMISSION_ALL, hasPermission, type InstallStatusReport, type PairResponse, type SftpAuthResponse } from '@glacier/shared';
import { prisma } from '../../db';
import { recordActivity } from '../../lib/activity';
import { HttpError, notFound } from '../../lib/errors';
import { randomToken, safeEqual, sha256 } from '../../lib/crypto';
import { verifyAgainstDummy, verifyPassword } from '../../lib/password';
import { getSection } from '../settings/service';
import { configurationInclude, buildConfiguration, installationScript, loadConfiguration } from '../servers/configuration';

declare module 'fastify' {
  interface FastifyRequest {
    node: Node | null;
  }
}

const LAST_SEEN_INTERVAL_MS = 60_000;
const SFTP_MAX_FAILURES = 5;
const SFTP_LOCKOUT_MS = 5 * 60_000;

/**
 * Failed SFTP logins per "ip|username". Every SFTP login reaches the panel from the daemon's IP,
 * so the generic per-IP rate limit would lock everyone out; this one is per client and account.
 */
const sftpFailures = new Map<string, { count: number; until: number }>();

function sftpThrottled(key: string) {
  const entry = sftpFailures.get(key);
  if (!entry) return false;
  if (entry.until < Date.now()) {
    sftpFailures.delete(key);
    return false;
  }
  return entry.count >= SFTP_MAX_FAILURES;
}

function sftpFailed(key: string) {
  const entry = sftpFailures.get(key);
  const fresh = !entry || entry.until < Date.now();
  sftpFailures.set(key, { count: fresh ? 1 : entry.count + 1, until: Date.now() + SFTP_LOCKOUT_MS });
  // Keep the map from growing forever under a spray of usernames.
  if (sftpFailures.size > 10_000) sftpFailures.clear();
}

/** Routes glacierd calls. Authenticated with `Bearer <node uuid>.<node secret>`. */
export const remoteRoutes: FastifyPluginAsync = async (app) => {
  app.decorateRequest('node', null);

  /** Exchange a one-time pairing token for the node's permanent secret. */
  app.post('/pair', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req): Promise<PairResponse> => {
    const { token } = z.object({ token: z.string().min(10) }).parse(req.body);
    const node = await prisma.node.findUnique({ where: { pairingTokenHash: sha256(token) } });
    if (!node || !node.pairingExpiresAt || node.pairingExpiresAt < new Date()) {
      throw new HttpError(401, 'invalid_token', 'This pairing token is invalid or has expired. Generate a new one in the admin panel.');
    }
    const secret = randomToken(48);
    await prisma.node.update({
      where: { id: node.id },
      data: {
        secretEncrypted: app.encrypter.encrypt(secret),
        pairingTokenHash: null,
        pairingExpiresAt: null,
        pairedAt: new Date(),
        lastSeenAt: new Date(),
      },
    });
    req.log.info({ node: node.uuid }, 'daemon paired');
    return {
      nodeUuid: node.uuid,
      secret,
      panelUrl: app.config.APP_URL.replace(/\/$/, ''),
      daemonPort: node.daemonPort,
      sftpPort: node.sftpPort,
      dataDirectory: node.dataDirectory,
      fqdn: node.fqdn,
      uploadSize: node.uploadSize,
    };
  });

  app.register(async (authed) => {
    authed.addHook('onRequest', authenticateNode);

    authed.get('/servers', async (req) => {
      const servers = await prisma.server.findMany({ where: { nodeId: req.node!.id }, include: configurationInclude });
      return { data: servers.map(buildConfiguration) };
    });

    authed.get('/servers/:uuid', async (req) => {
      const { uuid } = z.object({ uuid: z.uuid() }).parse(req.params);
      return loadConfiguration({ uuid, nodeId: req.node!.id });
    });

    authed.get('/servers/:uuid/install', async (req) => {
      const { uuid } = z.object({ uuid: z.uuid() }).parse(req.params);
      const server = await prisma.server.findFirst({ where: { uuid, nodeId: req.node!.id }, include: { egg: true } });
      if (!server) throw notFound('Server');
      return installationScript(server.egg);
    });

    authed.post('/servers/:uuid/install', async (req) => {
      const { uuid } = z.object({ uuid: z.uuid() }).parse(req.params);
      const body = z.object({ successful: z.boolean(), reinstall: z.boolean().default(false) }).parse(req.body) satisfies InstallStatusReport;
      const server = await prisma.server.findFirst({ where: { uuid, nodeId: req.node!.id } });
      if (!server) throw notFound('Server');
      // An admin may have suspended the server while it installed; keep that.
      const status = server.status === 'SUSPENDED' ? 'SUSPENDED' : body.successful ? 'ACTIVE' : body.reinstall ? 'REINSTALL_FAILED' : 'INSTALL_FAILED';
      await prisma.server.update({
        where: { id: server.id },
        data: { status, ...(body.successful ? { installedAt: new Date() } : {}) },
      });
      await recordActivity({ event: body.successful ? 'server:install.completed' : 'server:install.failed', serverId: server.id, properties: { reinstall: body.reinstall } });
      return { ok: true };
    });

    authed.post('/backups/:uuid', async (req) => {
      const { uuid } = z.object({ uuid: z.uuid() }).parse(req.params);
      const body = z.object({ successful: z.boolean(), checksum: z.string().nullable(), bytes: z.number().int().min(0) }).parse(req.body);
      const backup = await prisma.backup.findFirst({ where: { uuid, server: { nodeId: req.node!.id } } });
      if (!backup) throw notFound('Backup');
      await prisma.backup.update({
        where: { id: backup.id },
        data: { isSuccessful: body.successful, checksum: body.checksum, bytes: BigInt(body.bytes), completedAt: new Date() },
      });
      await recordActivity({ event: body.successful ? 'server:backup.completed' : 'server:backup.failed', serverId: backup.serverId, properties: { name: backup.name } });
      return { ok: true };
    });

    authed.post('/backups/:uuid/restore', async (req) => {
      const { uuid } = z.object({ uuid: z.uuid() }).parse(req.params);
      const { successful } = z.object({ successful: z.boolean() }).parse(req.body);
      const backup = await prisma.backup.findFirst({ where: { uuid, server: { nodeId: req.node!.id } } });
      if (!backup) throw notFound('Backup');
      await recordActivity({ event: successful ? 'server:backup.restore-completed' : 'server:backup.restore-failed', serverId: backup.serverId, properties: { name: backup.name } });
      return { ok: true };
    });

    /** SFTP login: "<panel username>.<server short id>" + panel password. */
    authed.post('/sftp/auth', async (req): Promise<SftpAuthResponse> => {
      const body = z.object({ username: z.string().min(1).max(200), password: z.string().max(1024), ip: z.string().max(64) }).parse(req.body);
      const key = `${body.ip}|${body.username.toLowerCase()}`;
      if (sftpThrottled(key)) throw new HttpError(429, 'rate_limited', 'Too many failed attempts. Try again in a few minutes.');

      const reject = async (actorId: string | null, serverId?: number) => {
        sftpFailed(key);
        await recordActivity({ event: 'server:sftp.login.failed', actorId, serverId, ip: body.ip, properties: { username: body.username } });
        return new HttpError(403, 'invalid_credentials', 'Invalid SFTP credentials.');
      };

      const dot = body.username.lastIndexOf('.');
      const username = dot > 0 ? body.username.slice(0, dot) : '';
      const shortId = dot > 0 ? body.username.slice(dot + 1).toLowerCase() : '';
      const user = username ? await prisma.user.findFirst({ where: { username: { equals: username, mode: 'insensitive' } } }) : null;
      const passwordOk = user ? await verifyPassword(user.passwordHash, body.password) : await verifyAgainstDummy(body.password);
      if (!user || !passwordOk) throw await reject(user?.id ?? null);

      const server = await prisma.server.findFirst({
        where: { shortId, nodeId: req.node!.id },
        include: { subusers: { where: { userId: user.id } } },
      });
      if (!server) throw await reject(user.id);
      const permissions = user.rootAdmin || server.ownerId === user.id ? [PERMISSION_ALL] : (server.subusers[0]?.permissions ?? null);
      if (!permissions || !hasPermission(permissions, 'file.sftp')) throw await reject(user.id, server.id);
      if (server.status === 'SUSPENDED' || server.status === 'INSTALLING') {
        throw new HttpError(403, 'unavailable', 'This server is suspended or still installing.');
      }
      if (!user.rootAdmin && (await getSection('general')).maintenanceMode) throw new HttpError(403, 'maintenance', 'The panel is in maintenance mode.');

      sftpFailures.delete(key);
      return { server: server.uuid, user: user.id, permissions };
    });

    /** Called when the daemon boots: installs interrupted by a restart can never finish. */
    authed.post('/servers/reset', async (req) => {
      const { count } = await prisma.server.updateMany({ where: { nodeId: req.node!.id, status: 'INSTALLING' }, data: { status: 'INSTALL_FAILED' } });
      return { reset: count };
    });
  });

  async function authenticateNode(req: FastifyRequest) {
    const header = req.headers.authorization ?? '';
    const match = /^Bearer ([0-9a-f-]{36})\.(.+)$/i.exec(header);
    if (!match) throw new HttpError(401, 'unauthorized', 'Missing node credentials.');
    const node = await prisma.node.findUnique({ where: { uuid: match[1]! } });
    if (!node?.secretEncrypted || !safeEqual(app.encrypter.decrypt(node.secretEncrypted), match[2]!)) {
      throw new HttpError(401, 'unauthorized', 'Invalid node credentials.');
    }
    req.node = node;
    if (!node.lastSeenAt || Date.now() - node.lastSeenAt.getTime() > LAST_SEEN_INTERVAL_MS) {
      await prisma.node.update({ where: { id: node.id }, data: { lastSeenAt: new Date() } });
    }
  }
};
