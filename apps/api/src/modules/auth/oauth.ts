import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { OAUTH_PROVIDERS, type OAuthProvider } from '@glacier/shared';
import { prisma } from '../../db';
import { randomToken } from '../../lib/crypto';
import { conflict, notFound } from '../../lib/errors';
import { hashPassword } from '../../lib/password';
import { logActivity } from '../../lib/activity';
import { requireAdmin, requireUser, startSession } from '../../plugins/auth';
import { getSection } from '../settings/service';
import { issueLoginTicket } from './two-factor';

/**
 * Social login with Discord, Google and GitHub (OAuth 2.0 authorization code flow).
 *
 * - Client secrets are stored encrypted, apart from the regular settings (like SMTP).
 * - The `state` value is kept server-side and bound to the browser with a cookie.
 * - An unknown social account is never attached to an existing panel account by email: someone
 *   controlling a provider account with your address could take over your panel account. Users
 *   link providers themselves from Account while signed in.
 */

const CONFIG_KEY = 'oauth';
const STATE_COOKIE = 'glacier_oauth';
const STATE_TTL_MS = 10 * 60_000;

const providerConfig = z
  .object({ enabled: z.boolean().default(false), clientId: z.string().trim().max(200).default(''), clientSecretEncrypted: z.string().default('') })
  .prefault({});
const oauthConfigSchema = z.object({ discord: providerConfig, google: providerConfig, github: providerConfig });
type OAuthConfig = z.infer<typeof oauthConfigSchema>;

let cached: OAuthConfig | null = null;

export async function getOAuthConfig(): Promise<OAuthConfig> {
  if (cached) return cached;
  const row = await prisma.setting.findUnique({ where: { key: CONFIG_KEY } });
  const parsed = oauthConfigSchema.safeParse(row?.value ?? {});
  cached = parsed.success ? parsed.data : oauthConfigSchema.parse({});
  return cached;
}

/** Providers visitors can use right now (feature on, provider on, credentials present). */
export async function enabledProviders(): Promise<OAuthProvider[]> {
  if (!(await getSection('features')).oauth) return [];
  const config = await getOAuthConfig();
  return OAUTH_PROVIDERS.filter((p) => config[p].enabled && config[p].clientId && config[p].clientSecretEncrypted);
}

interface Profile {
  id: string;
  email: string | null;
  emailVerified: boolean;
  name: string;
}

const PROVIDERS: Record<
  OAuthProvider,
  { label: string; authorize: string; token: string; scope: string; pkce: boolean; profile: (accessToken: string) => Promise<Profile> }
> = {
  discord: {
    label: 'Discord',
    authorize: 'https://discord.com/oauth2/authorize',
    token: 'https://discord.com/api/oauth2/token',
    scope: 'identify email',
    pkce: false,
    profile: async (token) => {
      const u = await getJson<{ id: string; username: string; global_name?: string; email?: string; verified?: boolean }>('https://discord.com/api/users/@me', token);
      return { id: u.id, email: u.email ?? null, emailVerified: Boolean(u.verified), name: u.global_name || u.username };
    },
  },
  google: {
    label: 'Google',
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    scope: 'openid email profile',
    pkce: true,
    profile: async (token) => {
      const u = await getJson<{ sub: string; email?: string; email_verified?: boolean; name?: string }>('https://openidconnect.googleapis.com/v1/userinfo', token);
      return { id: u.sub, email: u.email ?? null, emailVerified: Boolean(u.email_verified), name: u.name || u.email?.split('@')[0] || 'user' };
    },
  },
  github: {
    label: 'GitHub',
    authorize: 'https://github.com/login/oauth/authorize',
    token: 'https://github.com/login/oauth/access_token',
    scope: 'read:user user:email',
    pkce: false,
    profile: async (token) => {
      const u = await getJson<{ id: number; login: string; name?: string }>('https://api.github.com/user', token);
      const emails = await getJson<{ email: string; primary: boolean; verified: boolean }[]>('https://api.github.com/user/emails', token).catch(() => []);
      const primary = emails.find((e) => e.primary) ?? emails.find((e) => e.verified);
      return { id: String(u.id), email: primary?.email ?? null, emailVerified: Boolean(primary?.verified), name: u.name || u.login };
    },
  },
};

async function getJson<T>(url: string, token: string): Promise<T> {
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/json', 'user-agent': 'Glacier-Panel' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`${new URL(url).host} answered HTTP ${res.status}`);
  return (await res.json()) as T;
}

const states = new Map<string, { provider: OAuthProvider; intent: 'login' | 'link'; userId?: string; verifier: string; expiresAt: number }>();

function callbackUrl(app: FastifyInstance, provider: OAuthProvider) {
  return `${app.config.APP_URL.replace(/\/$/, '')}/api/auth/oauth/${provider}/callback`;
}

