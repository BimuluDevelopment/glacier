import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  NETWORK_NAME_PATTERN,
  canJoinNetwork,
  proxyType,
  type NetworkInfo,
  type NetworkServer,
  type ServerPermission,
  type ServerResourceUsage,
} from '@glacier/shared';
import { prisma } from '../../db';
import { HttpError, conflict, forbidden, notFound, unprocessable } from '../../lib/errors';
import { logActivity } from '../../lib/activity';
import { requireUser } from '../../plugins/auth';
import { daemonRequest } from '../nodes/daemon-client';
import { getSection } from '../settings/service';
import { assertServerUsable, createServer, resolveServerAccess, syncServer } from '../servers/service';
import { deleteServer } from '../servers/delete';
import { standaloneConfigs } from './config';
import { applyServerConfigs, ensureForwardingSecret, refreshProxy, reserveBackendPort } from './service';

const networkName = z
  .string()
  .trim()
  .toLowerCase()
  .regex(NETWORK_NAME_PATTERN, 'Use 1-32 lowercase letters, numbers, dashes or underscores')
  // "try" is the join-order key in velocity.toml's [servers] table.
  .refine((n) => n !== 'try', '"try" is reserved by Velocity');
const hostname = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, 'Enter a hostname like survival.example.com');

/** /api/client/servers/:server/proxy — the Proxy tab of Velocity, BungeeCord and Waterfall servers. */
export const networkRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireUser);
  app.addHook('preHandler', async () => {
    if (!(await getSection('features')).networks) throw notFound('Route');
  });

  async function load(req: FastifyRequest, permission: ServerPermission) {
    const { server: id } = z.object({ server: z.string() }).parse(req.params);
    const { server } = await resolveServerAccess(req.user!, id, permission);
    const proxy = await prisma.server.findUniqueOrThrow({
      where: { id: server.id },
      include: {
        node: true,
        egg: { select: { name: true } },
        allocation: true,
        backends: { include: { egg: { select: { name: true } } }, orderBy: [{ networkOrder: 'asc' }, { id: 'asc' }] },
      },
    });
    const type = proxyType(proxy.egg.name);
    if (!type) throw new HttpError(404, 'not_a_proxy', 'This server is not a Velocity, BungeeCord or Waterfall proxy.');
    return { proxy, type };
  }

  async function loadBackend(req: FastifyRequest) {
    const ctx = await load(req, 'network.manage');
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const backend = ctx.proxy.backends.find((b) => b.shortId === id);
    if (!backend) throw notFound('Network server');
    return { ...ctx, backend };
  }

  const usage = (servers: { memory: number; disk: number; cpu: number }[]) => ({
    servers: servers.length,
    memory: servers.reduce((n, s) => n + s.memory, 0),
    disk: servers.reduce((n, s) => n + s.disk, 0),
    cpu: servers.reduce((n, s) => n + s.cpu, 0),
  });

  app.get('/', async (req): Promise<NetworkInfo> => {
    const { proxy, type } = await load(req, 'network.read');
    const user = req.user!;
    const states = new Map<string, ServerResourceUsage['state']>();
    try {
      const res = await daemonRequest<{ data: ({ uuid: string } & ServerResourceUsage)[] }>(proxy.node, app.encrypter, 'GET', '/api/servers');
      for (const s of res.data) states.set(s.uuid, s.state);
    } catch {
      // Node offline: show everything as unknown.
    }

    const [eggs, candidates] = await Promise.all([
      prisma.egg.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } }),
      prisma.server.findMany({
        where: { nodeId: proxy.nodeId, proxyId: null, id: { not: proxy.id }, ...(user.rootAdmin ? {} : { ownerId: user.id }) },
        include: { egg: { select: { name: true } } },
        orderBy: { name: 'asc' },
      }),
    ]);

    const servers: NetworkServer[] = proxy.backends.map((b) => ({
      id: b.shortId,
      uuid: b.uuid,
      name: b.name,
      networkName: b.networkName ?? '',
      fallback: b.networkFallback,
      forcedHosts: b.networkForcedHosts,
      egg: b.egg.name,
      status: b.status,
      state: states.get(b.uuid) ?? 'unknown',
      memory: b.memory,
      disk: b.disk,
      cpu: b.cpu,
      hasIcon: b.iconVersion > 0,
      iconVersion: b.iconVersion,
      managed: b.networkManaged,
    }));

    return {
      proxy: {
        type,
        forwarding: type === 'velocity' ? 'modern' : 'legacy',
        address: `${proxy.allocation.ipAlias ?? (proxy.allocation.ip === '0.0.0.0' ? proxy.node.fqdn : proxy.allocation.ip)}:${proxy.allocation.port}`,
        state: states.get(proxy.uuid) ?? 'unknown',
      },
      servers,
      unlimited: user.rootAdmin,
      limits: { servers: proxy.networkServerLimit, memory: proxy.networkMemoryLimit, disk: proxy.networkDiskLimit, cpu: proxy.networkCpuLimit },
      used: usage(proxy.backends.filter((b) => b.networkManaged)),
      eggs: eggs.filter((e) => canJoinNetwork(e.name, type)),
      attachable: candidates.filter((s) => canJoinNetwork(s.egg.name, type)).map((s) => ({ id: s.shortId, name: s.name, egg: s.egg.name })),
    };
  });

  /** Create a new backend server on the proxy's node, owned by the proxy's owner. */
  app.post('/servers', async (req) => {
    const { proxy, type } = await load(req, 'network.manage');
    assertServerUsable(proxy);
    const body = z
      .object({
        networkName,
        name: z.string().trim().max(191).optional(),
        eggId: z.number().int().positive(),
        version: z
          .string()
          .trim()
          .regex(/^(latest|\d+(\.\d+)+)$/, 'Use "latest" or a version like 1.21.4')
          .default('latest'),
        memory: z.number().int().min(256).max(1_048_576),
        disk: z.number().int().min(1024).max(10_485_760),
        cpu: z.number().int().min(0).max(10_000).default(0),
        fallback: z.boolean().default(false),
        acceptEula: z.literal(true, 'Accept the Minecraft EULA to create a Minecraft server'),
      })
      .parse(req.body);

    if (proxy.backends.some((b) => b.networkName === body.networkName)) {
      throw unprocessable('A server with that name is already in this network.', [{ path: 'networkName', message: 'Already used in this network' }]);
    }
    const egg = await prisma.egg.findUnique({ where: { id: body.eggId }, select: { name: true } });
    if (!egg || !canJoinNetwork(egg.name, type)) {
      throw unprocessable(type === 'velocity' ? 'Velocity networks need Paper-based servers (Paper, Purpur, Folia).' : 'Pick a Paper or Spigot server type.', [
        { path: 'eggId', message: 'Not supported behind this proxy' },
      ]);
    }

    // Admins are limited only by the node; owners by the network limits an admin gave the proxy.
    if (!req.user!.rootAdmin) {
      const used = usage(proxy.backends.filter((b) => b.networkManaged));
      if (proxy.networkServerLimit === 0) throw forbidden('An administrator needs to allow servers in this network first (network limits on the proxy).');
      const over = (label: string, limit: number, used: number, wanted: number, unit: string) => {
        if (limit > 0 && used + wanted > limit) throw conflict(`Not enough ${label} left in this network: ${Math.max(0, limit - used)} ${unit} of ${limit} ${unit} free.`);
      };
      over('server slots', proxy.networkServerLimit, used.servers, 1, 'servers');
      over('memory', proxy.networkMemoryLimit, used.memory, body.memory, 'MiB');
      over('disk space', proxy.networkDiskLimit, used.disk, body.disk, 'MiB');
      if (proxy.networkCpuLimit > 0 && body.cpu === 0) throw unprocessable('Set a CPU limit for the new server.', [{ path: 'cpu', message: 'Required in this network' }]);
      over('CPU', proxy.networkCpuLimit, used.cpu, body.cpu, '%');
    }

    if (type === 'velocity') await ensureForwardingSecret(proxy.id);
    const allocation = await reserveBackendPort(proxy.nodeId);
    let server;
    try {
      server = await createServer(
        app,
        {
          name: body.name || `${proxy.name} – ${body.networkName}`,
          description: `Part of the ${proxy.name} network.`,
          ownerId: proxy.ownerId,
          eggId: body.eggId,
          allocationId: allocation.id,
          additionalAllocationIds: [],
          memory: body.memory,
          swap: 0,
          disk: body.disk,
          io: 500,
          cpu: body.cpu,
          oomKiller: true,
          databaseLimit: proxy.databaseLimit,
          allocationLimit: 0,
          backupLimit: proxy.backupLimit,
          networkServerLimit: 0,
          networkMemoryLimit: 0,
          networkDiskLimit: 0,
          networkCpuLimit: 0,
          environment: { MINECRAFT_EULA: 'true', MINECRAFT_VERSION: body.version },
          startOnCompletion: true,
        },
        {
          proxyId: proxy.id,
          networkName: body.networkName,
          networkOrder: (proxy.backends.at(-1)?.networkOrder ?? -1) + 1,
          // The first server is where players land until you choose otherwise.
          networkFallback: body.fallback || proxy.backends.length === 0,
          networkManaged: true,
        },
      );
    } catch (err) {
      await prisma.allocation.delete({ where: { id: allocation.id } }).catch(() => undefined);
      throw err;
    }
    await refreshProxy(app, proxy.id, req.log);
    await logActivity(req, 'server:network.create', { serverId: proxy.id, properties: { name: body.networkName, server: server.shortId } });
    return { id: server.shortId };
  });

  /** Link one of the user's existing servers on this node into the network. */
  app.post('/servers/attach', async (req) => {
    const { proxy, type } = await load(req, 'network.manage');
    const body = z.object({ server: z.string().min(8).max(36), networkName, fallback: z.boolean().default(false) }).parse(req.body);
    const { server: target } = await resolveServerAccess(req.user!, body.server);
    if (!req.user!.rootAdmin && target.ownerId !== req.user!.id) throw forbidden('You can only link servers you own.');
    const full = await prisma.server.findUniqueOrThrow({ where: { id: target.id }, include: { egg: { select: { name: true } } } });
    if (full.nodeId !== proxy.nodeId) throw conflict('The server must be on the same node as the proxy.');
    if (full.proxyId) throw conflict('That server is already in a network.');
    if (!canJoinNetwork(full.egg.name, type)) throw conflict(type === 'velocity' ? 'Velocity networks need Paper-based servers.' : 'Only Paper or Spigot servers can join.');
    if (proxy.backends.some((b) => b.networkName === body.networkName)) {
      throw unprocessable('A server with that name is already in this network.', [{ path: 'networkName', message: 'Already used in this network' }]);
    }

    if (type === 'velocity') await ensureForwardingSecret(proxy.id);
    await prisma.server.update({
      where: { id: full.id },
      data: {
        proxyId: proxy.id,
        networkName: body.networkName,
        networkOrder: (proxy.backends.at(-1)?.networkOrder ?? -1) + 1,
        networkFallback: body.fallback || proxy.backends.length === 0,
        networkManaged: false,
      },
    });
    // Write the forwarding settings into the server's files now; they take effect on its restart.
    await applyServerConfigs(app, full.id, undefined, req.log);
    await refreshProxy(app, proxy.id, req.log);
    await logActivity(req, 'server:network.attach', { serverId: proxy.id, properties: { name: body.networkName, server: full.shortId } });
    return { ok: true, restartNeeded: true };
  });

  app.patch('/servers/:id', async (req) => {
    const { proxy, backend } = await loadBackend(req);
    const body = z
      .object({ networkName: networkName.optional(), fallback: z.boolean().optional(), forcedHosts: z.array(hostname).max(10).optional() })
      .parse(req.body);
    if (body.networkName && proxy.backends.some((b) => b.id !== backend.id && b.networkName === body.networkName)) {
      throw unprocessable('A server with that name is already in this network.', [{ path: 'networkName', message: 'Already used in this network' }]);
    }
    await prisma.server.update({
      where: { id: backend.id },
      data: { networkName: body.networkName, networkFallback: body.fallback, networkForcedHosts: body.forcedHosts ? [...new Set(body.forcedHosts)] : undefined },
    });
    await refreshProxy(app, proxy.id, req.log);
    await logActivity(req, 'server:network.update', { serverId: proxy.id, properties: { server: backend.shortId, fields: Object.keys(body) } });
    return { ok: true };
  });

  /** Reorder the servers; the order is the join order among "players join here first" servers. */
  app.post('/order', async (req) => {
    const { proxy } = await load(req, 'network.manage');
    const { ids } = z.object({ ids: z.array(z.string()).min(1).max(200) }).parse(req.body);
    const known = new Map(proxy.backends.map((b) => [b.shortId, b.id]));
    if (ids.length !== known.size || ids.some((id) => !known.has(id))) throw unprocessable('Send every server in the network exactly once.');
    await prisma.$transaction(ids.map((id, i) => prisma.server.update({ where: { id: known.get(id)! }, data: { networkOrder: i } })));
    await refreshProxy(app, proxy.id, req.log);
    return { ok: true };
  });

  /** Take a server out of the network. It keeps running on its own, with forwarding turned off. */
  app.post('/servers/:id/detach', async (req) => {
    const { proxy, backend } = await loadBackend(req);
    await prisma.server.update({
      where: { id: backend.id },
      data: { proxyId: null, networkName: null, networkFallback: false, networkForcedHosts: [], networkManaged: false, networkOrder: 0 },
    });
    await applyServerConfigs(app, backend.id, standaloneConfigs(), req.log);
    const server = await prisma.server.findUniqueOrThrow({ where: { id: backend.id }, include: { node: true } });
    if (server.status === 'ACTIVE') await syncServer(app, server).catch(() => undefined);
    await refreshProxy(app, proxy.id, req.log);
    await logActivity(req, 'server:network.detach', { serverId: proxy.id, properties: { server: backend.shortId } });
    return { ok: true };
  });

  /** Delete a server made from this page. Admins can delete any server in the network. */
  app.delete('/servers/:id', async (req) => {
    const { proxy, backend } = await loadBackend(req);
    if (!req.user!.rootAdmin && !backend.networkManaged) throw forbidden('Only servers created from this page can be deleted here. Ask an administrator.');
    const server = await prisma.server.findUniqueOrThrow({ where: { id: backend.id }, include: { node: true } });
    await deleteServer(app, server, { force: false, log: req.log });
    await refreshProxy(app, proxy.id, req.log);
    await logActivity(req, 'server:network.delete', { serverId: proxy.id, properties: { name: backend.networkName, server: backend.shortId } });
    return { ok: true };
  });
};
