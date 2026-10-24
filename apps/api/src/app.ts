import Fastify, { type FastifyError } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { Prisma } from '@prisma/client';
import { ZodError } from 'zod';
import type { AppConfig } from './config';
import { Encrypter } from './lib/crypto';
import { HttpError } from './lib/errors';
import authPlugin from './plugins/auth';
import { publicRoutes } from './modules/public/routes';
import { authRoutes } from './modules/auth/routes';
import { accountRoutes } from './modules/account/routes';
import { settingsRoutes } from './modules/settings/routes';
import { userRoutes } from './modules/users/routes';
import { locationRoutes } from './modules/locations/routes';
import { nodeRoutes } from './modules/nodes/routes';
import { eggRoutes } from './modules/eggs/routes';
import { adminServerRoutes } from './modules/servers/admin-routes';
import { clientServerRoutes } from './modules/servers/client-routes';
import { remoteRoutes } from './modules/remote/routes';
import { overviewRoutes } from './modules/overview/routes';
import { clientFileRoutes } from './modules/servers/client-files';
import { clientNetworkRoutes, clientSettingsRoutes, clientStartupRoutes, clientSubuserRoutes } from './modules/servers/client-manage';
import { clientBackupRoutes } from './modules/backups/routes';
import { clientScheduleRoutes } from './modules/schedules/routes';
import { ScheduleRunner } from './modules/schedules/service';
import { adminDatabaseHostRoutes, clientDatabaseRoutes } from './modules/databases/routes';
import { adminPageRoutes, publicPageRoutes } from './modules/pages/routes';
import { mailRoutes } from './modules/mail/routes';
import { twoFactorAccountRoutes, twoFactorLoginRoutes } from './modules/auth/two-factor';
import { passkeyAccountRoutes, passkeyLoginRoutes } from './modules/auth/passkeys';
import { oauthAccountRoutes, oauthAdminRoutes, oauthRoutes } from './modules/auth/oauth';
import { apiKeyRoutes } from './modules/api-keys/routes';
import { adminAnnouncementRoutes, clientAnnouncementRoutes } from './modules/announcements/routes';
import { pluginRoutes } from './modules/minecraft/plugins';
import { playerRoutes, statsRoutes, subdomainRoutes, versionRoutes } from './modules/minecraft/manage';
import { integrationRoutes } from './modules/integrations/service';
import { serverTemplateRoutes } from './modules/servers/templates';
import { webhookRoutes } from './modules/webhooks/routes';
import { initWebhooks } from './modules/webhooks/service';

declare module 'fastify' {
  interface FastifyInstance {
    config: AppConfig;
    encrypter: Encrypter;
    schedules: ScheduleRunner;
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export async function buildApp(config: AppConfig) {
  const app = Fastify({
    trustProxy: config.TRUST_PROXY,
    bodyLimit: 5 * 1024 * 1024,
    logger: {
      level: config.LOG_LEVEL,
      transport: config.NODE_ENV === 'development' ? { target: 'pino-pretty', options: { singleLine: true } } : undefined,
      redact: ['req.headers.authorization', 'req.headers.cookie'],
    },
  });

  app.decorate('config', config);
  app.decorate('encrypter', new Encrypter(config.APP_KEY));
  initWebhooks(app.encrypter);
  app.decorate('schedules', new ScheduleRunner(app));

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, { origin: config.appOrigin, credentials: true });
  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  await app.register(authPlugin);

  // CSRF protection for cookie-authenticated routes: browsers always send Origin on cross-site
  // writes, so reject any that do not come from the panel itself. Daemon routes use bearer tokens.
  app.addHook('onRequest', async (req) => {
    if (SAFE_METHODS.has(req.method) || req.url.startsWith('/api/remote/')) return;
    const origin = req.headers.origin;
    if (origin && origin !== config.appOrigin) {
      throw new HttpError(403, 'bad_origin', 'Cross-origin request blocked.');
    }
  });

