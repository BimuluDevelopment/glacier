import fp from 'fastify-plugin';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ApiKey, Session, User } from '@prisma/client';
import type { ApiKeyScope } from '@glacier/shared';
import { prisma } from '../db';
import { randomToken, safeEqual, sha256 } from '../lib/crypto';
import { HttpError, forbidden, unauthorized } from '../lib/errors';
import { ipMatches } from '../lib/ip';
import { getSection } from '../modules/settings/service';

export const SESSION_COOKIE = 'glacier_session';
const TOUCH_INTERVAL_MS = 5 * 60_000;
const API_KEY_PATTERN = /^glacier_([a-z0-9]{12})_([A-Za-z0-9_-]{32,})$/;

declare module 'fastify' {
  interface FastifyRequest {
    user: User | null;
    session: Session | null;
    /** Set when the request authenticated with an API key instead of a session cookie. */
    apiKey: ApiKey | null;
  }
}

/** Whether this user must turn on 2FA (per the admin setting) before using the panel. */
export async function mustSetupTwoFactor(user: User): Promise<boolean> {
  const { require2fa } = await getSection('auth');
  if (require2fa === 'none' || (require2fa === 'admins' && !user.rootAdmin)) return false;
  if (user.totpEnabled) return false;
  return (await prisma.passkey.count({ where: { userId: user.id } })) === 0;
}

/** Scope an API key needs for a request, or null when keys may not use the route at all. */
export function requiredScope(method: string, url: string): ApiKeyScope | null | 'none' {
  const path = url.split('?')[0]!;
  const write = !['GET', 'HEAD', 'OPTIONS'].includes(method);
  if (path.startsWith('/api/public/') || path === '/api/health' || path === '/api/auth/me') return 'none';
  // Keys can't manage the account (passwords, 2FA, other keys) or sign in/out.
  if (path.startsWith('/api/client/account') || path.startsWith('/api/auth/')) return null;
  if (path.startsWith('/api/client/')) return write ? 'client:write' : 'client:read';
  if (path.startsWith('/api/admin/')) return write ? 'admin:write' : 'admin:read';
  return null;
}

async function authenticateApiKey(req: FastifyRequest, token: string) {
  const match = API_KEY_PATTERN.exec(token);
  if (!match) throw unauthorized('Invalid API key.');
  const key = await prisma.apiKey.findUnique({ where: { identifier: match[1]! }, include: { user: true } });
  if (!key || !safeEqual(key.secretHash, sha256(match[2]!))) throw unauthorized('Invalid API key.');
  if (key.expiresAt && key.expiresAt < new Date()) throw unauthorized('This API key has expired.');
  if (key.allowedIps.length && !ipMatches(req.ip, key.allowedIps)) throw new HttpError(403, 'ip_not_allowed', 'This API key cannot be used from your IP address.');

  const scope = requiredScope(req.method, req.url);
  if (scope === null) throw forbidden('API keys cannot be used for this endpoint.');
  if (scope !== 'none' && !key.scopes.includes(scope)) throw forbidden(`This API key is missing the "${scope}" scope.`);
  if (scope?.startsWith('admin:') && !key.user.rootAdmin) throw forbidden('This API key belongs to a non-admin user.');

  const { user, ...rest } = key;
  req.user = user;
  req.apiKey = rest;
  if (!key.lastUsedAt || Date.now() - key.lastUsedAt.getTime() > TOUCH_INTERVAL_MS) {
    await prisma.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } });
  }
}

export default fp(async (app) => {
  app.decorateRequest('user', null);
  app.decorateRequest('session', null);
  app.decorateRequest('apiKey', null);

  app.addHook('onRequest', async (req) => {
    const header = req.headers.authorization;
    // Daemon routes use their own bearer tokens.
    if (header?.startsWith('Bearer ') && !req.url.startsWith('/api/remote/')) {
      await authenticateApiKey(req, header.slice(7).trim());
      return;
    }

    const token = req.cookies[SESSION_COOKIE];
    if (!token) return;
    const session = await prisma.session.findUnique({ where: { id: sha256(token) }, include: { user: true } });
    if (!session || session.expiresAt < new Date()) return;

    const { user, ...rest } = session;
    req.user = user;
    req.session = rest;

    if (Date.now() - session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
      const { sessionDays } = await getSection('auth');
      await prisma.session.update({
        where: { id: session.id },
        data: { lastSeenAt: new Date(), expiresAt: new Date(Date.now() + sessionDays * 86_400_000), ip: req.ip },
      });
    }
  });
});

export async function startSession(req: FastifyRequest, reply: FastifyReply, user: User) {
  const token = randomToken(32);
  const { sessionDays } = await getSection('auth');
  const expiresAt = new Date(Date.now() + sessionDays * 86_400_000);
  await prisma.session.create({
    data: { id: sha256(token), userId: user.id, ip: req.ip, userAgent: req.headers['user-agent']?.slice(0, 255), expiresAt },
  });
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: req.server.config.secureCookies,
    expires: expiresAt,
  });
}

export async function endSession(req: FastifyRequest, reply: FastifyReply) {
  if (req.session) await prisma.session.deleteMany({ where: { id: req.session.id } });
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

/**
 * Signed in, and (for browser sessions) 2FA set up when the admin requires it. Account routes stay
 * reachable so users can actually turn 2FA on.
 */
export async function requireUser(req: FastifyRequest) {
  if (!req.user) throw unauthorized();
  if (req.session && !req.url.startsWith('/api/client/account') && (await mustSetupTwoFactor(req.user))) {
    throw new HttpError(403, 'two_factor_setup_required', 'Turn on two-factor authentication in your account settings to continue.');
  }
}

export async function requireAdmin(req: FastifyRequest) {
  await requireUser(req);
  if (!req.user!.rootAdmin) throw forbidden('This area is for administrators only.');
  const { adminIpAllowlist } = await getSection('auth');
  if (adminIpAllowlist.length && !ipMatches(req.ip, adminIpAllowlist)) {
    throw new HttpError(403, 'ip_not_allowed', 'The admin area cannot be reached from your IP address.');
  }
}

/** Shape of a user safe to send to the browser. */
export function publicUser(user: User) {
  return {
    id: user.id,
    email: user.email,
    username: user.username,
    firstName: user.firstName,
    lastName: user.lastName,
    rootAdmin: user.rootAdmin,
    language: user.language,
    totpEnabled: user.totpEnabled,
    createdAt: user.createdAt,
  };
}
