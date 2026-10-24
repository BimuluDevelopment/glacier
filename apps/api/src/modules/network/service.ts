import { randomBytes } from 'node:crypto';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { proxyType } from '@glacier/shared';
import { prisma } from '../../db';
import { conflict } from '../../lib/errors';
import { daemonRequest } from '../nodes/daemon-client';
import { reloadCommand } from './config';

/** Backends get loopback-only ports from this range, away from the usual game ports. */
const BACKEND_PORTS = { from: 30000, to: 30999 };

/**
 * Reserve a 127.0.0.1 port on the node for a new backend. Docker publishes it on the host's
 * loopback only, so players can't skip the proxy; the proxy reaches it over the Docker network.
 */
export async function reserveBackendPort(nodeId: number) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const used = new Set((await prisma.allocation.findMany({ where: { nodeId }, select: { port: true } })).map((a) => a.port));
    let port = BACKEND_PORTS.from;
    while (port <= BACKEND_PORTS.to && used.has(port)) port++;
    if (port > BACKEND_PORTS.to) throw conflict(`No free ports left in ${BACKEND_PORTS.from}-${BACKEND_PORTS.to} on this node for network servers.`);
    try {
      return await prisma.allocation.create({ data: { nodeId, ip: '127.0.0.1', port, notes: 'Proxy network server (loopback only)' } });
    } catch (err) {
      // Someone else took the port at the same moment; look again.
      if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) throw err;
    }
  }
  throw conflict('Could not reserve a port for the new server. Please try again.');
}

/** Velocity's modern forwarding secret, created the first time a network needs one. */
export async function ensureForwardingSecret(proxyId: number): Promise<string> {
  const proxy = await prisma.server.findUniqueOrThrow({ where: { id: proxyId }, select: { forwardingSecret: true } });
  if (proxy.forwardingSecret) return proxy.forwardingSecret;
  const secret = randomBytes(24).toString('base64url');
  await prisma.server.updateMany({ where: { id: proxyId, forwardingSecret: null }, data: { forwardingSecret: secret } });
  return (await prisma.server.findUniqueOrThrow({ where: { id: proxyId }, select: { forwardingSecret: true } })).forwardingSecret!;
}

/**
 * Push a network change to the proxy: rewrite its config now and, if it is running, have it
 * reload. A proxy that is offline or installing picks the change up on its next start.
 */
export async function refreshProxy(app: FastifyInstance, proxyId: number, log: FastifyBaseLogger) {
  const proxy = await prisma.server.findUnique({ where: { id: proxyId }, include: { node: true, egg: { select: { name: true } } } });
  const type = proxy && proxyType(proxy.egg.name);
  if (!proxy || !type || proxy.status !== 'ACTIVE') return;
  const call = (method: 'POST', path: string, body?: unknown) => daemonRequest(proxy.node, app.encrypter, method, `/api/servers/${proxy.uuid}${path}`, body);
  try {
    await call('POST', '/configs/apply', {});
    // Older Velocity builds only read the secret from this file.
    if (type === 'velocity' && proxy.forwardingSecret) await call('POST', '/files/write', { file: '/forwarding.secret', content: proxy.forwardingSecret });
  } catch (err) {
    log.warn({ err, proxy: proxy.uuid }, 'could not update the proxy config now; it will be applied on its next start');
    return;
  }
  await call('POST', '/commands', { commands: [reloadCommand(type)] }).catch(() => undefined);
}

/** Apply a one-off set of config files to a server (e.g. when it joins or leaves a network). */
export async function applyServerConfigs(app: FastifyInstance, serverId: number, configs: unknown[] | undefined, log: FastifyBaseLogger) {
  const server = await prisma.server.findUnique({ where: { id: serverId }, include: { node: true } });
  if (!server || server.status !== 'ACTIVE') return;
  await daemonRequest(server.node, app.encrypter, 'POST', `/api/servers/${server.uuid}/configs/apply`, configs ? { configs } : {}).catch((err) =>
    log.warn({ err, server: server.uuid }, 'could not update server config now; it will be applied on its next start'),
  );
}
