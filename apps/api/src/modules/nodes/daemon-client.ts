import type { Node } from '@prisma/client';
import type { Encrypter } from '../../lib/crypto';
import { HttpError, badGateway, conflict } from '../../lib/errors';

export function daemonBaseUrl(node: Pick<Node, 'scheme' | 'fqdn' | 'daemonPort'>) {
  return `${node.scheme}://${node.fqdn}:${node.daemonPort}`;
}

export function daemonSocketUrl(node: Pick<Node, 'scheme' | 'fqdn' | 'daemonPort'>, serverUuid: string) {
  const scheme = node.scheme === 'https' ? 'wss' : 'ws';
  return `${scheme}://${node.fqdn}:${node.daemonPort}/api/servers/${serverUuid}/ws`;
}

export function nodeSecret(node: Pick<Node, 'secretEncrypted' | 'name'>, encrypter: Encrypter): string {
  if (!node.secretEncrypted) throw conflict(`Node "${node.name}" has not been paired with a daemon yet.`);
  return encrypter.decrypt(node.secretEncrypted);
}

/**
 * Call glacierd on a node. Throws a 502 with a readable message if the daemon cannot be reached,
 * and passes client errors (4xx, e.g. "file not found") through with the daemon's message.
 */
export async function daemonRequest<T = unknown>(
  node: Node,
  encrypter: Encrypter,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
  timeoutMs = 10_000,
  responseType: 'json' | 'text' = 'json',
): Promise<T> {
  const secret = nodeSecret(node, encrypter);
  let res: Response;
  try {
    res = await fetch(`${daemonBaseUrl(node)}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${secret}`,
        accept: 'application/json',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const reason = err instanceof Error && err.name === 'TimeoutError' ? 'timed out' : 'is unreachable';
    throw badGateway(`The daemon on node "${node.name}" ${reason}.`);
  }
  const text = await res.text();
  if (res.ok && responseType === 'text') return text as T;
  const data = text ? safeJson(text) : null;
  if (!res.ok) {
    const message = (data as { message?: string } | null)?.message ?? `HTTP ${res.status}`;
    // Validation and file errors are the user's to fix; only daemon failures are a bad gateway.
    if ((res.status >= 400 && res.status < 500 && res.status !== 401) || res.status === 507) {
      throw new HttpError(res.status, 'daemon_rejected', message);
    }
    throw badGateway(`Daemon on "${node.name}": ${message}`);
  }
  return data as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { message: text.slice(0, 200) };
  }
}
