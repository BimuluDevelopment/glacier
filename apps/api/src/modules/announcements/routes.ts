import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../db';
import { logActivity } from '../../lib/activity';
import { idParam } from '../../lib/http';
import { requireAdmin, requireUser } from '../../plugins/auth';
import { getSection } from '../settings/service';

const announcementSchema = z
  .object({
    title: z.string().trim().min(1).max(160),
    body: z.string().max(10_000).default(''),
    tone: z.enum(['primary', 'success', 'warning', 'danger']).default('primary'),
    active: z.boolean().default(true),
    startsAt: z.coerce.date().nullable().default(null),
    endsAt: z.coerce.date().nullable().default(null),
  })
  .refine((a) => !a.startsAt || !a.endsAt || a.startsAt < a.endsAt, { path: ['endsAt'], message: 'Must be after the start' });

export const adminAnnouncementRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireAdmin);

  app.get('/', async () => ({ data: await prisma.announcement.findMany({ orderBy: { createdAt: 'desc' } }) }));

  app.post('/', async (req) => {
    const a = await prisma.announcement.create({ data: announcementSchema.parse(req.body) });
    await logActivity(req, 'admin:announcement.create', { properties: { title: a.title } });
    return a;
  });

  app.patch('/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const current = await prisma.announcement.findUniqueOrThrow({ where: { id } });
    const data = announcementSchema.parse({ ...current, ...(req.body as object) });
    const a = await prisma.announcement.update({ where: { id }, data });
    await logActivity(req, 'admin:announcement.update', { properties: { title: a.title } });
    return a;
  });

  app.delete('/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const a = await prisma.announcement.delete({ where: { id } });
    await logActivity(req, 'admin:announcement.delete', { properties: { title: a.title } });
    return { ok: true };
  });
};

/** What signed-in users see on their dashboard right now. */
export const clientAnnouncementRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireUser);

  app.get('/', async () => {
    if (!(await getSection('features')).announcements) return { data: [] };
    const now = new Date();
    return {
      data: await prisma.announcement.findMany({
        where: {
          active: true,
          AND: [{ OR: [{ startsAt: null }, { startsAt: { lte: now } }] }, { OR: [{ endsAt: null }, { endsAt: { gt: now } }] }],
        },
        orderBy: { createdAt: 'desc' },
        select: { id: true, title: true, body: true, tone: true, updatedAt: true },
      }),
    };
  });
};
