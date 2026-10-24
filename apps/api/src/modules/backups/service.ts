import type { FastifyInstance } from 'fastify';
import type { Backup, Node, Server } from '@prisma/client';
import { prisma } from '../../db';
import { conflict } from '../../lib/errors';
import { daemonRequest } from '../nodes/daemon-client';

export function serializeBackup(b: Backup) {
  return {
    uuid: b.uuid,
    name: b.name,
    ignoredFiles: b.ignoredFiles,
    isSuccessful: b.isSuccessful,
    isLocked: b.isLocked,
    checksum: b.checksum,
    bytes: Number(b.bytes),
    // A backup that has not reported back yet is still running.
    status: b.completedAt ? (b.isSuccessful ? 'completed' : 'failed') : 'running',
    createdAt: b.createdAt,
    completedAt: b.completedAt,
  };
}

/**
 * Start a backup on the node. Scheduled backups rotate out the oldest unlocked backup when the
 * server is at its limit; manual backups fail instead.
 */
export async function createBackup(
  app: FastifyInstance,
  server: Server & { node: Node },
  opts: { name?: string; ignored?: string; rotate?: boolean },
): Promise<Backup> {
  if (server.backupLimit <= 0) throw conflict('This server does not allow backups.');
  const existing = await prisma.backup.findMany({ where: { serverId: server.id }, orderBy: { createdAt: 'asc' } });
  if (existing.some((b) => !b.completedAt)) throw conflict('A backup is already running for this server.');
  if (existing.length >= server.backupLimit) {
    const oldest = existing.find((b) => !b.isLocked);
    if (!opts.rotate || !oldest) {
      throw conflict(`This server has reached its limit of ${server.backupLimit} backup(s). Delete one first.`);
    }
    await deleteBackup(app, server, oldest);
  }

  const backup = await prisma.backup.create({
    data: {
      serverId: server.id,
      name: opts.name?.trim() || `Backup ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
      ignoredFiles: opts.ignored ?? '',
    },
  });
  try {
    await daemonRequest(server.node, app.encrypter, 'POST', `/api/servers/${server.uuid}/backup`, {
      uuid: backup.uuid,
      ignore: backup.ignoredFiles.split('\n').map((l) => l.trim()).filter(Boolean),
    });
  } catch (err) {
    await prisma.backup.delete({ where: { id: backup.id } });
    throw err;
  }
  return backup;
}

export async function deleteBackup(app: FastifyInstance, server: Server & { node: Node }, backup: Backup) {
  await daemonRequest(server.node, app.encrypter, 'DELETE', `/api/servers/${server.uuid}/backup/${backup.uuid}`);
  await prisma.backup.delete({ where: { id: backup.id } });
}
