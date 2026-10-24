import { isIP } from 'node:net';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { MinecraftStatus, PlayerEntry, ResourceSample, ServerPermission, ServerResourceUsage } from '@glacier/shared';
import { validateVariable } from '@glacier/eggs';
import { prisma } from '../../db';
import { HttpError, conflict, forbidden, notFound, unprocessable } from '../../lib/errors';
import { logActivity } from '../../lib/activity';
import { requireUser } from '../../plugins/auth';
import { daemonRequest } from '../nodes/daemon-client';
import { assertServerUsable, resolveServerAccess, syncServer } from '../servers/service';
import { getSection } from '../settings/service';
import { cloudflare, getIntegrations } from '../integrations/service';
import { minecraftContext, versionVariable } from './context';

const UA = 'glacier-panel/0.1 (self-hosted game server panel)';
const serverParam = z.object({ server: z.string() });

async function access(req: FastifyRequest, permission: ServerPermission | ServerPermission[]) {
  const { server: id } = serverParam.parse(req.params);
  const perms = Array.isArray(permission) ? permission : [permission];
  const result = await resolveServerAccess(req.user!, id, perms[0]);
  for (const p of perms.slice(1)) await resolveServerAccess(req.user!, id, p);
  const full = await prisma.server.findUniqueOrThrow({ where: { id: result.server.id }, include: { egg: { include: { variables: true } }, variables: true, allocation: true } });
  return { ...result, full, context: minecraftContext(full) };
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(10_000) }).catch(() => null);
  if (!res?.ok) throw new HttpError(502, 'upstream', `Couldn't load versions from ${new URL(url).host}.`);
  return (await res.json()) as T;
}

const stable = (v: string) => /^\d+(\.\d+)+$/.test(v);

/** Release versions, newest first, for each kind of server. */
async function listVersions(source: 'paper' | 'purpur' | 'vanilla' | 'fabric'): Promise<string[]> {
  switch (source) {
    case 'paper': {
      const d = await fetchJson<{ versions: Record<string, string[]> }>('https://fill.papermc.io/v3/projects/paper');
      return Object.values(d.versions).flat().filter(stable);
    }
    case 'purpur':
      return (await fetchJson<{ versions: string[] }>('https://api.purpurmc.org/v2/purpur')).versions.filter(stable).reverse();
    case 'vanilla':
      return (await fetchJson<{ versions: { id: string; type: string }[] }>('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json')).versions
        .filter((v) => v.type === 'release')
        .map((v) => v.id);
    case 'fabric':
      return (await fetchJson<{ version: string; stable: boolean }[]>('https://meta.fabricmc.net/v2/versions/game')).filter((v) => v.stable).map((v) => v.version);
  }
}

// --- Version switcher ------------------------------------------------------------------------------

export const versionRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireUser);

  app.get('/', async (req) => {
    const { full, context } = await access(req, 'startup.read');
    const current = versionVariable(full)?.value ?? null;
    if (!context.versionSource) return { supported: false, current, versions: [] };
    return { supported: true, source: context.versionSource, current, versions: await listVersions(context.versionSource) };
  });

  /** Switch Minecraft version: set the egg's version variable and reinstall (worlds are kept by the install scripts). */
  app.post('/', async (req) => {
    const { server, full, context } = await access(req, ['startup.update', 'settings.reinstall']);
    assertServerUsable(server);
    const { version } = z.object({ version: z.string().regex(/^(\d+(\.\d+)+|latest)$/) }).parse(req.body);
    const found = versionVariable(full);
    if (!found || !context.versionSource) throw conflict("This server's type doesn't support switching versions.");
    if (version !== 'latest' && !(await listVersions(context.versionSource)).includes(version)) throw unprocessable('That version is not available.');
    const err = validateVariable(version, found.variable.rules, found.variable.name);
    if (err) throw unprocessable(err);

    const build = full.egg.variables.find((v) => v.envVariable === 'BUILD_NUMBER');
    await prisma.$transaction([
      prisma.serverVariable.upsert({
        where: { serverId_variableId: { serverId: server.id, variableId: found.variable.id } },
        create: { serverId: server.id, variableId: found.variable.id, value: version },
        update: { value: version },
      }),
      // A build number from the old version wouldn't exist for the new one.
      ...(build
        ? [prisma.serverVariable.upsert({ where: { serverId_variableId: { serverId: server.id, variableId: build.id } }, create: { serverId: server.id, variableId: build.id, value: 'latest' }, update: { value: 'latest' } })]
        : []),
      prisma.server.update({ where: { id: server.id }, data: { status: 'INSTALLING' } }),
    ]);
    try {
      await syncServer(app, server);
      await daemonRequest(server.node, app.encrypter, 'POST', `/api/servers/${server.uuid}/reinstall`);
    } catch (e) {
      await prisma.server.update({ where: { id: server.id }, data: { status: server.status } });
      throw e;
    }
    await logActivity(req, 'server:version.switch', { serverId: server.id, properties: { from: found.value, to: version } });
    return { ok: true };
  });
};

// --- Players ---------------------------------------------------------------------------------------

