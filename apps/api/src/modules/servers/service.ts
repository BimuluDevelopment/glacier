import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Node, Prisma, Server, User } from '@prisma/client';
import { PERMISSION_ALL, hasPermission, serverCreateSchema, type ServerPermission } from '@glacier/shared';
import { validateVariable } from '@glacier/eggs';
import { prisma } from '../../db';
import { conflict, forbidden, notFound, unprocessable } from '../../lib/errors';
import { daemonRequest } from '../nodes/daemon-client';

type CreateInput = ReturnType<typeof serverCreateSchema.parse>;

/** Validate egg variable values against their rules. Unknown keys are ignored. */
export function resolveVariables(
  variables: { id: number; name: string; envVariable: string; defaultValue: string; rules: string; userEditable: boolean }[],
  provided: Record<string, string>,
  opts: { onlyUserEditable?: boolean } = {},
) {
  const errors: { path: string; message: string }[] = [];
  const values: { variableId: number; value: string }[] = [];
  for (const v of variables) {
    if (opts.onlyUserEditable && !v.userEditable && v.envVariable in provided) {
      errors.push({ path: `environment.${v.envVariable}`, message: `${v.name} cannot be changed` });
      continue;
    }
    const value = provided[v.envVariable] ?? v.defaultValue;
    const error = validateVariable(value, v.rules, v.name);
    if (error) errors.push({ path: `environment.${v.envVariable}`, message: error });
    values.push({ variableId: v.id, value });
  }
  if (errors.length) throw unprocessable(errors[0]!.message, errors);
  return values;
}

async function assertCapacity(node: Node, memory: number, disk: number, excludeServerId?: number) {
  const used = await prisma.server.aggregate({
    where: { nodeId: node.id, ...(excludeServerId ? { id: { not: excludeServerId } } : {}) },
    _sum: { memory: true, disk: true },
  });
  const check = (label: string, total: number, overallocate: number, current: number, wanted: number) => {
    if (overallocate === -1 || total === 0) return;
    const limit = total * (1 + overallocate / 100);
    if (current + wanted > limit) {
      throw conflict(`Node "${node.name}" does not have enough ${label} (${Math.max(0, Math.floor(limit - current))} MiB free).`);
    }
  };
  check('memory', node.memory, node.memoryOverallocate, used._sum.memory ?? 0, memory);
  check('disk space', node.disk, node.diskOverallocate, used._sum.disk ?? 0, disk);
}

/** Network membership for servers created from a proxy's page. */
type NetworkFields = Pick<Prisma.ServerUncheckedCreateInput, 'proxyId' | 'networkName' | 'networkOrder' | 'networkFallback' | 'networkManaged'>;

export async function createServer(app: FastifyInstance, input: CreateInput, network: NetworkFields = {}): Promise<Server> {
  const [owner, egg, allocation] = await Promise.all([
    prisma.user.findUnique({ where: { id: input.ownerId } }),
    prisma.egg.findUnique({ where: { id: input.eggId }, include: { variables: true } }),
    prisma.allocation.findUnique({ where: { id: input.allocationId }, include: { node: true, primaryServer: true } }),
  ]);
  if (!owner) throw unprocessable('That owner does not exist.', [{ path: 'ownerId', message: 'Unknown user' }]);
  if (!egg) throw unprocessable('That egg does not exist.', [{ path: 'eggId', message: 'Unknown egg' }]);
  if (!allocation) throw unprocessable('That allocation does not exist.', [{ path: 'allocationId', message: 'Unknown allocation' }]);
  if (allocation.serverId || allocation.primaryServer) throw conflict('That allocation is already in use.');
  const node = allocation.node;
  if (node.maintenance) throw conflict(`Node "${node.name}" is in maintenance mode.`);
  if (!node.secretEncrypted) throw conflict(`Node "${node.name}" has not been paired with a daemon yet.`);

  const extraIds = input.additionalAllocationIds.filter((id) => id !== allocation.id);
  if (extraIds.length) {
    const free = await prisma.allocation.count({ where: { id: { in: extraIds }, nodeId: node.id, serverId: null, primaryServer: { is: null } } });
    if (free !== extraIds.length) throw conflict('One or more additional allocations are unavailable or on a different node.');
  }

  await assertCapacity(node, input.memory, input.disk);
  const variableValues = resolveVariables(egg.variables, input.environment);
  const images = Object.values(egg.dockerImages as Record<string, string>);

  const uuid = randomUUID();
  const server = await prisma.$transaction(async (tx) => {
    const created = await tx.server.create({
      data: {
        uuid,
        shortId: uuid.slice(0, 8),
        name: input.name,
        description: input.description,
        ownerId: owner.id,
        nodeId: node.id,
        eggId: egg.id,
        allocationId: allocation.id,
        memory: input.memory,
        swap: input.swap,
        disk: input.disk,
        io: input.io,
        cpu: input.cpu,
        threads: input.threads || null,
        oomKiller: input.oomKiller,
        databaseLimit: input.databaseLimit,
        allocationLimit: input.allocationLimit,
        backupLimit: input.backupLimit,
        networkServerLimit: input.networkServerLimit,
        networkMemoryLimit: input.networkMemoryLimit,
        networkDiskLimit: input.networkDiskLimit,
        networkCpuLimit: input.networkCpuLimit,
        image: input.image ?? images[0]!,
        startup: input.startup ?? egg.startup,
        variables: { create: variableValues },
        ...network,
      },
    });
    const ids = [allocation.id, ...extraIds];
    const { count } = await tx.allocation.updateMany({ where: { id: { in: ids }, serverId: null }, data: { serverId: created.id } });
    if (count !== ids.length) throw conflict('An allocation was taken while creating the server. Please try again.');
    return created;
  });

  try {
    await daemonRequest(node, app.encrypter, 'POST', '/api/servers', { uuid: server.uuid, startOnCompletion: input.startOnCompletion });
  } catch (err) {
    // Keep panel and daemon consistent: if the daemon never heard about the server, remove it.
    await prisma.server.delete({ where: { id: server.id } });
    throw err;
  }
  return server;
}

/** Ask the daemon to re-fetch a server's configuration (after limit, image or variable changes). */
export async function syncServer(app: FastifyInstance, server: Server & { node: Node }) {
  await daemonRequest(server.node, app.encrypter, 'POST', `/api/servers/${server.uuid}/sync`);
}

/**
 * Load a server by uuid or short id for the current user and work out their permissions.
 * Users without any access get a 404 so server ids cannot be probed.
 */
export async function resolveServerAccess(user: User, identifier: string, needed?: ServerPermission) {
  const server = await prisma.server.findFirst({
    where: identifier.length === 36 ? { uuid: identifier } : { shortId: identifier },
    include: { node: true, subusers: { where: { userId: user.id } } },
  });
  if (!server) throw notFound('Server');

  let permissions: string[];
  if (user.rootAdmin || server.ownerId === user.id) permissions = [PERMISSION_ALL];
  else if (server.subusers[0]) permissions = server.subusers[0].permissions;
  else throw notFound('Server');

  if (needed && !hasPermission(permissions, needed)) throw forbidden();
  return { server, permissions };
}

export function assertServerUsable(server: Server) {
  if (server.status === 'SUSPENDED') throw conflict('This server is suspended.');
  if (server.status === 'INSTALLING') throw conflict('This server is still installing.');
}
