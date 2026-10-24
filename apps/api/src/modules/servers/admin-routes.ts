import type { FastifyPluginAsync } from 'fastify';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { serverBuildSchema, serverCreateSchema } from '@glacier/shared';
import { prisma } from '../../db';
import { conflict, notFound } from '../../lib/errors';
import { logActivity } from '../../lib/activity';
import { idParam, paged, paginate, paginationQuery } from '../../lib/http';
import { requireAdmin } from '../../plugins/auth';
import { daemonRequest } from '../nodes/daemon-client';
import { dropDatabase, hostCredentials } from '../databases/service';
import { displayName, notify } from '../mail/service';
import { deleteSubdomainRecords } from '../minecraft/manage';
import { createServer, resolveVariables, syncServer } from './service';

const detailsSchema = z.object({
  name: z.string().min(1).max(191).optional(),
  description: z.string().max(1000).nullable().optional(),
  ownerId: z.uuid().optional(),
});

const startupSchema = z.object({
  startup: z.string().min(1).optional(),
  image: z.string().min(1).optional(),
  environment: z.record(z.string(), z.string()).optional(),
});

const listInclude = {
  owner: { select: { id: true, username: true, email: true } },
  node: { select: { id: true, name: true } },
  egg: { select: { id: true, name: true } },
  allocation: { select: { ip: true, ipAlias: true, port: true } },
} satisfies Prisma.ServerInclude;

