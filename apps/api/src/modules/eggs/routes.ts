import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { nestSchema } from '@glacier/shared';
import { EggParseError, parseEgg, toPtdl } from '@glacier/eggs';
import { prisma } from '../../db';
import { conflict, notFound, unprocessable } from '../../lib/errors';
import { logActivity } from '../../lib/activity';
import { idParam } from '../../lib/http';
import { requireAdmin } from '../../plugins/auth';
import { ensureBundledEggs, toDefinition, upsertEgg } from './service';

const importSchema = z.object({
  nestId: z.number().int().positive(),
  egg: z.unknown(),
  /** When an egg with the same uuid exists: update it instead of failing. */
  updateExisting: z.boolean().default(false),
});

const eggPatchSchema = z.object({
  name: z.string().min(1).max(191).optional(),
  description: z.string().max(2000).nullable().optional(),
  startup: z.string().min(1).optional(),
  dockerImages: z.record(z.string(), z.string().min(1)).refine((v) => Object.keys(v).length > 0, 'At least one image').optional(),
  stopCommand: z.string().min(1).optional(),
  startupDone: z.array(z.string()).optional(),
  installScript: z.string().optional(),
  installContainer: z.string().min(1).optional(),
  installEntrypoint: z.string().min(1).optional(),
  fileDenylist: z.array(z.string()).optional(),
});

export const eggRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireAdmin);

  app.get('/nests', async () => ({
    data: await prisma.nest.findMany({
      orderBy: { name: 'asc' },
      include: { eggs: { select: { id: true, uuid: true, name: true, description: true, _count: { select: { servers: true } } }, orderBy: { name: 'asc' } } },
    }),
  }));

  app.post('/nests', async (req) => {
    const nest = await prisma.nest.create({ data: nestSchema.parse(req.body) });
    await logActivity(req, 'admin:nest.create', { properties: { nestId: nest.id } });
    return nest;
  });

  app.delete('/nests/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    if ((await prisma.egg.count({ where: { nestId: id } })) > 0) throw conflict('Delete the eggs in this nest first.');
    await prisma.nest.delete({ where: { id } });
    return { ok: true };
  });

  app.post('/eggs/bundled', async (req) => {
    await ensureBundledEggs();
    await logActivity(req, 'admin:egg.seed-bundled');
    return { ok: true };
  });

  app.get('/eggs/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const egg = await prisma.egg.findUnique({
      where: { id },
      include: { nest: true, variables: { orderBy: { sort: 'asc' } }, _count: { select: { servers: true } } },
    });
    if (!egg) throw notFound('Egg');
    return egg;
  });

  app.post('/eggs/import', async (req) => {
    const body = importSchema.parse(req.body);
    if (!(await prisma.nest.findUnique({ where: { id: body.nestId } }))) throw notFound('Nest');
    let def;
    try {
      def = parseEgg(body.egg);
    } catch (err) {
      if (err instanceof EggParseError) throw unprocessable(err.message, err.issues.map((message) => ({ path: 'egg', message })));
      throw err;
    }
    const existing = def.uuid ? await prisma.egg.findUnique({ where: { uuid: def.uuid } }) : null;
    if (existing && !body.updateExisting) throw conflict(`An egg with this UUID already exists ("${existing.name}"). Enable "update existing" to overwrite it.`);
    const egg = await upsertEgg(body.nestId, def, existing?.id);
    await logActivity(req, existing ? 'admin:egg.update' : 'admin:egg.import', { properties: { eggId: egg.id, name: egg.name } });
    return egg;
  });

  app.patch('/eggs/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const egg = await prisma.egg.update({ where: { id }, data: eggPatchSchema.parse(req.body) });
    await logActivity(req, 'admin:egg.update', { properties: { eggId: id } });
    return egg;
  });

  app.get('/eggs/:id/export', async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const egg = await prisma.egg.findUnique({ where: { id }, include: { variables: true } });
    if (!egg) throw notFound('Egg');
    const filename = `egg-${egg.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.json`;
    reply.header('content-disposition', `attachment; filename="${filename}"`);
    return toPtdl(toDefinition(egg));
  });

  app.delete('/eggs/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    if ((await prisma.server.count({ where: { eggId: id } })) > 0) throw conflict('Servers still use this egg.');
    await prisma.egg.delete({ where: { id } });
    await logActivity(req, 'admin:egg.delete', { properties: { eggId: id } });
    return { ok: true };
  });
};
