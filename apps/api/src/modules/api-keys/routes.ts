import { randomBytes } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { API_KEY_SCOPES, type ApiKeyScope } from '@glacier/shared';
import { prisma } from '../../db';
import { randomToken, sha256 } from '../../lib/crypto';
import { forbidden, notFound } from '../../lib/errors';
import { logActivity } from '../../lib/activity';
import { idParam } from '../../lib/http';
import { requireUser } from '../../plugins/auth';

const MAX_KEYS = 25;
const scopes = Object.keys(API_KEY_SCOPES) as [ApiKeyScope, ...ApiKeyScope[]];

/** /api/client/account/api-keys — only reachable with a browser session, never with a key. */
export const apiKeyRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireUser);

  app.get('/', async (req) => ({
    data: await prisma.apiKey.findMany({
      where: { userId: req.user!.id },
      orderBy: { createdAt: 'desc' },
      select: { id: true, identifier: true, name: true, scopes: true, allowedIps: true, lastUsedAt: true, expiresAt: true, createdAt: true },
    }),
  }));

  /** The full token is returned once, here. Only a hash of its secret part is stored. */
  app.post('/', async (req) => {
    const body = z
      .object({
        name: z.string().trim().min(1).max(60),
        scopes: z.array(z.enum(scopes)).min(1).transform((s) => [...new Set(s)]),
        allowedIps: z.array(z.string().trim().regex(/^[0-9a-fA-F:.]+(\/\d{1,3})?$/, 'Use IPs or CIDR ranges')).max(20).default([]),
        expiresInDays: z.number().int().min(1).max(3650).nullable().default(null),
      })
      .parse(req.body);
    if (body.scopes.some((s) => s.startsWith('admin:')) && !req.user!.rootAdmin) throw forbidden('Only administrators can create admin keys.');
    if ((await prisma.apiKey.count({ where: { userId: req.user!.id } })) >= MAX_KEYS) throw forbidden(`You can have at most ${MAX_KEYS} API keys.`);

    // Identifier: public, used to look the key up. Secret: never stored in plain text.
    const identifier = randomBytes(6).toString('hex');
    const secret = randomToken(32);
    const key = await prisma.apiKey.create({
      data: {
        userId: req.user!.id,
        identifier,
        secretHash: sha256(secret),
        name: body.name,
        scopes: body.scopes,
        allowedIps: body.allowedIps,
        expiresAt: body.expiresInDays ? new Date(Date.now() + body.expiresInDays * 86_400_000) : null,
      },
    });
    await logActivity(req, 'user:api-key.create', { properties: { name: key.name, scopes: body.scopes } });
    return { id: key.id, name: key.name, token: `glacier_${identifier}_${secret}` };
  });

  app.delete('/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const { count } = await prisma.apiKey.deleteMany({ where: { id, userId: req.user!.id } });
    if (!count) throw notFound('API key');
    await logActivity(req, 'user:api-key.delete', { properties: { id } });
    return { ok: true };
  });
};
