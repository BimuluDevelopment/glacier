import { createHmac } from 'node:crypto';
import type { ActivityLog, Webhook } from '@prisma/client';
import { prisma } from '../../db';
import type { Encrypter } from '../../lib/crypto';
import { getSection } from '../settings/service';

/**
 * Activity -> webhook fan-out. Deliveries run in the background with a few retries; the result
 * of the latest attempt is stored on the webhook so admins can see failures.
 */

const RETRY_DELAYS_MS = [0, 5_000, 30_000];
const TIMEOUT_MS = 10_000;

let encrypter: Encrypter | null = null;
let cache: Webhook[] | null = null;

/** Called once at startup; the dispatcher needs APP_KEY to decrypt signing secrets. */
export function initWebhooks(appEncrypter: Encrypter) {
  encrypter = appEncrypter;
}

export function invalidateWebhooks() {
  cache = null;
}

async function enabledWebhooks() {
  cache ??= await prisma.webhook.findMany({ where: { enabled: true } });
  return cache;
}

/** "*" matches everything; a trailing "*" matches a prefix ("server:power.*", "admin:*"). */
export function eventMatches(pattern: string, event: string) {
  if (pattern === '*' || pattern === event) return true;
  return pattern.endsWith('*') && event.startsWith(pattern.slice(0, -1));
}

export interface WebhookPayload {
  id: string;
  event: string;
  timestamp: string;
  actor: { id: string; username: string } | null;
  server: { id: number; uuid: string; name: string } | null;
  ip: string | null;
  properties: unknown;
}

async function buildPayload(row: ActivityLog): Promise<WebhookPayload> {
  const [actor, server] = await Promise.all([
    row.actorId ? prisma.user.findUnique({ where: { id: row.actorId }, select: { id: true, username: true } }) : null,
    row.serverId ? prisma.server.findUnique({ where: { id: row.serverId }, select: { id: true, uuid: true, name: true } }) : null,
  ]);
  return { id: row.id, event: row.event, timestamp: row.createdAt.toISOString(), actor, server, ip: row.ip, properties: row.properties };
}

function discordColor(event: string) {
  if (/failed|crash|delete|suspend/.test(event)) return 0xef4444;
  if (/power\.(stop|kill)/.test(event)) return 0xf59e0b;
  if (/completed|create|start|login$/.test(event)) return 0x22c55e;
  return 0x6366f1;
}

/** A Discord webhook body: one embed per event. */
export async function discordBody(p: WebhookPayload) {
  const { name } = await getSection('branding');
  const props = p.properties && typeof p.properties === 'object' ? Object.entries(p.properties as Record<string, unknown>) : [];
  const fields = [
    ...(p.server ? [{ name: 'Server', value: p.server.name, inline: true }] : []),
    ...(p.actor ? [{ name: 'By', value: p.actor.username, inline: true }] : []),
    ...props.slice(0, 6).map(([k, v]) => ({ name: k, value: String(typeof v === 'object' ? JSON.stringify(v) : v).slice(0, 1000) || '—', inline: true })),
  ];
  return {
    username: name,
    embeds: [{ title: p.event, color: discordColor(p.event), timestamp: p.timestamp, fields }],
  };
}

export function sign(secret: string, timestamp: string, body: string) {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

/** Send one payload to one webhook (no retries). Returns the HTTP status or throws. */
export async function deliver(hook: Webhook, payload: WebhookPayload): Promise<number> {
  if (!encrypter) throw new Error('Webhooks are not initialized');
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const body = JSON.stringify(hook.format === 'discord' ? await discordBody(payload) : payload);
  const headers: Record<string, string> = { 'content-type': 'application/json', 'user-agent': 'Glacier-Webhooks/0.1' };
  if (hook.format === 'json') {
    headers['x-glacier-event'] = payload.event;
    headers['x-glacier-timestamp'] = timestamp;
    headers['x-glacier-signature'] = sign(encrypter.decrypt(hook.secretEncrypted), timestamp, body);
  }
  const res = await fetch(hook.url, { method: 'POST', headers, body, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
  return res.status;
}

async function deliverWithRetries(hook: Webhook, payload: WebhookPayload) {
  let lastError: Error | null = null;
  let status: number | null = null;
  for (const delay of RETRY_DELAYS_MS) {
    if (delay) await new Promise((r) => setTimeout(r, delay));
    try {
      status = await deliver(hook, payload);
      lastError = null;
      break;
    } catch (err) {
      lastError = err as Error;
      status = (err as { status?: number }).status ?? null;
      // A 4xx (other than rate limiting) won't fix itself; stop retrying.
      if (status && status >= 400 && status < 500 && status !== 429) break;
    }
  }
  await prisma.webhook
    .update({ where: { id: hook.id }, data: { lastStatus: status, lastError: lastError?.message.slice(0, 500) ?? null, lastTriggeredAt: new Date() } })
    .catch(() => undefined);
}

/** Fire-and-forget fan-out of one activity entry. */
export function dispatchWebhooks(row: ActivityLog) {
  void (async () => {
    const hooks = (await enabledWebhooks()).filter((h) => h.events.some((p) => eventMatches(p, row.event)));
    if (!hooks.length) return;
    const payload = await buildPayload(row);
    await Promise.all(hooks.map((h) => deliverWithRetries(h, payload)));
  })().catch(() => undefined);
}