/** Turn a display name into a free username matching the panel's rules. */
async function freeUsername(name: string) {
  const base = name.toLowerCase().replace(/[^a-z0-9_.-]/g, '').slice(0, 24).padEnd(3, '0') || 'user';
  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 ? base : `${base.slice(0, 24)}${Math.floor(Math.random() * 10_000)}`;
    if (!(await prisma.user.findUnique({ where: { username: candidate } }))) return candidate;
  }
  return `user${randomBytes(4).toString('hex')}`;
}

export const oauthRoutes: FastifyPluginAsync = async (app) => {
  const providerParam = z.object({ provider: z.enum(OAUTH_PROVIDERS) });
  const panel = () => app.config.APP_URL.replace(/\/$/, '');
  const fail = (reply: FastifyReply, code: string, path = '/login') => reply.redirect(`${panel()}${path}?oauthError=${encodeURIComponent(code)}`);

  /** Start a login (or, when signed in with intent=link, connect the provider to this account). */
  app.get('/oauth/:provider/start', async (req, reply) => {
    const { provider } = providerParam.parse(req.params);
    const { intent } = z.object({ intent: z.enum(['login', 'link']).default('login') }).parse(req.query);
    if (!(await enabledProviders()).includes(provider)) throw notFound('Route');
    if (intent === 'link') await requireUser(req);

    const config = (await getOAuthConfig())[provider];
    const def = PROVIDERS[provider];
    const state = randomToken(24);
    const verifier = randomToken(48);
    const now = Date.now();
    for (const [k, s] of states) if (s.expiresAt < now) states.delete(k);
    states.set(state, { provider, intent, userId: intent === 'link' ? req.user!.id : undefined, verifier, expiresAt: now + STATE_TTL_MS });

    const params = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: callbackUrl(app, provider),
      response_type: 'code',
      scope: def.scope,
      state,
      ...(provider === 'google' ? { prompt: 'select_account' } : {}),
      ...(def.pkce ? { code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' } : {}),
    });
    reply.setCookie(STATE_COOKIE, state, { path: '/api/auth/oauth', httpOnly: true, sameSite: 'lax', secure: app.config.secureCookies, maxAge: STATE_TTL_MS / 1000 });
    return reply.redirect(`${def.authorize}?${params}`);
  });

  app.get('/oauth/:provider/callback', async (req: FastifyRequest, reply) => {
    const { provider } = providerParam.parse(req.params);
    const query = z.object({ code: z.string().optional(), state: z.string().optional(), error: z.string().optional() }).parse(req.query);
    const cookieState = req.cookies[STATE_COOKIE];
    reply.clearCookie(STATE_COOKIE, { path: '/api/auth/oauth' });

    const entry = query.state ? states.get(query.state) : undefined;
    if (query.state) states.delete(query.state);
    // The state must exist, be fresh, belong to this provider, and match this browser's cookie.
    if (!entry || entry.expiresAt < Date.now() || entry.provider !== provider || !cookieState || cookieState !== query.state) {
      return fail(reply, 'expired');
    }
    const linkPath = '/account';
    if (query.error || !query.code) return fail(reply, 'cancelled', entry.intent === 'link' ? linkPath : '/login');

    let profile: Profile;
    // Provider error codes we can explain (GitHub answers HTTP 200 with an "error" field).
    let reason = 'provider_error';
    try {
      const config = (await getOAuthConfig())[provider];
      const def = PROVIDERS[provider];
      const res = await fetch(def.token, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({
          client_id: config.clientId,
          client_secret: app.encrypter.decrypt(config.clientSecretEncrypted),
          grant_type: 'authorization_code',
          code: query.code,
          redirect_uri: callbackUrl(app, provider),
          ...(def.pkce ? { code_verifier: entry.verifier } : {}),
        }),
        signal: AbortSignal.timeout(10_000),
      });
      const token = (await res.json()) as { access_token?: string; error?: string; error_description?: string };
      if (!res.ok || !token.access_token) {
        if (token.error === 'bad_verification_code' || token.error === 'invalid_grant') reason = 'code_expired';
        else if (token.error === 'incorrect_client_credentials' || token.error === 'invalid_client' || token.error === 'unauthorized_client') reason = 'bad_credentials';
        else if (token.error === 'redirect_uri_mismatch') reason = 'redirect_mismatch';
        throw new Error(token.error_description ?? token.error ?? `token endpoint answered HTTP ${res.status}`);
      }
      profile = await def.profile(token.access_token);
    } catch (err) {
      req.log.warn({ err, provider, reason }, 'oauth exchange failed');
      return fail(reply, reason, entry.intent === 'link' ? linkPath : '/login');
    }

    const linked = await prisma.oAuthAccount.findUnique({ where: { provider_providerUserId: { provider, providerUserId: profile.id } }, include: { user: true } });

    if (entry.intent === 'link') {
      if (!req.user || req.user.id !== entry.userId) return fail(reply, 'signed_out', '/login');
      if (linked && linked.userId !== req.user.id) return fail(reply, 'linked_elsewhere', linkPath);
      await prisma.oAuthAccount.upsert({
        where: { userId_provider: { userId: req.user.id, provider } },
        create: { userId: req.user.id, provider, providerUserId: profile.id, email: profile.email, displayName: profile.name },
        update: { providerUserId: profile.id, email: profile.email, displayName: profile.name },
      });
      await logActivity(req, 'user:oauth.link', { properties: { provider } });
      return reply.redirect(`${panel()}${linkPath}?linked=${provider}`);
    }

    let user = linked?.user ?? null;
    if (!user) {
      const { registration } = await getSection('features');
      if (!registration) return fail(reply, 'no_account');
      if (!profile.email || !profile.emailVerified) return fail(reply, 'email_unverified');
      // Same email as an existing account: they must sign in and link it themselves (see top).
      if (await prisma.user.findUnique({ where: { email: profile.email.toLowerCase() } })) return fail(reply, 'link_required');
      user = await prisma.user.create({
        data: {
          email: profile.email.toLowerCase(),
          username: await freeUsername(profile.name),
          // No usable password; they can set one with "Forgot password?" or keep using the provider.
          passwordHash: await hashPassword(randomToken(32)),
          oauthAccounts: { create: { provider, providerUserId: profile.id, email: profile.email, displayName: profile.name } },
        },
      });
      await logActivity(req, 'auth:register', { actorId: user.id, properties: { via: provider } });
    }

    const { maintenanceMode } = await getSection('general');
    if (maintenanceMode && !user.rootAdmin) return fail(reply, 'maintenance');
    if (user.totpEnabled) return reply.redirect(`${panel()}/login?ticket=${encodeURIComponent(issueLoginTicket(user.id))}`);
    await startSession(req, reply, user);
    await logActivity(req, 'auth:login', { actorId: user.id, properties: { method: provider } });
    return reply.redirect(`${panel()}/`);
  });
};

