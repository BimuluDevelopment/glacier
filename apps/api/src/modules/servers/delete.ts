import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type { Node, Server } from '@prisma/client';
import { prisma } from '../../db';
import { daemonRequest } from '../nodes/daemon-client';
import { dropDatabase, hostCredentials } from '../databases/service';
import { deleteSubdomainRecords } from '../minecraft/manage';

/**
 * Delete a server and what it owns outside the panel: databases, DNS records, backup files and
 * the daemon's copy. With `force`, failures outside the panel are logged and skipped.
 */
export async function deleteServer(app: FastifyInstance, server: Server & { node: Node }, opts: { force: boolean; log: FastifyBaseLogger }) {
  const { force, log } = opts;
  const [databases, backups] = await Promise.all([
    prisma.serverDatabase.findMany({ where: { serverId: server.id }, include: { host: true } }),
    prisma.backup.findMany({ where: { serverId: server.id } }),
  ]);

  // Databases live outside the node; drop them first so a failure leaves everything in place.
  for (const db of databases) {
    try {
      await dropDatabase(hostCredentials(db.host, app.encrypter), db);
    } catch (err) {
      if (!force) throw err;
      log.warn({ err, database: db.database }, 'force-deleting server; database could not be dropped');
    }
  }
  // DNS records outlive the server otherwise.
  for (const sub of await prisma.subdomain.findMany({ where: { serverId: server.id } })) {
    await deleteSubdomainRecords(app.encrypter, sub).catch((err) => log.warn({ err, hostname: sub.hostname }, 'could not delete subdomain records'));
  }
  for (const backup of backups) {
    await daemonRequest(server.node, app.encrypter, 'DELETE', `/api/servers/${server.uuid}/backup/${backup.uuid}`).catch((err) =>
      log.warn({ err, backup: backup.uuid }, 'could not delete backup file'),
    );
  }
  try {
    await daemonRequest(server.node, app.encrypter, 'DELETE', `/api/servers/${server.uuid}`, undefined, 60_000);
  } catch (err) {
    if (!force) throw err;
    log.warn({ err, server: server.uuid }, 'force-deleting server the daemon could not remove');
  }
  // Loopback-only ports made for proxy network backends are of no use to anyone else.
  const loopback = await prisma.allocation.findMany({ where: { OR: [{ serverId: server.id }, { id: server.allocationId }], ip: '127.0.0.1' }, select: { id: true } });
  await prisma.server.delete({ where: { id: server.id } });
  if (loopback.length) await prisma.allocation.deleteMany({ where: { id: { in: loopback.map((a) => a.id) }, serverId: null } });
}
