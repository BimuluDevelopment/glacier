import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../db';
import { notFound } from '../../lib/errors';
import { logActivity } from '../../lib/activity';
import { idParam } from '../../lib/http';
import { requireAdmin } from '../../plugins/auth';

const templateSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().max(500).default(''),
  eggId: z.number().int().positive(),
  image: z.string().min(1).nullable().default(null),
  memory: z.number().int().min(0),
  swap: z.number().int().min(-1).default(0),
  disk: z.number().int().min(0),
  cpu: z.number().int().min(0).default(0),
  io: z.number().int().min(10).max(1000).default(500),
  databaseLimit: z.number().int().min(0).default(0),
  allocationLimit: z.number().int().min(0).default(0),
  backupLimit: z.number().int().min(0).default(0),
  environment: z.record(z.string(), z.string()).default({}),
});

/** /api/admin/server-templates — presets for "New server". */
export const serverTemplateRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireAdmin);

  app.get('/', async () => ({
    data: await prisma.serverTemplate.findMany({ orderBy: { name: 'asc' }, include: { egg: { select: { id: true, name: true } } } }),
  }));

  app.post('/', async (req) => {
    const body = templateSchema.parse(req.body);
    if (!(await prisma.egg.findUnique({ where: { id: body.eggId } }))) throw notFound('Egg');
    const t = await prisma.serverTemplate.create({ data: body });
    await logActivity(req, 'admin:server-template.create', { properties: { name: t.name } });
    return t;
  });

  app.patch('/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const t = await prisma.serverTemplate.update({ where: { id }, data: templateSchema.partial().parse(req.body) });
    await logActivity(req, 'admin:server-template.update', { properties: { name: t.name } });
    return t;
  });

  app.delete('/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const t = await prisma.serverTemplate.delete({ where: { id } });
    await logActivity(req, 'admin:server-template.delete', { properties: { name: t.name } });
    return { ok: true };
  });
};
