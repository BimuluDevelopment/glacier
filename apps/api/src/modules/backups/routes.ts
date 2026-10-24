import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ServerPermission } from '@glacier/shared';
import { prisma } from '../../db';
import { conflict, notFound } from '../../lib/errors';
import { logActivity } from '../../lib/activity';
import { requireUser } from '../../plugins/auth';
import { daemonRequest } from '../nodes/daemon-client';
import { transferUrl } from '../nodes/tokens';
import { assertServerUsable, resolveServerAccess } from '../servers/service';
import { createBackup, deleteBackup, serializeBackup } from './service';

const params = z.object({ server: z.string().min(8).max(36), backup: z.uuid().optional() });

export const clientBackupRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireUser);

  async function load(req: FastifyRequest, permission: ServerPermission) {
    const p = params.parse(req.params);
    const { server } = await resolveServerAccess(req.user!, p.server, permission);
    if (!p.backup) return { server, backup: null };
    const backup = await prisma.backup.findFirst({ where: { uuid: p.backup, serverId: server.id } });
    if (!backup) throw notFound('Backup');
    return { server, backup };
  }

  app.get('/', async (req) => {
    const { server } = await load(req, 'backup.read');
    const backups = await prisma.backup.findMany({ where: { serverId: server.id }, orderBy: { createdAt: 'desc' } });
    return { data: backups.map(serializeBackup), limit: server.backupLimit };
  });

  app.post('/', async (req) => {
    const { server } = await load(req, 'backup.create');
    assertServerUsable(server);
    const body = z.object({ name: z.string().max(191).optional(), ignored: z.string().max(10_000).optional() }).parse(req.body ?? {});
    const backup = await createBackup(app, server, body);
    await logActivity(req, 'server:backup.start', { serverId: server.id, properties: { name: backup.name } });
    return serializeBackup(backup);
  });

  app.get('/:backup/download', async (req) => {
    const { server, backup } = await load(req, 'backup.download');
    if (!backup!.isSuccessful) throw conflict('Only completed backups can be downloaded.');
    const url = await transferUrl(app, server.node, req.user!.id, { server: server.uuid, kind: 'download-backup', backup: backup!.uuid }, 15 * 60);
    await logActivity(req, 'server:backup.download', { serverId: server.id, properties: { name: backup!.name } });
    return { url };
  });

  app.post('/:backup/lock', async (req) => {
    const { server, backup } = await load(req, 'backup.delete');
    const updated = await prisma.backup.update({ where: { id: backup!.id }, data: { isLocked: !backup!.isLocked } });
    await logActivity(req, updated.isLocked ? 'server:backup.lock' : 'server:backup.unlock', { serverId: server.id, properties: { name: backup!.name } });
    return serializeBackup(updated);
  });

  app.post('/:backup/restore', async (req) => {
    const { server, backup } = await load(req, 'backup.restore');
    assertServerUsable(server);
    if (!backup!.isSuccessful) throw conflict('Only completed backups can be restored.');
    const { truncate } = z.object({ truncate: z.boolean().default(false) }).parse(req.body ?? {});
    await daemonRequest(server.node, app.encrypter, 'POST', `/api/servers/${server.uuid}/backup/${backup!.uuid}/restore`, { truncate });
    await logActivity(req, 'server:backup.restore', { serverId: server.id, properties: { name: backup!.name, truncate } });
    return { ok: true };
  });

  app.delete('/:backup', async (req) => {
    const { server, backup } = await load(req, 'backup.delete');
    if (backup!.isLocked) throw conflict('Unlock this backup before deleting it.');
    if (!backup!.completedAt) throw conflict('Wait for this backup to finish before deleting it.');
    await deleteBackup(app, server, backup!);
    await logActivity(req, 'server:backup.delete', { serverId: server.id, properties: { name: backup!.name } });
    return { ok: true };
  });
};
