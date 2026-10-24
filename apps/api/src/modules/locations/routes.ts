import type { FastifyPluginAsync } from 'fastify';
import { locationSchema } from '@glacier/shared';
import { prisma } from '../../db';
import { conflict } from '../../lib/errors';
import { logActivity } from '../../lib/activity';
import { idParam } from '../../lib/http';
import { requireAdmin } from '../../plugins/auth';

export const locationRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireAdmin);

  app.get('/', async () => ({
    data: await prisma.location.findMany({ orderBy: { short: 'asc' }, include: { _count: { select: { nodes: true } } } }),
  }));

  app.post('/', async (req) => {
    const location = await prisma.location.create({ data: locationSchema.parse(req.body) });
    await logActivity(req, 'admin:location.create', { properties: { short: location.short } });
    return location;
  });

  app.patch('/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const location = await prisma.location.update({ where: { id }, data: locationSchema.partial().parse(req.body) });
    await logActivity(req, 'admin:location.update', { properties: { id } });
    return location;
  });

  app.delete('/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    if ((await prisma.node.count({ where: { locationId: id } })) > 0) throw conflict('Move or delete the nodes in this location first.');
    await prisma.location.delete({ where: { id } });
    await logActivity(req, 'admin:location.delete', { properties: { id } });
    return { ok: true };
  });
};
