import type { FastifyPluginAsync } from 'fastify';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { commandSchema, powerSchema, type ServerPermission, type ServerResourceUsage } from '@glacier/shared';
import { prisma } from '../../db';
import { logActivity } from '../../lib/activity';
import { paged, paginate, paginationQuery } from '../../lib/http';
import { requireUser } from '../../plugins/auth';
import { daemonRequest, daemonSocketUrl } from '../nodes/daemon-client';
import { signNodeToken } from '../nodes/tokens';
import { assertServerUsable, resolveServerAccess } from './service';

const WS_TOKEN_TTL_SECONDS = 10 * 60;
const serverParam = z.object({ server: z.string().min(8).max(36) });

export const clientServerRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireUser);

  app.get('/', async (req) => {
    const query = paginationQuery.extend({ scope: z.enum(['mine', 'all']).default('mine') }).parse(req.query);
    const user = req.user!;
    const where: Prisma.ServerWhereInput = {
      ...(query.scope === 'all' && user.rootAdmin ? {} : { OR: [{ ownerId: user.id }, { subusers: { some: { userId: user.id } } }] }),
      ...(query.search ? { name: { contains: query.search, mode: 'insensitive' } } : {}),
    };
    const [servers, total] = await Promise.all([
      prisma.server.findMany({
        where,
        orderBy: { name: 'asc' },
        include: {
          allocation: { select: { ip: true, ipAlias: true, port: true } },
          node: { select: { name: true, fqdn: true } },
          egg: { select: { name: true } },
          proxy: { select: { name: true } },
        },
        ...paginate(query),
      }),
      prisma.server.count({ where }),
    ]);
    return paged(
      servers.map((s) => ({
        id: s.shortId,
        uuid: s.uuid,
        name: s.name,
        description: s.description,
        status: s.status,
        iconVersion: s.iconVersion,
        isOwner: s.ownerId === user.id,
        node: s.node.name,
        egg: s.egg.name,
        address: { ip: s.allocation.ipAlias ?? s.allocation.ip, port: s.allocation.port },
        network: s.proxy ? { proxyName: s.proxy.name, name: s.networkName } : null,
        limits: { memory: s.memory, disk: s.disk, cpu: s.cpu },
      })),
      total,
      query,
    );
  });

  app.get('/:server', async (req) => {
    const { server: id } = serverParam.parse(req.params);
    const { server, permissions } = await resolveServerAccess(req.user!, id);
    const full = await prisma.server.findUniqueOrThrow({
      where: { id: server.id },
      include: {
        allocation: true,
        allocations: { orderBy: { port: 'asc' } },
        egg: { select: { name: true, features: true, dockerImages: true } },
        proxy: { select: { shortId: true, name: true } },
      },
    });
    return {
      id: server.shortId,
      uuid: server.uuid,
      name: server.name,
      description: server.description,
      status: server.status,
      iconVersion: server.iconVersion,
      // The proxy network this server is part of, if any.
      network: full.proxy ? { proxyId: full.proxy.shortId, proxyName: full.proxy.name, name: server.networkName } : null,
      isOwner: server.ownerId === req.user!.id,
      permissions,
      node: { name: server.node.name, fqdn: server.node.fqdn, sftpPort: server.node.sftpPort },
      sftp: { host: server.node.fqdn, port: server.node.sftpPort, username: `${req.user!.username}.${server.shortId}` },
      egg: full.egg,
      image: server.image,
      invocation: server.startup,
      limits: { memory: server.memory, swap: server.swap, disk: server.disk, io: server.io, cpu: server.cpu, threads: server.threads },
      featureLimits: { databases: server.databaseLimit, allocations: server.allocationLimit, backups: server.backupLimit },
      allocations: full.allocations.map((a) => ({
        id: a.id,
        ip: a.ip,
        alias: a.ipAlias,
        port: a.port,
        notes: a.notes,
        primary: a.id === server.allocationId,
      })),
    };
  });

  /** Short-lived credentials for the browser to open the daemon's console websocket directly. */
  app.get('/:server/websocket', async (req) => {
    const { server: id } = serverParam.parse(req.params);
    const { server, permissions } = await resolveServerAccess(req.user!, id, 'control.console');
    const token = await signNodeToken(app, server.node, req.user!.id, { server: server.uuid, permissions }, WS_TOKEN_TTL_SECONDS);
    return { token, socket: daemonSocketUrl(server.node, server.uuid), expiresIn: WS_TOKEN_TTL_SECONDS };
  });

  app.get('/:server/resources', async (req) => {
    const { server: id } = serverParam.parse(req.params);
    const { server } = await resolveServerAccess(req.user!, id);
    return daemonRequest<ServerResourceUsage>(server.node, app.encrypter, 'GET', `/api/servers/${server.uuid}`, undefined, 5_000);
  });

  app.post('/:server/power', async (req) => {
    const { server: id } = serverParam.parse(req.params);
    const { signal } = powerSchema.parse(req.body);
    const { server } = await resolveServerAccess(req.user!, id, `control.${signal}` as ServerPermission);
    assertServerUsable(server);
    await daemonRequest(server.node, app.encrypter, 'POST', `/api/servers/${server.uuid}/power`, { action: signal });
    await logActivity(req, `server:power.${signal}`, { serverId: server.id });
    return { ok: true };
  });

  app.post('/:server/command', async (req) => {
    const { server: id } = serverParam.parse(req.params);
    const { command } = commandSchema.parse(req.body);
    const { server } = await resolveServerAccess(req.user!, id, 'control.command');
    assertServerUsable(server);
    await daemonRequest(server.node, app.encrypter, 'POST', `/api/servers/${server.uuid}/commands`, { commands: [command] });
    await logActivity(req, 'server:console.command', { serverId: server.id, properties: { command } });
    return { ok: true };
  });

  app.get('/:server/activity', async (req) => {
    const { server: id } = serverParam.parse(req.params);
    const { server, permissions } = await resolveServerAccess(req.user!, id, 'activity.read');
    const query = paginationQuery.parse(req.query);
    const where: Prisma.ActivityLogWhereInput = { serverId: server.id };
    const [rows, total] = await Promise.all([
      prisma.activityLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        include: { actor: { select: { username: true } } },
        ...paginate(query),
      }),
      prisma.activityLog.count({ where }),
    ]);
    // Subusers only see IP addresses for their own actions.
    const showIp = permissions.includes('*');
    return paged(
      rows.map((r) => ({ ...r, ip: showIp || r.actorId === req.user!.id ? r.ip : null })),
      total,
      query,
    );
  });
};