/** /api/client/account/oauth — linked providers. */
export const oauthAccountRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireUser);

  app.get('/', async (req) => ({
    providers: await enabledProviders(),
    linked: await prisma.oAuthAccount.findMany({
      where: { userId: req.user!.id },
      select: { provider: true, email: true, displayName: true, createdAt: true },
    }),
  }));

  app.delete('/:provider', async (req) => {
    const { provider } = z.object({ provider: z.enum(OAUTH_PROVIDERS) }).parse(req.params);
    const { count } = await prisma.oAuthAccount.deleteMany({ where: { userId: req.user!.id, provider } });
    if (!count) throw notFound('Linked account');
    await logActivity(req, 'user:oauth.unlink', { properties: { provider } });
    return { ok: true };
  });
};

/** /api/admin/oauth — provider credentials. Secrets are write-only. */
export const oauthAdminRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireAdmin);

  app.get('/', async () => {
    const config = await getOAuthConfig();
    return {
      providers: Object.fromEntries(
        OAUTH_PROVIDERS.map((p) => [
          p,
          { label: PROVIDERS[p].label, enabled: config[p].enabled, clientId: config[p].clientId, secretSet: Boolean(config[p].clientSecretEncrypted), callbackUrl: callbackUrl(app, p) },
        ]),
      ),
    };
  });

  app.put('/:provider', async (req) => {
    const { provider } = z.object({ provider: z.enum(OAUTH_PROVIDERS) }).parse(req.params);
    const body = z
      .object({ enabled: z.boolean(), clientId: z.string().trim().max(200), clientSecret: z.string().max(500).optional() })
      .parse(req.body);
    const config = await getOAuthConfig();
    const current = config[provider];
    const secret = body.clientSecret === undefined ? current.clientSecretEncrypted : body.clientSecret ? app.encrypter.encrypt(body.clientSecret) : '';
    if (body.enabled && (!body.clientId || !secret)) throw conflict('Add the client ID and secret before turning this provider on.');
    const next = { ...config, [provider]: { enabled: body.enabled, clientId: body.clientId, clientSecretEncrypted: secret } };
    await prisma.setting.upsert({ where: { key: CONFIG_KEY }, create: { key: CONFIG_KEY, value: next }, update: { value: next } });
    cached = null;
    await logActivity(req, 'admin:oauth.update', { properties: { provider, enabled: body.enabled } });
    return { ok: true };
  });
};

