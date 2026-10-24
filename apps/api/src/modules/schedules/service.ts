import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type { Schedule, ScheduleTask } from '@prisma/client';
import { CronExpressionParser } from 'cron-parser';
import { z } from 'zod';
import { POWER_ACTIONS, type ServerResourceUsage } from '@glacier/shared';
import { prisma } from '../../db';
import { recordActivity } from '../../lib/activity';
import { unprocessable } from '../../lib/errors';
import { daemonRequest } from '../nodes/daemon-client';
import { createBackup } from '../backups/service';
import { getSection } from '../settings/service';

export const MAX_TASKS_PER_SCHEDULE = 10;
const TICK_MS = 10_000;

const cronField = z.string().trim().min(1).max(64).regex(/^[0-9*,/\-A-Za-z?LW#]+$/, 'Invalid cron field');

export const scheduleSchema = z.object({
  name: z.string().trim().min(1).max(191),
  cronMinute: cronField.default('*/5'),
  cronHour: cronField.default('*'),
  cronDayOfMonth: cronField.default('*'),
  cronMonth: cronField.default('*'),
  cronDayOfWeek: cronField.default('*'),
  isActive: z.boolean().default(true),
  onlyWhenOnline: z.boolean().default(false),
});

export const taskSchema = z
  .object({
    action: z.enum(['command', 'power', 'backup']),
    payload: z.string().max(4096).default(''),
    timeOffset: z.number().int().min(0).max(900).default(0),
    continueOnFailure: z.boolean().default(false),
  })
  .superRefine((t, ctx) => {
    if (t.action === 'command' && !t.payload.trim()) ctx.addIssue({ code: 'custom', path: ['payload'], message: 'Enter the command to send' });
    if (t.action === 'power' && !(POWER_ACTIONS as string[]).includes(t.payload)) {
      ctx.addIssue({ code: 'custom', path: ['payload'], message: 'Pick start, stop, restart or kill' });
    }
  });

type CronFields = Pick<Schedule, 'cronMinute' | 'cronHour' | 'cronDayOfMonth' | 'cronMonth' | 'cronDayOfWeek'>;

export function cronExpression(s: CronFields) {
  return `${s.cronMinute} ${s.cronHour} ${s.cronDayOfMonth} ${s.cronMonth} ${s.cronDayOfWeek}`;
}

/** Next run after `from` in the panel's timezone. Throws a 422 for invalid expressions. */
export async function nextRun(fields: CronFields, from = new Date()): Promise<Date> {
  const { timezone } = await getSection('general');
  try {
    return CronExpressionParser.parse(cronExpression(fields), { currentDate: from, tz: timezone }).next().toDate();
  } catch (err) {
    throw unprocessable(`That schedule is not a valid cron expression: ${(err as Error).message}`, [{ path: 'cronMinute', message: 'Invalid cron expression' }]);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs due schedules. Lives inside the panel process: a schedule is claimed with an atomic
 * `isProcessing` flag, so a second panel instance would never run the same schedule twice.
 */
export class ScheduleRunner {
  private timer: NodeJS.Timeout | null = null;
  private log: FastifyBaseLogger;

  constructor(private readonly app: FastifyInstance) {
    this.log = app.log.child({ module: 'schedules' });
  }

  async start() {
    // Runs interrupted by a restart will never finish; release them.
    await prisma.schedule.updateMany({ where: { isProcessing: true }, data: { isProcessing: false } });
    this.timer = setInterval(() => void this.tick(), TICK_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick() {
    try {
      const due = await prisma.schedule.findMany({
        where: { isActive: true, isProcessing: false, nextRunAt: { lte: new Date() } },
        select: { id: true },
        take: 50,
      });
      for (const { id } of due) void this.run(id, false);
    } catch (err) {
      this.log.error({ err }, 'schedule tick failed');
    }
  }

  /** Run a schedule now. `manual` runs ignore isActive and do not move nextRunAt forward early. */
  async run(scheduleId: number, manual: boolean): Promise<boolean> {
    const claimed = await prisma.schedule.updateMany({ where: { id: scheduleId, isProcessing: false }, data: { isProcessing: true } });
    if (!claimed.count) return false;

    const schedule = await prisma.schedule.findUniqueOrThrow({
      where: { id: scheduleId },
      include: { tasks: { orderBy: { sequence: 'asc' } }, server: { include: { node: true } } },
    });
    const { server } = schedule;
    let outcome = 'completed';
    try {
      if (server.status !== 'ACTIVE') {
        outcome = 'skipped (server not active)';
      } else if (schedule.onlyWhenOnline && !(await this.isRunning(server))) {
        outcome = 'skipped (server offline)';
      } else {
        for (const task of schedule.tasks) {
          if (task.timeOffset) await sleep(task.timeOffset * 1000);
          try {
            await this.execute(task, server);
          } catch (err) {
            this.log.warn({ err, schedule: schedule.id, task: task.id }, 'schedule task failed');
            if (!task.continueOnFailure) {
              outcome = `failed at task ${task.sequence}: ${(err as Error).message}`;
              break;
            }
          }
        }
      }
    } finally {
      let next: Date | null = null;
      try {
        next = await nextRun(schedule);
      } catch {
        // Invalid expression saved somehow; leave it unscheduled.
      }
      await prisma.schedule.update({
        where: { id: schedule.id },
        data: { isProcessing: false, lastRunAt: new Date(), ...(manual ? {} : { nextRunAt: next }) },
      });
      await recordActivity({ event: 'server:schedule.run', serverId: server.id, properties: { schedule: schedule.name, manual, outcome } });
    }
    return true;
  }

  private async isRunning(server: { node: Parameters<typeof daemonRequest>[0]; uuid: string }) {
    try {
      const usage = await daemonRequest<ServerResourceUsage>(server.node, this.app.encrypter, 'GET', `/api/servers/${server.uuid}`, undefined, 5_000);
      return usage.state === 'running';
    } catch {
      return false;
    }
  }

  private async execute(task: ScheduleTask, server: Parameters<typeof createBackup>[1]) {
    switch (task.action) {
      case 'command':
        await daemonRequest(server.node, this.app.encrypter, 'POST', `/api/servers/${server.uuid}/commands`, { commands: [task.payload] });
        return;
      case 'power':
        await daemonRequest(server.node, this.app.encrypter, 'POST', `/api/servers/${server.uuid}/power`, { action: task.payload });
        return;
      case 'backup':
        await createBackup(this.app, server, { name: `Scheduled backup ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`, ignored: task.payload, rotate: true });
        return;
    }
  }
}
