import type { FastifyRequest } from 'fastify';
import type { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { dispatchWebhooks } from '../modules/webhooks/service';

export interface ActivityInput {
  event: string;
  actorId?: string | null;
  serverId?: number;
  ip?: string | null;
  properties?: Prisma.InputJsonObject;
}

/**
 * Write an audit event and fan it out to matching webhooks. Every activity entry goes through
 * here, including ones without a request (daemon callbacks, schedules), so webhooks see them all.
 * Failures are swallowed: auditing must never break the action being audited.
 */
export async function recordActivity(input: ActivityInput, log?: FastifyRequest['log']): Promise<void> {
  try {
    const row = await prisma.activityLog.create({
      data: { event: input.event, actorId: input.actorId ?? null, serverId: input.serverId, ip: input.ip ?? null, properties: input.properties ?? {} },
    });
    dispatchWebhooks(row);
  } catch (err) {
    log?.warn({ err, event: input.event }, 'failed to write activity log');
  }
}

/**
 * Record an event for the current request. Event names are `<scope>:<thing>.<verb>`, e.g.
 * `server:power.start`, `admin:node.create`, `auth:login`.
 */
export async function logActivity(
  req: FastifyRequest,
  event: string,
  opts: { serverId?: number; actorId?: string | null; properties?: Prisma.InputJsonObject } = {},
): Promise<void> {
  await recordActivity(
    {
      event,
      actorId: opts.actorId === undefined ? (req.user?.id ?? null) : opts.actorId,
      serverId: opts.serverId,
      ip: req.ip,
      properties: { ...(opts.properties ?? {}), ...(req.apiKey ? { viaApiKey: req.apiKey.name } : {}) },
    },
    req.log,
  );
}
