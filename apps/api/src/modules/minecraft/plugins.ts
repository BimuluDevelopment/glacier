import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { LOADERS, PLUGIN_SOURCES, loaderDirectory, type FileEntry, type InstalledPluginInfo, type Loader, type PluginSource, type ServerPermission } from '@glacier/shared';
import { prisma } from '../../db';
import { HttpError, conflict, notFound } from '../../lib/errors';
import { logActivity } from '../../lib/activity';
import { requireUser } from '../../plugins/auth';
import { daemonRequest } from '../nodes/daemon-client';
import { assertServerUsable, resolveServerAccess } from '../servers/service';
import { getSection } from '../settings/service';
import { curseforgeKey } from '../integrations/service';
import { minecraftContext } from './context';
import { catalog } from './sources';

const filters = z.object({
  loader: z.enum(LOADERS).optional(),
  gameVersion: z
    .string()
    .regex(/^\d+(\.\d+)+$/)
    .optional(),
});

/** /api/client/servers/:server/plugins */
export const pluginRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireUser);
  app.addHook('preHandler', async () => {
    if (!(await getSection('features')).plugins) throw notFound('Route');
  });

  async function load(req: FastifyRequest, permission: ServerPermission) {
    const { server: id } = z.object({ server: z.string() }).parse(req.params);
    const { server } = await resolveServerAccess(req.user!, id, permission);
    const full = await prisma.server.findUniqueOrThrow({ where: { id: server.id }, include: { egg: { include: { variables: true } }, variables: true } });
    return { server, context: minecraftContext(full) };
  }

  /** Filters for a request: explicit query values win over what the egg suggests. */
  function resolveFilters(req: FastifyRequest, context: ReturnType<typeof minecraftContext>) {
    const q = filters.parse(req.query);
    return { loader: (q.loader ?? context.loader) as Loader | null, gameVersion: q.gameVersion ?? context.gameVersion };
  }

  const listDir = (server: Awaited<ReturnType<typeof load>>['server'], dir: string) =>
    daemonRequest<{ data: FileEntry[] }>(server.node, app.encrypter, 'GET', `/api/servers/${server.uuid}/files/list?directory=${encodeURIComponent(dir)}`)
      .then((r) => r.data)
      .catch(() => [] as FileEntry[]);

  app.get('/', async (req) => {
    const { server, context } = await load(req, 'plugins.read');
    const { updates } = z.object({ updates: z.enum(['true', 'false']).default('false') }).parse(req.query);
    const records = await prisma.installedPlugin.findMany({ where: { serverId: server.id }, orderBy: { name: 'asc' } });

    // Files the user deleted by hand no longer count as installed.
    const files = new Set<string>();
    for (const dir of new Set(records.map((r) => r.path.split('/')[0]!))) {
      for (const f of await listDir(server, `/${dir}`)) files.add(`${dir}/${f.name}`);
    }
    const present = records.filter((r) => files.has(r.path) || files.has(`${r.path}.disabled`));
    const gone = records.filter((r) => !present.includes(r));
    if (gone.length) await prisma.installedPlugin.deleteMany({ where: { id: { in: gone.map((r) => r.id) } } });

    const key = await curseforgeKey(app.encrypter);
    const installed: InstalledPluginInfo[] = await Promise.all(
      present.map(async (r) => {
        let update: InstalledPluginInfo['update'] = null;
        if (updates === 'true' && (r.source !== 'curseforge' || key)) {
          try {
            const latest = (await catalog(r.source as PluginSource, key).versions(r.projectId, context.loader, context.gameVersion)).find((v) => v.file);
            if (latest && latest.id !== r.versionId) update = { id: latest.id, name: latest.name };
          } catch {
            // Catalogue unreachable; just don't show an update.
          }
        }
        return {
          id: r.id,
          source: r.source as PluginSource,
          projectId: r.projectId,
          versionId: r.versionId,
          name: r.name,
          versionName: r.versionName,
          path: files.has(r.path) ? r.path : `${r.path}.disabled`,
          iconUrl: r.iconUrl,
          installedAt: r.installedAt.toISOString(),
          enabled: files.has(r.path),
          update,
        };
      }),
    );
    return { context, sources: PLUGIN_SOURCES.filter((s) => s !== 'curseforge' || key), installed };
  });

  app.get('/search', async (req) => {
    const { context } = await load(req, 'plugins.read');
    const q = z
      .object({ source: z.enum(PLUGIN_SOURCES).default('modrinth'), q: z.string().max(100).default(''), page: z.coerce.number().int().min(1).max(50).default(1) })
      .parse(req.query);
    const f = resolveFilters(req, context);
    return catalog(q.source, await curseforgeKey(app.encrypter)).search({ query: q.q, loader: f.loader, gameVersion: f.gameVersion, page: q.page });
  });

  app.get('/:source/:project/versions', async (req) => {
    const { context } = await load(req, 'plugins.read');
    const p = z.object({ source: z.enum(PLUGIN_SOURCES), project: z.string().min(1).max(100) }).parse(req.params);
    const f = resolveFilters(req, context);
    return { data: await catalog(p.source, await curseforgeKey(app.encrypter)).versions(p.project, f.loader, f.gameVersion) };
  });

  /**
   * Install (or update) a plugin/mod. The download URL and checksum come from the catalogue
   * here on the server, never from the browser, and the node verifies the hash.
   */
  app.post('/install', async (req) => {
    const { server, context } = await load(req, 'plugins.manage');
    assertServerUsable(server);
    const body = z
      .object({ source: z.enum(PLUGIN_SOURCES), projectId: z.string().min(1).max(100), versionId: z.string().min(1).max(100) })
      .and(filters)
      .parse(req.body);
    const loader = (body.loader ?? context.loader) as Loader | null;
    if (!loader) throw conflict('Pick the server software (Paper, Fabric, …) to install for.');
    const cat = catalog(body.source, await curseforgeKey(app.encrypter));
    const version = (await cat.versions(body.projectId, loader, body.gameVersion ?? context.gameVersion)).find((v) => v.id === body.versionId);
    if (!version) throw new HttpError(404, 'not_found', 'That version is not available for this server.');
    if (!version.file) throw new HttpError(409, 'external_download', "The author doesn't allow automatic downloads for this file. Download it from the project page and upload it.");

    const dir = loaderDirectory(loader);
    await daemonRequest(
      server.node,
      app.encrypter,
      'POST',
      `/api/servers/${server.uuid}/files/pull`,
      { url: version.file.url, directory: `/${dir}`, filename: version.file.filename, sha1: version.file.sha1, sha256: version.file.sha256, sha512: version.file.sha512 },
      120_000,
    );

    const path = `${dir}/${version.file.filename}`;
    const existing = await prisma.installedPlugin.findUnique({ where: { serverId_source_projectId: { serverId: server.id, source: body.source, projectId: body.projectId } } });
    // Updating: remove the old jar once the new one is safely in place.
    if (existing && existing.path !== path) {
      const [oldDir, oldName] = [existing.path.split('/')[0]!, existing.path.split('/').slice(1).join('/')];
      await daemonRequest(server.node, app.encrypter, 'POST', `/api/servers/${server.uuid}/files/delete`, { root: `/${oldDir}`, files: [oldName, `${oldName}.disabled`] }).catch(() => undefined);
    }
    const project = await cat.project(body.projectId).catch(() => ({ name: version.file!.filename, iconUrl: null }));
    const record = await prisma.installedPlugin.upsert({
      where: { serverId_source_projectId: { serverId: server.id, source: body.source, projectId: body.projectId } },
      create: { serverId: server.id, source: body.source, projectId: body.projectId, versionId: version.id, name: project.name, versionName: version.name, path, iconUrl: project.iconUrl },
      update: { versionId: version.id, versionName: version.name, path, name: project.name, iconUrl: project.iconUrl },
    });
    await logActivity(req, existing ? 'server:plugin.update' : 'server:plugin.install', {
      serverId: server.id,
      properties: { name: record.name, version: version.name, source: body.source },
    });
    return { ok: true, path, restartNeeded: true };
  });

  async function loadRecord(req: FastifyRequest) {
    const ctx = await load(req, 'plugins.manage');
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const record = await prisma.installedPlugin.findFirst({ where: { id, serverId: ctx.server.id } });
    if (!record) throw notFound('Plugin');
    return { ...ctx, record };
  }

  /** Disable by renaming to ".jar.disabled" (the server ignores it), or enable again. */
  app.post('/:id/toggle', async (req) => {
    const { server, record } = await loadRecord(req);
    const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
    const [dir, ...rest] = record.path.split('/');
    const name = rest.join('/');
    await daemonRequest(server.node, app.encrypter, 'PUT', `/api/servers/${server.uuid}/files/rename`, {
      root: `/${dir}`,
      files: [enabled ? { from: `${name}.disabled`, to: name } : { from: name, to: `${name}.disabled` }],
    });
    await logActivity(req, enabled ? 'server:plugin.enable' : 'server:plugin.disable', { serverId: server.id, properties: { name: record.name } });
    return { ok: true };
  });

  app.delete('/:id', async (req) => {
    const { server, record } = await loadRecord(req);
    const [dir, ...rest] = record.path.split('/');
    const name = rest.join('/');
    await daemonRequest(server.node, app.encrypter, 'POST', `/api/servers/${server.uuid}/files/delete`, { root: `/${dir}`, files: [name, `${name}.disabled`] });
    await prisma.installedPlugin.delete({ where: { id: record.id } });
    await logActivity(req, 'server:plugin.uninstall', { serverId: server.id, properties: { name: record.name } });
    return { ok: true };
  });
};