export const adminServerRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireAdmin);

  async function load(id: number) {
    const server = await prisma.server.findUnique({ where: { id }, include: { node: true } });
    if (!server) throw notFound('Server');
    return server;
  }

  app.get('/', async (req) => {
    const query = paginationQuery.extend({ nodeId: z.coerce.number().int().optional() }).parse(req.query);
    const where: Prisma.ServerWhereInput = {
      ...(query.nodeId ? { nodeId: query.nodeId } : {}),
      ...(query.search
        ? {
            OR: [
              { name: { contains: query.search, mode: 'insensitive' } },
              { shortId: { startsWith: query.search.toLowerCase() } },
              { owner: { username: { contains: query.search, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };
    const [servers, total] = await Promise.all([
      prisma.server.findMany({ where, include: listInclude, orderBy: { createdAt: 'desc' }, ...paginate(query) }),
      prisma.server.count({ where }),
    ]);
    return paged(servers, total, query);
  });

  app.get('/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const server = await prisma.server.findUnique({
      where: { id },
      include: {
        ...listInclude,
        allocations: true,
        egg: { include: { variables: { orderBy: { sort: 'asc' } } } },
        variables: true,
      },
    });
    if (!server) throw notFound('Server');
    return server;
  });

  app.post('/', async (req) => {
    const input = serverCreateSchema.parse(req.body);
    const server = await createServer(app, input);
    await logActivity(req, 'admin:server.create', { serverId: server.id, properties: { name: server.name } });
    const [owner, allocation] = await Promise.all([
      prisma.user.findUniqueOrThrow({ where: { id: server.ownerId } }),
      prisma.allocation.findUniqueOrThrow({ where: { id: server.allocationId } }),
    ]);
    void notify({ encrypter: app.encrypter, log: req.log }, 'serverCreated', owner.email, {
      name: displayName(owner),
      serverName: server.name,
      serverAddress: `${allocation.ipAlias ?? allocation.ip}:${allocation.port}`,
      serverUrl: `${app.config.APP_URL.replace(/\/$/, '')}/server/${server.shortId}`,
    });
    return server;
  });

  app.patch('/:id/details', async (req) => {
    const { id } = idParam.parse(req.params);
    const body = detailsSchema.parse(req.body);
    const server = await prisma.server.update({ where: { id }, data: body });
    await logActivity(req, 'admin:server.update-details', { serverId: id, properties: { fields: Object.keys(body) } });
    return server;
  });

  app.patch('/:id/build', async (req) => {
    const { id } = idParam.parse(req.params);
    const body = serverBuildSchema.partial().parse(req.body);
    const current = await load(id);
    const server = await prisma.server.update({ where: { id }, data: body, include: { node: true } });
    if (current.status !== 'INSTALLING') await syncServer(app, server);
    await logActivity(req, 'admin:server.update-build', { serverId: id, properties: body });
    return server;
  });

  app.patch('/:id/startup', async (req) => {
    const { id } = idParam.parse(req.params);
    const body = startupSchema.parse(req.body);
    const current = await prisma.server.findUnique({ where: { id }, include: { egg: { include: { variables: true } }, variables: true } });
    if (!current) throw notFound('Server');

    await prisma.$transaction(async (tx) => {
      await tx.server.update({ where: { id }, data: { startup: body.startup, image: body.image } });
      if (body.environment) {
        const existing = Object.fromEntries(
          current.egg.variables.map((v) => [v.envVariable, current.variables.find((sv) => sv.variableId === v.id)?.value ?? v.defaultValue]),
        );
        const values = resolveVariables(current.egg.variables, { ...existing, ...body.environment });
        for (const v of values) {
          await tx.serverVariable.upsert({
            where: { serverId_variableId: { serverId: id, variableId: v.variableId } },
            create: { serverId: id, ...v },
            update: { value: v.value },
          });
        }
      }
    });
    const server = await load(id);
    if (server.status !== 'INSTALLING') await syncServer(app, server);
    await logActivity(req, 'admin:server.update-startup', { serverId: id });
    return server;
  });

  app.post('/:id/suspend', async (req) => {
    const { id } = idParam.parse(req.params);
    const server = await prisma.server.update({ where: { id }, data: { status: 'SUSPENDED' }, include: { node: true } });
    await syncServer(app, server);
    await logActivity(req, 'admin:server.suspend', { serverId: id });
    return { ok: true };
  });

  app.post('/:id/unsuspend', async (req) => {
    const { id } = idParam.parse(req.params);
    const current = await load(id);
    if (current.status !== 'SUSPENDED') throw conflict('This server is not suspended.');
    const server = await prisma.server.update({ where: { id }, data: { status: 'ACTIVE' }, include: { node: true } });
    await syncServer(app, server);
    await logActivity(req, 'admin:server.unsuspend', { serverId: id });
    return { ok: true };
  });

  app.post('/:id/reinstall', async (req) => {
    const { id } = idParam.parse(req.params);
    const server = await load(id);
    if (server.status === 'SUSPENDED') throw conflict('Unsuspend the server before reinstalling it.');
    await prisma.server.update({ where: { id }, data: { status: 'INSTALLING' } });
    await daemonRequest(server.node, app.encrypter, 'POST', `/api/servers/${server.uuid}/reinstall`);
    await logActivity(req, 'admin:server.reinstall', { serverId: id });
    return { ok: true };
  });

  app.delete('/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    // Not z.coerce.boolean(): that turns the string "false" into true.
    const { force } = z.object({ force: z.enum(['true', 'false']).default('false').transform((v) => v === 'true') }).parse(req.query);
    const server = await load(id);
    const [databases, backups] = await Promise.all([
      prisma.serverDatabase.findMany({ where: { serverId: id }, include: { host: true } }),
      prisma.backup.findMany({ where: { serverId: id } }),
    ]);

    // Databases live outside the node; drop them first so a failure leaves everything in place.
    for (const db of databases) {
      try {
        await dropDatabase(hostCredentials(db.host, app.encrypter), db);
      } catch (err) {
        if (!force) throw err;
        req.log.warn({ err, database: db.database }, 'force-deleting server; database could not be dropped');
      }
    }
    // DNS records outlive the server otherwise.
    for (const sub of await prisma.subdomain.findMany({ where: { serverId: id } })) {
      await deleteSubdomainRecords(app.encrypter, sub).catch((err) => req.log.warn({ err, hostname: sub.hostname }, 'could not delete subdomain records'));
    }
    for (const backup of backups) {
      await daemonRequest(server.node, app.encrypter, 'DELETE', `/api/servers/${server.uuid}/backup/${backup.uuid}`).catch((err) =>
        req.log.warn({ err, backup: backup.uuid }, 'could not delete backup file'),
      );
    }
    try {
      await daemonRequest(server.node, app.encrypter, 'DELETE', `/api/servers/${server.uuid}`, undefined, 60_000);
    } catch (err) {
      if (!force) throw err;
      req.log.warn({ err, server: server.uuid }, 'force-deleting server the daemon could not remove');
    }
    await prisma.server.delete({ where: { id } });
    await logActivity(req, 'admin:server.delete', { properties: { serverId: id, name: server.name, uuid: server.uuid, force } });
    return { ok: true };
  });
};
