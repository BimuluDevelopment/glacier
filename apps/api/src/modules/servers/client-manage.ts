import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { Node, Server } from '@prisma/client';
import { z } from 'zod';
import { PERMISSION_ALL, isServerPermission, type ServerPermission } from '@glacier/shared';
import { validateVariable } from '@glacier/eggs';
import { prisma } from '../../db';
import { HttpError, conflict, forbidden, notFound, unprocessable } from '../../lib/errors';
import { logActivity } from '../../lib/activity';
import { requireUser } from '../../plugins/auth';
import { daemonRequest } from '../nodes/daemon-client';
import { displayName, notify } from '../mail/service';
import { assertServerUsable, resolveServerAccess, syncServer } from './service';

const serverParam = z.object({ server: z.string().min(8).max(36) });

async function access(req: FastifyRequest, permission: ServerPermission) {
  const { server: id } = serverParam.parse(req.params);
  return resolveServerAccess(req.user!, id, permission);
}

/** Push config changes to the daemon; harmless to skip while the server is still installing. */
async function syncIfInstalled(app: FastifyInstance, server: Server & { node: Node }) {
  if (server.status === 'INSTALLING') return;
  await syncServer(app, server);
}

/** Tell the daemon to drop console/transfer tokens a user already holds. Best effort. */
async function revokeTokens(app: FastifyInstance, server: Server & { node: Node }, userId: string, log: FastifyRequest['log']) {
  try {
    await daemonRequest(server.node, app.encrypter, 'POST', `/api/servers/${server.uuid}/ws/deny`, { users: [userId] });
  } catch (err) {
    log.warn({ err, server: server.uuid }, 'could not revoke websocket tokens; they expire within 10 minutes');
  }
}

// --- Subusers --------------------------------------------------------------------------------------

const permissionsSchema = z
  .array(z.string())
  .max(100)
  .transform((list) => [...new Set(list)])
  .refine((list) => list.every(isServerPermission), 'Unknown permission');

export const clientSubuserRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireUser);

  /** Subusers may only hand out permissions they hold themselves. */
  function assertGrantable(granted: string[], actor: string[]) {
    if (actor.includes(PERMISSION_ALL)) return;
    const extra = granted.filter((p) => !actor.includes(p));
    if (extra.length) throw forbidden(`You cannot grant permissions you do not have: ${extra.join(', ')}`);
  }

  const serialize = (s: { id: number; permissions: string[]; createdAt: Date; user: { id: string; username: string; email: string } }) => ({
    id: s.id,
    permissions: s.permissions,
    createdAt: s.createdAt,
    user: s.user,
  });
  const userSelect = { user: { select: { id: true, username: true, email: true } } };

  app.get('/', async (req) => {
    const { server } = await access(req, 'user.read');
    const subusers = await prisma.subuser.findMany({ where: { serverId: server.id }, include: userSelect, orderBy: { createdAt: 'asc' } });
    return { data: subusers.map(serialize) };
  });

  app.post('/', async (req) => {
    const { server, permissions: actor } = await access(req, 'user.create');
    const body = z.object({ email: z.email(), permissions: permissionsSchema }).parse(req.body);
    assertGrantable(body.permissions, actor);
    const user = await prisma.user.findUnique({ where: { email: body.email.toLowerCase() } });
    if (!user) throw new HttpError(404, 'not_found', 'No account uses that email address. Ask them to sign up first, or have an admin create the account.');
    if (user.id === server.ownerId) throw conflict('That user already owns this server.');
    const subuser = await prisma.subuser.create({ data: { userId: user.id, serverId: server.id, permissions: body.permissions }, include: userSelect });
    await logActivity(req, 'server:subuser.create', { serverId: server.id, properties: { email: user.email, permissions: body.permissions } });
    void notify({ encrypter: app.encrypter, log: req.log }, 'subuserAdded', user.email, {
      name: displayName(user),
      serverName: server.name,
      inviter: req.user!.username,
      serverUrl: `${app.config.APP_URL.replace(/\/$/, '')}/server/${server.shortId}`,
    });
    return serialize(subuser);
  });

  app.patch('/:id', async (req) => {
    const { server, permissions: actor } = await access(req, 'user.update');
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const body = z.object({ permissions: permissionsSchema }).parse(req.body);
    const subuser = await prisma.subuser.findFirst({ where: { id, serverId: server.id } });
    if (!subuser) throw notFound('Subuser');
    if (subuser.userId === req.user!.id) throw forbidden('You cannot change your own permissions.');
    assertGrantable(body.permissions, actor);
    const updated = await prisma.subuser.update({ where: { id }, data: { permissions: body.permissions }, include: userSelect });
    await revokeTokens(app, server, subuser.userId, req.log);
    await logActivity(req, 'server:subuser.update', { serverId: server.id, properties: { email: updated.user.email, permissions: body.permissions } });
    return serialize(updated);
  });

  app.delete('/:id', async (req) => {
    const { server } = await access(req, 'user.delete');
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const subuser = await prisma.subuser.findFirst({ where: { id, serverId: server.id }, include: userSelect });
    if (!subuser) throw notFound('Subuser');
    if (subuser.userId === req.user!.id) throw forbidden('You cannot remove yourself.');
    await prisma.subuser.delete({ where: { id } });
    await revokeTokens(app, server, subuser.userId, req.log);
    await logActivity(req, 'server:subuser.delete', { serverId: server.id, properties: { email: subuser.user.email } });
    return { ok: true };
  });
};

