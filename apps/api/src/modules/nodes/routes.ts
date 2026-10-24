import type { FastifyPluginAsync } from 'fastify';
import type { Node } from '@prisma/client';
import { z } from 'zod';
import { allocationCreateSchema, nodeSchema, parsePortList, type DaemonSystemInfo } from '@glacier/shared';
import { prisma } from '../../db';
import { conflict, notFound, unprocessable } from '../../lib/errors';
import { randomToken, sha256 } from '../../lib/crypto';
import { logActivity } from '../../lib/activity';
import { idParam } from '../../lib/http';
import { requireAdmin } from '../../plugins/auth';
import { daemonRequest } from './daemon-client';

const PAIRING_TTL_MS = 60 * 60_000;

export function serializeNode(node: Node) {
  const { secretEncrypted, pairingTokenHash: _pairingTokenHash, ...rest } = node;
  return { ...rest, paired: Boolean(secretEncrypted) };
}

export const nodeRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireAdmin);

  async function issuePairingToken(nodeId: number) {
    const token = randomToken(24);
    const expiresAt = new Date(Date.now() + PAIRING_TTL_MS);
    await prisma.node.update({ where: { id: nodeId }, data: { pairingTokenHash: sha256(token), pairingExpiresAt: expiresAt } });
    const panel = app.config.APP_URL.replace(/\/$/, '');
    return {
      token,
      expiresAt,
      command: `glacierd pair --panel ${panel} --token ${token}`,
      installCommand: `curl -fsSL ${panel}/install.sh | sudo bash -s -- daemon --panel ${panel} --token ${token}`,
    };
  }

  app.get('/', async () => {
    const nodes = await prisma.node.findMany({
      orderBy: { name: 'asc' },
      include: { location: true, _count: { select: { servers: true, allocations: true } } },
    });
    const usage = await prisma.server.groupBy({ by: ['nodeId'], _sum: { memory: true, disk: true } });
    const byNode = new Map(usage.map((u) => [u.nodeId, u._sum]));
    return {
      data: nodes.map((n) => ({
        ...serializeNode(n),
        location: n.location,
        serverCount: n._count.servers,
        allocationCount: n._count.allocations,
        allocatedMemory: byNode.get(n.id)?.memory ?? 0,
        allocatedDisk: byNode.get(n.id)?.disk ?? 0,
      })),
    };
  });

  app.get('/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const node = await prisma.node.findUnique({ where: { id }, include: { location: true } });
    if (!node) throw notFound('Node');
    return { ...serializeNode(node), location: node.location };
  });

  app.post('/', async (req) => {
    const body = nodeSchema.parse(req.body);
    const node = await prisma.node.create({ data: body });
    await logActivity(req, 'admin:node.create', { properties: { nodeId: node.id, name: node.name } });
    return { node: serializeNode(node), pairing: await issuePairingToken(node.id) };
  });

  app.patch('/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const node = await prisma.node.update({ where: { id }, data: nodeSchema.partial().parse(req.body) });
    await logActivity(req, 'admin:node.update', { properties: { nodeId: id } });
    return serializeNode(node);
  });

  app.delete('/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    if ((await prisma.server.count({ where: { nodeId: id } })) > 0) throw conflict('Delete or transfer the servers on this node first.');
    await prisma.node.delete({ where: { id } });
    await logActivity(req, 'admin:node.delete', { properties: { nodeId: id } });
    return { ok: true };
  });

  /** Issue a new one-time pairing token (also used to re-pair a reinstalled daemon). */
  app.post('/:id/pairing', async (req) => {
    const { id } = idParam.parse(req.params);
    if (!(await prisma.node.findUnique({ where: { id } }))) throw notFound('Node');
    await logActivity(req, 'admin:node.pairing-token', { properties: { nodeId: id } });
    return issuePairingToken(id);
  });

  app.get('/:id/system', async (req) => {
    const { id } = idParam.parse(req.params);
    const node = await prisma.node.findUnique({ where: { id } });
    if (!node) throw notFound('Node');
    return daemonRequest<DaemonSystemInfo>(node, app.encrypter, 'GET', '/api/system', undefined, 5_000);
  });

  // --- Allocations ---------------------------------------------------------------------------

  app.get('/:id/allocations', async (req) => {
    const { id } = idParam.parse(req.params);
    const allocations = await prisma.allocation.findMany({
      where: { nodeId: id },
      orderBy: [{ ip: 'asc' }, { port: 'asc' }],
      include: { server: { select: { id: true, name: true, shortId: true } } },
    });
    return { data: allocations };
  });

  app.post('/:id/allocations', async (req) => {
    const { id } = idParam.parse(req.params);
    const body = allocationCreateSchema.parse(req.body);
    let ports: number[];
    try {
      ports = parsePortList(body.ports);
    } catch (err) {
      throw unprocessable((err as Error).message, [{ path: 'ports', message: (err as Error).message }]);
    }
    const { count } = await prisma.allocation.createMany({
      data: ports.map((port) => ({ nodeId: id, ip: body.ip, ipAlias: body.ipAlias ?? null, port })),
      skipDuplicates: true,
    });
    await logActivity(req, 'admin:allocation.create', { properties: { nodeId: id, ip: body.ip, ports: body.ports } });
    return { created: count, skipped: ports.length - count };
  });

  app.patch('/:id/allocations/:allocationId', async (req) => {
    const { id, allocationId } = z
      .object({ id: z.coerce.number().int(), allocationId: z.coerce.number().int() })
      .parse(req.params);
    const body = z.object({ ipAlias: z.string().max(255).nullable().optional(), notes: z.string().max(255).nullable().optional() }).parse(req.body);
    const { count } = await prisma.allocation.updateMany({ where: { id: allocationId, nodeId: id }, data: body });
    if (!count) throw notFound('Allocation');
    return { ok: true };
  });

  app.delete('/:id/allocations/:allocationId', async (req) => {
    const { id, allocationId } = z
      .object({ id: z.coerce.number().int(), allocationId: z.coerce.number().int() })
      .parse(req.params);
    const { count } = await prisma.allocation.deleteMany({ where: { id: allocationId, nodeId: id, serverId: null, primaryServer: { is: null } } });
    if (!count) throw conflict('That allocation does not exist or is assigned to a server.');
    await logActivity(req, 'admin:allocation.delete', { properties: { nodeId: id, allocationId } });
    return { ok: true };
  });
};
