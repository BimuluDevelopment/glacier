import type { FastifyPluginAsync } from 'fastify';
import type { Webhook } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../db';
import { randomToken } from '../../lib/crypto';
import { unprocessable } from '../../lib/errors';
import { logActivity } from '../../lib/activity';
import { idParam } from '../../lib/http';
import { requireAdmin } from '../../plugins/auth';
import { deliver, invalidateWebhooks } from './service';

const webhookSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    url: z.url().refine((u) => /^https?:\/\//i.test(u), 'Use an http(s) URL'),
    format: z.enum(['json', 'discord']).default('json'),
    events: z.array(z.string().trim().regex(/^[a-z0-9:.*_-]+$/i, 'Invalid event pattern').max(100)).min(1).max(50),
    enabled: z.boolean().default(true),
  })
  .superRefine((w, ctx) => {
    if (w.format === 'discord' && !/^https:\/\/(?:\w+\.)?discord(?:app)?\.com\/api\/webhooks\//i.test(w.url)) {
      ctx.addIssue({ code: 'custom', path: ['url'], message: 'Paste a Discord webhook URL (Server Settings → Integrations → Webhooks)' });
    }
  });

function serialize(w: Webhook) {
  const { secretEncrypted: _secretEncrypted, ...rest } = w;
  return rest;
}

export const webhookRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireAdmin);

  app.get('/', async () => ({ data: (await prisma.webhook.findMany({ orderBy: { createdAt: 'asc' } })).map(serialize) }));

  /** The signing secret is returned once here and on rotation, never again. */
  app.post('/', async (req) => {
    const body = webhookSchema.parse(req.body);
    const secret = randomToken(24);
    const hook = await prisma.webhook.create({ data: { ...body, secretEncrypted: app.encrypter.encrypt(secret) } });
    invalidateWebhooks();
    await logActivity(req, 'admin:webhook.create', { properties: { name: hook.name } });
    return { ...serialize(hook), secret };
  });

  app.patch('/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const current = await prisma.webhook.findUniqueOrThrow({ where: { id } });
    const body = webhookSchema.parse({ ...serialize(current), ...(req.body as object) });
    const hook = await prisma.webhook.update({ where: { id }, data: body });
    invalidateWebhooks();
    await logActivity(req, 'admin:webhook.update', { properties: { name: hook.name } });
    return serialize(hook);
  });

  app.post('/:id/rotate-secret', async (req) => {
    const { id } = idParam.parse(req.params);
    const secret = randomToken(24);
    await prisma.webhook.update({ where: { id }, data: { secretEncrypted: app.encrypter.encrypt(secret) } });
    invalidateWebhooks();
    await logActivity(req, 'admin:webhook.rotate-secret', { properties: { id } });
    return { secret };
  });

  app.post('/:id/test', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const { id } = idParam.parse(req.params);
    const hook = await prisma.webhook.findUniqueOrThrow({ where: { id } });
    try {
      const status = await deliver(hook, {
        id: 'test',
        event: 'glacier:test',
        timestamp: new Date().toISOString(),
        actor: { id: req.user!.id, username: req.user!.username },
        server: null,
        ip: req.ip,
        properties: { message: 'This is a test delivery from Glacier Panel.' },
      });
      await prisma.webhook.update({ where: { id }, data: { lastStatus: status, lastError: null, lastTriggeredAt: new Date() } });
      return { ok: true, status };
    } catch (err) {
      await prisma.webhook.update({ where: { id }, data: { lastStatus: (err as { status?: number }).status ?? null, lastError: (err as Error).message, lastTriggeredAt: new Date() } });
      throw unprocessable(`Delivery failed: ${(err as Error).message}`);
    }
  });

  app.delete('/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const hook = await prisma.webhook.delete({ where: { id } });
    invalidateWebhooks();
    await logActivity(req, 'admin:webhook.delete', { properties: { name: hook.name } });
    return { ok: true };
  });
};
