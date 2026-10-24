import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ServerPermission } from '@glacier/shared';
import { prisma } from '../../db';
import { conflict, notFound } from '../../lib/errors';
import { logActivity } from '../../lib/activity';
import { requireUser } from '../../plugins/auth';
import { resolveServerAccess } from '../servers/service';
import { MAX_TASKS_PER_SCHEDULE, nextRun, scheduleSchema, taskSchema } from './service';

const params = z.object({
  server: z.string().min(8).max(36),
  schedule: z.coerce.number().int().positive().optional(),
  task: z.coerce.number().int().positive().optional(),
});

const include = { tasks: { orderBy: { sequence: 'asc' as const } } };

export const clientScheduleRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireUser);

  async function load(req: FastifyRequest, permission: ServerPermission) {
    const p = params.parse(req.params);
    const { server } = await resolveServerAccess(req.user!, p.server, permission);
    if (!p.schedule) return { server, schedule: null, taskId: p.task };
    const schedule = await prisma.schedule.findFirst({ where: { id: p.schedule, serverId: server.id }, include });
    if (!schedule) throw notFound('Schedule');
    return { server, schedule, taskId: p.task };
  }

  app.get('/', async (req) => {
    const { server } = await load(req, 'schedule.read');
    return { data: await prisma.schedule.findMany({ where: { serverId: server.id }, include, orderBy: { name: 'asc' } }) };
  });

  app.get('/:schedule', async (req) => (await load(req, 'schedule.read')).schedule);

  app.post('/', async (req) => {
    const { server } = await load(req, 'schedule.create');
    const body = scheduleSchema.parse(req.body);
    const schedule = await prisma.schedule.create({
      data: { ...body, serverId: server.id, nextRunAt: await nextRun(body) },
      include,
    });
    await logActivity(req, 'server:schedule.create', { serverId: server.id, properties: { name: schedule.name } });
    return schedule;
  });

  app.patch('/:schedule', async (req) => {
    const { server, schedule } = await load(req, 'schedule.update');
    const body = scheduleSchema.partial().parse(req.body);
    const merged = { ...schedule!, ...body };
    const updated = await prisma.schedule.update({
      where: { id: schedule!.id },
      data: { ...body, nextRunAt: await nextRun(merged) },
      include,
    });
    await logActivity(req, 'server:schedule.update', { serverId: server.id, properties: { name: updated.name } });
    return updated;
  });

  app.delete('/:schedule', async (req) => {
    const { server, schedule } = await load(req, 'schedule.delete');
    await prisma.schedule.delete({ where: { id: schedule!.id } });
    await logActivity(req, 'server:schedule.delete', { serverId: server.id, properties: { name: schedule!.name } });
    return { ok: true };
  });

  app.post('/:schedule/execute', async (req) => {
    const { server, schedule } = await load(req, 'schedule.update');
    if (!schedule!.tasks.length) throw conflict('Add at least one task before running this schedule.');
    if (schedule!.isProcessing) throw conflict('This schedule is already running.');
    void app.schedules.run(schedule!.id, true);
    await logActivity(req, 'server:schedule.execute', { serverId: server.id, properties: { name: schedule!.name } });
    return { ok: true };
  });

  // --- Tasks -------------------------------------------------------------------------------------

  app.post('/:schedule/tasks', async (req) => {
    const { server, schedule } = await load(req, 'schedule.update');
    if (schedule!.tasks.length >= MAX_TASKS_PER_SCHEDULE) throw conflict(`A schedule can have at most ${MAX_TASKS_PER_SCHEDULE} tasks.`);
    const body = taskSchema.parse(req.body);
    if (body.action === 'backup' && server.backupLimit <= 0) throw conflict('This server does not allow backups.');
    const sequence = (schedule!.tasks.at(-1)?.sequence ?? 0) + 1;
    const task = await prisma.scheduleTask.create({ data: { ...body, scheduleId: schedule!.id, sequence } });
    await logActivity(req, 'server:schedule.task.create', { serverId: server.id, properties: { schedule: schedule!.name, action: task.action } });
    return task;
  });

  app.patch('/:schedule/tasks/:task', async (req) => {
    const { server, schedule, taskId } = await load(req, 'schedule.update');
    const task = schedule!.tasks.find((t) => t.id === taskId);
    if (!task) throw notFound('Task');
    const body = taskSchema.parse({ ...task, ...(req.body as object) });
    const updated = await prisma.scheduleTask.update({ where: { id: task.id }, data: body });
    await logActivity(req, 'server:schedule.task.update', { serverId: server.id, properties: { schedule: schedule!.name } });
    return updated;
  });

  app.delete('/:schedule/tasks/:task', async (req) => {
    const { server, schedule, taskId } = await load(req, 'schedule.update');
    const task = schedule!.tasks.find((t) => t.id === taskId);
    if (!task) throw notFound('Task');
    await prisma.$transaction([
      prisma.scheduleTask.delete({ where: { id: task.id } }),
      // Keep sequences contiguous.
      prisma.scheduleTask.updateMany({ where: { scheduleId: schedule!.id, sequence: { gt: task.sequence } }, data: { sequence: { decrement: 1 } } }),
    ]);
    await logActivity(req, 'server:schedule.task.delete', { serverId: server.id, properties: { schedule: schedule!.name } });
    return { ok: true };
  });
};