const playerName = z.string().regex(/^[A-Za-z0-9_]{3,16}$/, 'Minecraft names are 3–16 letters, numbers or underscores');

async function mojangProfile(name: string): Promise<{ uuid: string; name: string }> {
  const res = await fetch(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(name)}`, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(8_000) }).catch(() => null);
  if (!res || res.status === 404 || res.status === 204) throw unprocessable(`No Minecraft account is called "${name}".`, [{ path: 'name', message: 'Unknown player' }]);
  if (!res.ok) throw new HttpError(502, 'mojang', "Couldn't reach Mojang to look up that player.");
  const p = (await res.json()) as { id: string; name: string };
  const id = p.id.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
  return { uuid: id, name: p.name };
}

export const playerRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireUser);

  const readList = async (server: { node: Parameters<typeof daemonRequest>[0]; uuid: string }, file: string) => {
    try {
      const text = await daemonRequest<string>(server.node, app.encrypter, 'GET', `/api/servers/${server.uuid}/files/contents?file=${encodeURIComponent(`/${file}`)}`, undefined, 10_000, 'text');
      return JSON.parse(text) as Record<string, unknown>[];
    } catch {
      return [];
    }
  };

  app.get('/', async (req) => {
    const { server } = await access(req, 'players.read');
    const [status, whitelist, ops, banned] = await Promise.all([
      daemonRequest<MinecraftStatus>(server.node, app.encrypter, 'GET', `/api/servers/${server.uuid}/minecraft/status`, undefined, 6_000).catch(() => ({ online: false }) as MinecraftStatus),
      readList(server, 'whitelist.json'),
      readList(server, 'ops.json'),
      readList(server, 'banned-players.json'),
    ]);
    const entry = (e: Record<string, unknown>, detail?: string): PlayerEntry => ({ name: String(e.name ?? ''), uuid: String(e.uuid ?? ''), detail });
    return {
      status,
      whitelist: whitelist.map((e) => entry(e)),
      ops: ops.map((e) => entry(e, `level ${e.level ?? 4}`)),
      banned: banned.map((e) => entry(e, e.reason ? String(e.reason) : undefined)),
    };
  });

  /**
   * Running server: use console commands (the server updates its own files).
   * Stopped server: edit the JSON files directly, looking up the player's UUID at Mojang.
   */
  app.post('/', async (req) => {
    const { server } = await access(req, 'players.manage');
    assertServerUsable(server);
    const body = z
      .object({
        action: z.enum(['whitelist-add', 'whitelist-remove', 'op', 'deop', 'ban', 'pardon', 'kick']),
        name: playerName,
        reason: z.string().max(200).regex(/^[^\n\r]*$/).optional(),
      })
      .parse(req.body);
    const usage = await daemonRequest<ServerResourceUsage>(server.node, app.encrypter, 'GET', `/api/servers/${server.uuid}`, undefined, 5_000).catch(() => null);
    const running = usage?.state === 'running';
    const reason = body.reason?.trim();

    if (running) {
      const command = {
        'whitelist-add': `whitelist add ${body.name}`,
        'whitelist-remove': `whitelist remove ${body.name}`,
        op: `op ${body.name}`,
        deop: `deop ${body.name}`,
        ban: `ban ${body.name}${reason ? ` ${reason}` : ''}`,
        pardon: `pardon ${body.name}`,
        kick: `kick ${body.name}${reason ? ` ${reason}` : ''}`,
      }[body.action];
      await daemonRequest(server.node, app.encrypter, 'POST', `/api/servers/${server.uuid}/commands`, { commands: [command] });
    } else {
      if (body.action === 'kick') throw conflict('The server is offline, so nobody can be kicked.');
      const file = { 'whitelist-add': 'whitelist.json', 'whitelist-remove': 'whitelist.json', op: 'ops.json', deop: 'ops.json', ban: 'banned-players.json', pardon: 'banned-players.json' }[body.action];
      const list = await readList(server, file);
      const lower = body.name.toLowerCase();
      const without = list.filter((e) => String(e.name ?? '').toLowerCase() !== lower);
      let next = without;
      if (['whitelist-add', 'op', 'ban'].includes(body.action)) {
        const profile = await mojangProfile(body.name);
        const extra =
          body.action === 'op'
            ? { level: 4, bypassesPlayerLimit: false }
            : body.action === 'ban'
              ? { created: new Date().toISOString().replace('T', ' ').slice(0, 19) + ' +0000', source: req.user!.username, expires: 'forever', reason: reason || 'Banned by an operator.' }
              : {};
        next = [...without, { uuid: profile.uuid, name: profile.name, ...extra }];
      }
      await daemonRequest(server.node, app.encrypter, 'POST', `/api/servers/${server.uuid}/files/write`, { file: `/${file}`, content: `${JSON.stringify(next, null, 2)}\n` });
    }
    await logActivity(req, `server:player.${body.action}`, { serverId: server.id, properties: { player: body.name, ...(reason ? { reason } : {}), live: running } });
    return { ok: true, applied: running ? 'console' : 'file' };
  });
};

// --- Resource history ------------------------------------------------------------------------------

export const statsRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireUser);
  app.get('/history', async (req) => {
    const { server: id } = serverParam.parse(req.params);
    const { server } = await resolveServerAccess(req.user!, id, 'control.console');
    return daemonRequest<{ data: ResourceSample[] }>(server.node, app.encrypter, 'GET', `/api/servers/${server.uuid}/stats/history`, undefined, 5_000);
  });
};

// --- Subdomains ------------------------------------------------------------------------------------

const label = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/, 'Lowercase letters, numbers and dashes (max 32)');
const RESERVED_LABELS = new Set(['www', 'mail', 'panel', 'api', 'admin', 'ftp', 'smtp', 'ns1', 'ns2', 'node']);

/** Records for a subdomain: CNAME (or A) to the node, plus SRV so Minecraft players can skip the port. */
export function subdomainRecords(hostname: string, nodeHost: string, port: number, minecraft: boolean) {
  const main = isIP(nodeHost)
    ? { type: isIP(nodeHost) === 6 ? 'AAAA' : 'A', name: hostname, content: nodeHost, ttl: 1, proxied: false }
    : { type: 'CNAME', name: hostname, content: nodeHost, ttl: 1, proxied: false };
  const srv = minecraft ? { type: 'SRV', name: `_minecraft._tcp.${hostname}`, ttl: 1, data: { priority: 0, weight: 5, port, target: hostname } } : null;
  return { main, srv };
}

export const subdomainRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireUser);
  app.addHook('preHandler', async () => {
    if (!(await getSection('features')).subdomains) throw notFound('Route');
  });

  app.get('/', async (req) => {
    const { server: id } = serverParam.parse(req.params);
    const { server } = await resolveServerAccess(req.user!, id);
    const integrations = await getIntegrations();
    return {
      data: await prisma.subdomain.findMany({ where: { serverId: server.id }, select: { id: true, hostname: true, srvRecordId: true, createdAt: true } }),
      zones: integrations.cloudflareZones.map((z) => ({ id: z.id, name: z.name })),
      limit: integrations.subdomainsPerServer,
    };
  });

  app.post('/', async (req) => {
    const { server, full, context } = await access(req, 'subdomain.manage');
    const body = z.object({ name: label, zoneId: z.string() }).parse(req.body);
    const integrations = await getIntegrations();
    const zone = integrations.cloudflareZones.find((z) => z.id === body.zoneId);
    if (!zone) throw unprocessable('Pick one of the available domains.');
    if (RESERVED_LABELS.has(body.name)) throw unprocessable('That name is reserved.', [{ path: 'name', message: 'Reserved' }]);
    if ((await prisma.subdomain.count({ where: { serverId: server.id } })) >= integrations.subdomainsPerServer) {
      throw forbidden(`This server can have at most ${integrations.subdomainsPerServer} subdomain(s).`);
    }
    const hostname = `${body.name}.${zone.name}`;
    if (await prisma.subdomain.findUnique({ where: { hostname } })) throw conflict('That subdomain is taken.');

    const minecraft = context.loader !== null || /minecraft/i.test(full.egg.name);
    const { main, srv } = subdomainRecords(hostname, server.node.fqdn, full.allocation.port, minecraft);
    const created = await cloudflare<{ id: string }>(app.encrypter, 'POST', `/zones/${zone.id}/dns_records`, main);
    let srvId: string | null = null;
    if (srv) {
      try {
        srvId = (await cloudflare<{ id: string }>(app.encrypter, 'POST', `/zones/${zone.id}/dns_records`, srv)).id;
      } catch (e) {
        await cloudflare(app.encrypter, 'DELETE', `/zones/${zone.id}/dns_records/${created.id}`).catch(() => undefined);
        throw e;
      }
    }
    const sub = await prisma.subdomain.create({ data: { serverId: server.id, hostname, zoneId: zone.id, recordId: created.id, srvRecordId: srvId } });
    await logActivity(req, 'server:subdomain.create', { serverId: server.id, properties: { hostname } });
    return sub;
  });

  app.delete('/:id', async (req) => {
    const { server } = await access(req, 'subdomain.manage');
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const sub = await prisma.subdomain.findFirst({ where: { id, serverId: server.id } });
    if (!sub) throw notFound('Subdomain');
    await deleteSubdomainRecords(app.encrypter, sub);
    await prisma.subdomain.delete({ where: { id } });
    await logActivity(req, 'server:subdomain.delete', { serverId: server.id, properties: { hostname: sub.hostname } });
    return { ok: true };
  });
};

export async function deleteSubdomainRecords(encrypter: Parameters<typeof cloudflare>[0], sub: { zoneId: string; recordId: string; srvRecordId: string | null }) {
  for (const id of [sub.srvRecordId, sub.recordId]) {
    if (!id) continue;
    await cloudflare(encrypter, 'DELETE', `/zones/${sub.zoneId}/dns_records/${id}`).catch((e: HttpError) => {
      // Already gone at Cloudflare is fine.
      if (!/not found|does not exist/i.test(e.message)) throw e;
    });
  }
}