  app.setErrorHandler((err: FastifyError | Error, req, reply) => {
    if (err instanceof HttpError) {
      return reply.status(err.statusCode).send({ error: err.code, message: err.message, details: err.details });
    }
    if (err instanceof ZodError) {
      return reply.status(422).send({
        error: 'validation',
        message: err.issues[0]?.message ?? 'Invalid input',
        details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      if (err.code === 'P2002') {
        const target = (err.meta?.target as string[] | undefined)?.join(', ') ?? 'value';
        return reply.status(409).send({ error: 'conflict', message: `That ${target} is already in use.` });
      }
      if (err.code === 'P2025') return reply.status(404).send({ error: 'not_found', message: 'Resource not found.' });
    }
    const status = (err as FastifyError).statusCode ?? 500;
    if (status >= 500) req.log.error({ err }, 'unhandled error');
    return reply.status(status).send({
      error: status === 429 ? 'rate_limited' : status >= 500 ? 'internal' : 'bad_request',
      message: status >= 500 ? 'Something went wrong on our side.' : err.message,
    });
  });

  app.setNotFoundHandler((_req, reply) => reply.status(404).send({ error: 'not_found', message: 'Route not found.' }));

  await app.register(publicRoutes, { prefix: '/api/public' });
  await app.register(publicPageRoutes, { prefix: '/api/public' });
  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(twoFactorLoginRoutes, { prefix: '/api/auth' });
  await app.register(passkeyLoginRoutes, { prefix: '/api/auth' });
  await app.register(oauthRoutes, { prefix: '/api/auth' });
  await app.register(accountRoutes, { prefix: '/api/client/account' });
  await app.register(twoFactorAccountRoutes, { prefix: '/api/client/account/two-factor' });
  await app.register(passkeyAccountRoutes, { prefix: '/api/client/account/passkeys' });
  await app.register(oauthAccountRoutes, { prefix: '/api/client/account/oauth' });
  await app.register(apiKeyRoutes, { prefix: '/api/client/account/api-keys' });
  await app.register(clientAnnouncementRoutes, { prefix: '/api/client/announcements' });
  await app.register(clientServerRoutes, { prefix: '/api/client/servers' });
  await app.register(clientFileRoutes, { prefix: '/api/client/servers/:server/files' });
  await app.register(clientBackupRoutes, { prefix: '/api/client/servers/:server/backups' });
  await app.register(clientScheduleRoutes, { prefix: '/api/client/servers/:server/schedules' });
  await app.register(clientDatabaseRoutes, { prefix: '/api/client/servers/:server/databases' });
  await app.register(clientSubuserRoutes, { prefix: '/api/client/servers/:server/users' });
  await app.register(clientStartupRoutes, { prefix: '/api/client/servers/:server/startup' });
  await app.register(clientNetworkRoutes, { prefix: '/api/client/servers/:server/network' });
  await app.register(clientSettingsRoutes, { prefix: '/api/client/servers/:server/settings' });
  await app.register(pluginRoutes, { prefix: '/api/client/servers/:server/plugins' });
  await app.register(versionRoutes, { prefix: '/api/client/servers/:server/version' });
  await app.register(playerRoutes, { prefix: '/api/client/servers/:server/players' });
  await app.register(statsRoutes, { prefix: '/api/client/servers/:server/stats' });
  await app.register(subdomainRoutes, { prefix: '/api/client/servers/:server/subdomains' });
  await app.register(overviewRoutes, { prefix: '/api/admin/overview' });
  await app.register(settingsRoutes, { prefix: '/api/admin/settings' });
  await app.register(userRoutes, { prefix: '/api/admin/users' });
  await app.register(locationRoutes, { prefix: '/api/admin/locations' });
  await app.register(nodeRoutes, { prefix: '/api/admin/nodes' });
  await app.register(eggRoutes, { prefix: '/api/admin' });
  await app.register(adminServerRoutes, { prefix: '/api/admin/servers' });
  await app.register(adminDatabaseHostRoutes, { prefix: '/api/admin/database-hosts' });
  await app.register(adminPageRoutes, { prefix: '/api/admin/pages' });
  await app.register(mailRoutes, { prefix: '/api/admin/mail' });
  await app.register(webhookRoutes, { prefix: '/api/admin/webhooks' });
  await app.register(oauthAdminRoutes, { prefix: '/api/admin/oauth' });
  await app.register(adminAnnouncementRoutes, { prefix: '/api/admin/announcements' });
  await app.register(integrationRoutes, { prefix: '/api/admin/integrations' });
  await app.register(serverTemplateRoutes, { prefix: '/api/admin/server-templates' });
  await app.register(remoteRoutes, { prefix: '/api/remote' });

  app.get('/api/health', async () => ({ ok: true }));

  return app;
}
