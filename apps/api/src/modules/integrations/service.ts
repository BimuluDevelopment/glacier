import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../db';
import type { Encrypter } from '../../lib/crypto';
import { HttpError, unprocessable } from '../../lib/errors';
import { logActivity } from '../../lib/activity';
import { requireAdmin } from '../../plugins/auth';

/**
 * Third-party credentials (CurseForge API key, Cloudflare API token). Stored encrypted, apart from
 * the regular settings, and never sent back to the browser.
 */
const KEY = 'integrations';

const schema = z.object({
  curseforgeKeyEncrypted: z.string().default(''),
  cloudflareTokenEncrypted: z.string().default(''),
  /** Cloudflare zones users may create subdomains under. */
  cloudflareZones: z.array(z.object({ id: z.string(), name: z.string() })).default([]),
  subdomainsPerServer: z.number().int().min(0).max(10).default(1),
});
type Integrations = z.infer<typeof schema>;

let cached: Integrations | null = null;

export async function getIntegrations(): Promise<Integrations> {
  if (cached) return cached;
  const row = await prisma.setting.findUnique({ where: { key: KEY } });
  const parsed = schema.safeParse(row?.value ?? {});
  cached = parsed.success ? parsed.data : schema.parse({});
  return cached;
}

async function save(next: Integrations) {
  await prisma.setting.upsert({ where: { key: KEY }, create: { key: KEY, value: next }, update: { value: next } });
  cached = null;
}

export async function curseforgeKey(encrypter: Encrypter) {
  const { curseforgeKeyEncrypted } = await getIntegrations();
  return curseforgeKeyEncrypted ? encrypter.decrypt(curseforgeKeyEncrypted) : null;
}

/** Call the Cloudflare API with the stored token. */
export async function cloudflare<T>(encrypter: Encrypter, method: string, path: string, body?: unknown, token?: string): Promise<T> {
  const t = token ?? ((await getIntegrations()).cloudflareTokenEncrypted ? encrypter.decrypt((await getIntegrations()).cloudflareTokenEncrypted) : '');
  if (!t) throw new HttpError(404, 'not_configured', 'Cloudflare is not set up on this panel.');
  let res: Response;
  try {
    res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
      method,
      headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new HttpError(502, 'cloudflare_unreachable', "Couldn't reach Cloudflare. Try again in a moment.");
  }
  const data = (await res.json().catch(() => ({}))) as { success?: boolean; result?: T; errors?: { message: string }[] };
  if (!res.ok || !data.success) throw new HttpError(502, 'cloudflare_error', `Cloudflare: ${data.errors?.[0]?.message ?? `HTTP ${res.status}`}`);
  return data.result as T;
}

/** /api/admin/integrations */
export const integrationRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireAdmin);

  app.get('/', async () => {
    const i = await getIntegrations();
    return { curseforgeSet: Boolean(i.curseforgeKeyEncrypted), cloudflareSet: Boolean(i.cloudflareTokenEncrypted), cloudflareZones: i.cloudflareZones, subdomainsPerServer: i.subdomainsPerServer };
  });

  /** Secrets: omit to keep, "" to remove. A new Cloudflare token is checked before saving. */
  app.put('/', async (req) => {
    const body = z
      .object({
        curseforgeKey: z.string().trim().max(200).optional(),
        cloudflareToken: z.string().trim().max(200).optional(),
        cloudflareZones: z.array(z.object({ id: z.string().regex(/^[a-f0-9]{32}$/), name: z.string().max(253) })).max(20).optional(),
        subdomainsPerServer: z.number().int().min(0).max(10).optional(),
      })
      .parse(req.body);
    const current = await getIntegrations();
    if (body.cloudflareToken) {
      await cloudflare(app.encrypter, 'GET', '/user/tokens/verify', undefined, body.cloudflareToken).catch((err: Error) => {
        throw unprocessable(`That Cloudflare token doesn't work: ${err.message}`, [{ path: 'cloudflareToken', message: 'Invalid token' }]);
      });
    }
    const secret = (value: string | undefined, prev: string) => (value === undefined ? prev : value ? app.encrypter.encrypt(value) : '');
    await save({
      curseforgeKeyEncrypted: secret(body.curseforgeKey, current.curseforgeKeyEncrypted),
      cloudflareTokenEncrypted: secret(body.cloudflareToken, current.cloudflareTokenEncrypted),
      cloudflareZones: body.cloudflareToken === '' ? [] : (body.cloudflareZones ?? current.cloudflareZones),
      subdomainsPerServer: body.subdomainsPerServer ?? current.subdomainsPerServer,
    });
    await logActivity(req, 'admin:integrations.update', { properties: { fields: Object.keys(body) } });
    return { ok: true };
  });

  /** Zones the token can edit, so the admin can pick which ones users may use. */
  app.get('/cloudflare/zones', async () => {
    const zones = await cloudflare<{ id: string; name: string; status: string }[]>(app.encrypter, 'GET', '/zones?per_page=50');
    return { data: zones.map((z) => ({ id: z.id, name: z.name, status: z.status })) };
  });
};
