import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Node } from '@prisma/client';
import { SignJWT } from 'jose';
import type { TransferTokenClaims } from '@glacier/shared';
import { daemonBaseUrl, nodeSecret } from './daemon-client';

/** Sign a short-lived token the node's daemon will accept (websocket, downloads, uploads). */
export async function signNodeToken(
  app: FastifyInstance,
  node: Node,
  userId: string,
  claims: Record<string, unknown>,
  ttlSeconds: number,
): Promise<string> {
  const secret = new TextEncoder().encode(nodeSecret(node, app.encrypter));
  return new SignJWT({ ...claims, jti: randomUUID() })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuer(app.config.appOrigin)
    .setAudience(node.uuid)
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(secret);
}

/** A URL the browser can hit directly on the daemon for an upload or download. */
export async function transferUrl(
  app: FastifyInstance,
  node: Node,
  userId: string,
  claims: Omit<TransferTokenClaims, 'sub' | 'jti'>,
  ttlSeconds: number,
): Promise<string> {
  const route = claims.kind === 'upload' ? '/upload/file' : claims.kind === 'download-backup' ? '/download/backup' : '/download/file';
  const token = await signNodeToken(app, node, userId, claims, ttlSeconds);
  return `${daemonBaseUrl(node)}${route}?token=${encodeURIComponent(token)}`;
}
