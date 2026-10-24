import { randomBytes } from 'node:crypto';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { hasPermission, type ServerPermission } from '@glacier/shared';
import { prisma } from '../../db';
import { conflict, notFound } from '../../lib/errors';
import { logActivity } from '../../lib/activity';
import { idParam } from '../../lib/http';
import { requireAdmin, requireUser } from '../../plugins/auth';
import { resolveServerAccess } from '../servers/service';
import { REMOTE, createDatabase, dropDatabase, generatePassword, hostCredentials, rotatePassword, testHost } from './service';

// --- Admin: database hosts -------------------------------------------------------------------------

const hostSchema = z.object({
  name: z.string().trim().min(1).max(100),
  host: z.string().trim().min(1).max(255),
  port: z.number().int().min(1).max(65535).default(3306),
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(255),
  maxDatabases: z.number().int().min(1).nullable().optional(),
  nodeId: z.number().int().positive().nullable().optional(),
});

export const adminDatabaseHostRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireAdmin);

  const serialize = (h: { passwordEncrypted: string } & Record<string, unknown>) => {
    const { passwordEncrypted: _passwordEncrypted, ...rest } = h;
    return rest;
  };

  app.get('/', async () => {
    const hosts = await prisma.databaseHost.findMany({
      orderBy: { name: 'asc' },
      include: { node: { select: { id: true, name: true } }, _count: { select: { databases: true } } },
    });
    return { data: hosts.map(serialize) };
  });

  app.post('/', async (req) => {
    const body = hostSchema.parse(req.body);
    // Refuse credentials that cannot connect rather than failing later for users.
    const version = await testHost({ host: body.host, port: body.port, username: body.username, password: body.password });
    const { password, ...rest } = body;
    const host = await prisma.databaseHost.create({ data: { ...rest, passwordEncrypted: app.encrypter.encrypt(password) } });
    await logActivity(req, 'admin:database-host.create', { properties: { name: host.name, version } });
    return { ...serialize(host), version };
  });

  app.patch('/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const body = hostSchema.partial().parse(req.body);
    const current = await prisma.databaseHost.findUnique({ where: { id } });
    if (!current) throw notFound('Database host');
    const { password, ...rest } = body;
    const creds = { ...hostCredentials(current, app.encrypter), ...(rest.host ? { host: rest.host } : {}), ...(rest.port ? { port: rest.port } : {}), ...(rest.username ? { username: rest.username } : {}), ...(password ? { password } : {}) };
    await testHost(creds);
    const host = await prisma.databaseHost.update({
      where: { id },
      data: { ...rest, ...(password ? { passwordEncrypted: app.encrypter.encrypt(password) } : {}) },
    });
    await logActivity(req, 'admin:database-host.update', { properties: { id } });
    return serialize(host);
  });

  app.post('/:id/test', async (req) => {
    const { id } = idParam.parse(req.params);
    const host = await prisma.databaseHost.findUnique({ where: { id } });
    if (!host) throw notFound('Database host');
    return { ok: true, version: await testHost(hostCredentials(host, app.encrypter)) };
  });

  app.delete('/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    if ((await prisma.serverDatabase.count({ where: { databaseHostId: id } })) > 0) throw conflict('Delete the databases on this host first.');
    await prisma.databaseHost.delete({ where: { id } });
    await logActivity(req, 'admin:database-host.delete', { properties: { id } });
    return { ok: true };
  });
};

// --- Client: server databases ----------------------------------------------------------------------

const params = z.object({ server: z.string().min(8).max(36), database: z.coerce.number().int().positive().optional() });