// --- Startup ---------------------------------------------------------------------------------------

export const clientStartupRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireUser);

  async function loadFull(serverId: number) {
    return prisma.server.findUniqueOrThrow({
      where: { id: serverId },
      include: { egg: { include: { variables: { orderBy: { sort: 'asc' } } } }, variables: true },
    });
  }

  app.get('/', async (req) => {
    const { server, permissions } = await access(req, 'startup.read');
    const full = await loadFull(server.id);
    const values = new Map(full.variables.map((v) => [v.variableId, v.value]));
    const variables = full.egg.variables
      .filter((v) => v.userViewable || req.user!.rootAdmin)
      .map((v) => ({
        name: v.name,
        description: v.description,
        envVariable: v.envVariable,
        defaultValue: v.defaultValue,
        value: values.get(v.id) ?? v.defaultValue,
        editable: v.userEditable || req.user!.rootAdmin,
        rules: v.rules,
      }));
    const env = Object.fromEntries(variables.map((v) => [v.envVariable, v.value]));
    return {
      startup: full.startup,
      // What actually runs, with variables filled in (hidden ones stay as placeholders).
      rendered: full.startup.replace(/\{\{\s*([A-Z0-9_]+)\s*\}\}/gi, (whole, key: string) => env[key] ?? whole),
      image: full.image,
      dockerImages: full.egg.dockerImages as Record<string, string>,
      canChangeImage: permissions.includes(PERMISSION_ALL) || permissions.includes('startup.docker-image'),
      canEdit: permissions.includes(PERMISSION_ALL) || permissions.includes('startup.update'),
      variables,
    };
  });

  app.put('/variable', async (req) => {
    const { server } = await access(req, 'startup.update');
    const body = z.object({ key: z.string().min(1), value: z.string().max(4096) }).parse(req.body);
    const full = await loadFull(server.id);
    const variable = full.egg.variables.find((v) => v.envVariable === body.key);
    if (!variable || (!req.user!.rootAdmin && (!variable.userViewable || !variable.userEditable))) {
      throw forbidden('That variable cannot be changed.');
    }
    const error = validateVariable(body.value, variable.rules, variable.name);
    if (error) throw unprocessable(error, [{ path: 'value', message: error }]);
    await prisma.serverVariable.upsert({
      where: { serverId_variableId: { serverId: server.id, variableId: variable.id } },
      create: { serverId: server.id, variableId: variable.id, value: body.value },
      update: { value: body.value },
    });
    await syncIfInstalled(app, server);
    await logActivity(req, 'server:startup.variable', { serverId: server.id, properties: { variable: body.key, value: body.value } });
    return { key: body.key, value: body.value };
  });

  app.put('/image', async (req) => {
    const { server } = await access(req, 'startup.docker-image');
    const { image } = z.object({ image: z.string().min(1) }).parse(req.body);
    const full = await loadFull(server.id);
    const allowed = Object.values(full.egg.dockerImages as Record<string, string>);
    // Admins may have set a custom image; users can only switch between the egg's images.
    if (!allowed.includes(image) && !req.user!.rootAdmin) throw forbidden('That image is not available for this server.');
    const updated = await prisma.server.update({ where: { id: server.id }, data: { image }, include: { node: true } });
    await syncIfInstalled(app, updated);
    await logActivity(req, 'server:startup.image', { serverId: server.id, properties: { image } });
    return { image };
  });
};

// --- Network ---------------------------------------------------------------------------------------

