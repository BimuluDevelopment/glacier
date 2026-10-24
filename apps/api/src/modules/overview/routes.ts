import type { FastifyPluginAsync } from 'fastify';
import type { DaemonSystemInfo } from '@glacier/shared';
import { prisma } from '../../db';
import { VERSION } from '../../config';
import { requireAdmin } from '../../plugins/auth';
import { daemonRequest } from '../nodes/daemon-client';

export const overviewRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireAdmin);

  app.get('/', async () => {
    const [users, servers, nodes, eggs, byStatus, recent] = await Promise.all([
      prisma.user.count(),
      prisma.server.count(),
      prisma.node.findMany({ orderBy: { name: 'asc' } }),
      prisma.egg.count(),
      prisma.server.groupBy({ by: ['status'], _count: true }),
      prisma.activityLog.findMany({ orderBy: { createdAt: 'desc' }, take: 15, include: { actor: { select: { username: true } } } }),
    ]);

    // Ping every paired daemon in parallel with a short timeout so one dead node cannot stall the page.
    const nodeStatus = await Promise.all(
      nodes.map(async (node) => {
        if (!node.secretEncrypted) return { id: node.id, name: node.name, state: 'unpaired' as const };
        try {
          const info = await daemonRequest<DaemonSystemInfo>(node, app.encrypter, 'GET', '/api/system', undefined, 2_500);
          return { id: node.id, name: node.name, state: 'online' as const, info };
        } catch {
          return { id: node.id, name: node.name, state: 'offline' as const, lastSeenAt: node.lastSeenAt };
        }
      }),
    );

    return {
      version: VERSION,
      counts: { users, servers, nodes: nodes.length, eggs },
      serversByStatus: Object.fromEntries(byStatus.map((s) => [s.status, s._count])),
      nodes: nodeStatus,
      recentActivity: recent,
    };
  });

  app.get('/activity', async (req) => {
    const { before } = req.query as { before?: string };
    const rows = await prisma.activityLog.findMany({
      where: before ? { createdAt: { lt: new Date(before) } } : {},
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: { actor: { select: { username: true } }, server: { select: { name: true, shortId: true } } },
    });
    return { data: rows };
  });
};