export const clientDatabaseRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireUser);

  async function load(req: FastifyRequest, permission: ServerPermission) {
    const p = params.parse(req.params);
    const { server, permissions } = await resolveServerAccess(req.user!, p.server, permission);
    if (!p.database) return { server, permissions, database: null };
    const database = await prisma.serverDatabase.findFirst({ where: { id: p.database, serverId: server.id }, include: { host: true } });
    if (!database) throw notFound('Database');
    return { server, permissions, database };
  }

  function serialize(db: Awaited<ReturnType<typeof prisma.serverDatabase.findFirstOrThrow>> & { host: { host: string; port: number; name: string } }, showPassword: boolean) {
    return {
      id: db.id,
      name: db.database,
      username: db.username,
      remote: db.remote,
      maxConnections: db.maxConnections,
      host: { name: db.host.name, address: db.host.host, port: db.host.port },
      password: showPassword ? app.encrypter.decrypt(db.passwordEncrypted) : null,
      createdAt: db.createdAt,
    };
  }

  app.get('/', async (req) => {
    const { server, permissions } = await load(req, 'database.read');
    const dbs = await prisma.serverDatabase.findMany({ where: { serverId: server.id }, include: { host: true }, orderBy: { createdAt: 'asc' } });
    const reveal = hasPermission(permissions, 'database.view-password');
    return { data: dbs.map((d) => serialize(d, reveal)), limit: server.databaseLimit };
  });

  app.post('/', async (req) => {
    const { server } = await load(req, 'database.create');
    const body = z
      .object({
        database: z.string().regex(/^[A-Za-z0-9_]{1,48}$/, 'Letters, numbers and underscores only (max 48)'),
        remote: z.string().regex(REMOTE, 'Use an IP, hostname or % for anywhere').default('%'),
      })
      .parse(req.body);
    if (server.databaseLimit <= 0) throw conflict('This server does not allow databases.');
    if ((await prisma.serverDatabase.count({ where: { serverId: server.id } })) >= server.databaseLimit) {
      throw conflict(`This server has reached its limit of ${server.databaseLimit} database(s).`);
    }

    // Prefer a host linked to this server's node, then any host with room.
    const hosts = await prisma.databaseHost.findMany({ include: { _count: { select: { databases: true } } }, orderBy: { id: 'asc' } });
    const withRoom = hosts.filter((h) => h.maxDatabases == null || h._count.databases < h.maxDatabases);
    const host = withRoom.find((h) => h.nodeId === server.nodeId) ?? withRoom.find((h) => h.nodeId == null) ?? withRoom[0];
    if (!host) throw conflict('No database host is available. Ask an administrator to add one.');

    const database = `s${server.id}_${body.database}`.slice(0, 64);
    const username = `u${server.id}_${randomBytes(5).toString('hex')}`;
    const password = generatePassword();
    if (await prisma.serverDatabase.findFirst({ where: { databaseHostId: host.id, database } })) {
      throw conflict('A database with that name already exists.');
    }
    await createDatabase(hostCredentials(host, app.encrypter), { database, username, remote: body.remote, password, maxConnections: 0 });
    const created = await prisma.serverDatabase.create({
      data: { serverId: server.id, databaseHostId: host.id, database, username, remote: body.remote, passwordEncrypted: app.encrypter.encrypt(password) },
      include: { host: true },
    });
    await logActivity(req, 'server:database.create', { serverId: server.id, properties: { name: database } });
    // The creator always sees the password once.
    return serialize(created, true);
  });

  app.post('/:database/rotate-password', async (req) => {
    const { server, permissions, database } = await load(req, 'database.update');
    const password = generatePassword();
    await rotatePassword(hostCredentials(database!.host, app.encrypter), database!, password);
    const updated = await prisma.serverDatabase.update({ where: { id: database!.id }, data: { passwordEncrypted: app.encrypter.encrypt(password) }, include: { host: true } });
    await logActivity(req, 'server:database.rotate-password', { serverId: server.id, properties: { name: database!.database } });
    return serialize(updated, hasPermission(permissions, 'database.view-password'));
  });

  app.delete('/:database', async (req) => {
    const { server, database } = await load(req, 'database.delete');
    await dropDatabase(hostCredentials(database!.host, app.encrypter), database!);
    await prisma.serverDatabase.delete({ where: { id: database!.id } });
    await logActivity(req, 'server:database.delete', { serverId: server.id, properties: { name: database!.database } });
    return { ok: true };
  });
};