export const clientNetworkRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireUser);

  const allocationParam = z.object({ server: z.string(), allocation: z.coerce.number().int() });

  async function owned(serverId: number, allocationId: number) {
    const allocation = await prisma.allocation.findFirst({ where: { id: allocationId, serverId } });
    if (!allocation) throw notFound('Allocation');
    return allocation;
  }

  /** Assign another free port from the same node, preferring the primary allocation's IP. */
  app.post('/allocations', async (req) => {
    const { server } = await access(req, 'allocation.create');
    assertServerUsable(server);
    const assigned = await prisma.allocation.count({ where: { serverId: server.id } });
    // The limit counts additional ports; the primary one is always allowed.
    if (assigned - 1 >= server.allocationLimit) throw conflict(`This server can have at most ${server.allocationLimit} additional port(s).`);
    const primary = await prisma.allocation.findUniqueOrThrow({ where: { id: server.allocationId } });
    const free =
      (await prisma.allocation.findFirst({ where: { nodeId: server.nodeId, serverId: null, primaryServer: { is: null }, ip: primary.ip }, orderBy: { port: 'asc' } })) ??
      (await prisma.allocation.findFirst({ where: { nodeId: server.nodeId, serverId: null, primaryServer: { is: null } }, orderBy: { port: 'asc' } }));
    if (!free) throw conflict('There are no free ports on this node. Ask an administrator to add more.');
    const { count } = await prisma.allocation.updateMany({ where: { id: free.id, serverId: null }, data: { serverId: server.id } });
    if (!count) throw conflict('That port was just taken. Try again.');
    await syncIfInstalled(app, server);
    await logActivity(req, 'server:allocation.create', { serverId: server.id, properties: { address: `${free.ip}:${free.port}` } });
    return { ...free, serverId: server.id };
  });

  app.patch('/allocations/:allocation', async (req) => {
    const { server } = await access(req, 'allocation.update');
    const { allocation: id } = allocationParam.parse(req.params);
    await owned(server.id, id);
    const { notes } = z.object({ notes: z.string().max(255).nullable() }).parse(req.body);
    return prisma.allocation.update({ where: { id }, data: { notes } });
  });

  app.post('/allocations/:allocation/primary', async (req) => {
    const { server } = await access(req, 'allocation.update');
    const { allocation: id } = allocationParam.parse(req.params);
    const allocation = await owned(server.id, id);
    const updated = await prisma.server.update({ where: { id: server.id }, data: { allocationId: id }, include: { node: true } });
    await syncIfInstalled(app, updated);
    await logActivity(req, 'server:allocation.primary', { serverId: server.id, properties: { address: `${allocation.ip}:${allocation.port}` } });
    return { ok: true };
  });

  app.delete('/allocations/:allocation', async (req) => {
    const { server } = await access(req, 'allocation.delete');
    const { allocation: id } = allocationParam.parse(req.params);
    const allocation = await owned(server.id, id);
    if (allocation.id === server.allocationId) throw conflict('You cannot remove the primary port. Make another port primary first.');
    await prisma.allocation.update({ where: { id }, data: { serverId: null, notes: null } });
    await syncIfInstalled(app, server);
    await logActivity(req, 'server:allocation.delete', { serverId: server.id, properties: { address: `${allocation.ip}:${allocation.port}` } });
    return { ok: true };
  });
};

// --- Settings --------------------------------------------------------------------------------------

export const clientSettingsRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireUser);

  app.post('/rename', async (req) => {
    const { server } = await access(req, 'settings.rename');
    const body = z.object({ name: z.string().trim().min(1).max(191), description: z.string().max(1000).nullable().optional() }).parse(req.body);
    await prisma.server.update({ where: { id: server.id }, data: body });
    await logActivity(req, 'server:settings.rename', { serverId: server.id, properties: { from: server.name, to: body.name } });
    return { ok: true };
  });

  app.post('/reinstall', async (req) => {
    const { server } = await access(req, 'settings.reinstall');
    assertServerUsable(server);
    await prisma.server.update({ where: { id: server.id }, data: { status: 'INSTALLING' } });
    try {
      await daemonRequest(server.node, app.encrypter, 'POST', `/api/servers/${server.uuid}/reinstall`);
    } catch (err) {
      await prisma.server.update({ where: { id: server.id }, data: { status: server.status } });
      throw err;
    }
    await logActivity(req, 'server:settings.reinstall', { serverId: server.id });
    return { ok: true };
  });
};
