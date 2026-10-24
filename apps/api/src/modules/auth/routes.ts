import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { loginSchema, passwordSchema, registerSchema } from '@glacier/shared';
import { prisma } from '../../db';
import { HttpError, notFound, unprocessable } from '../../lib/errors';
import { randomToken, sha256 } from '../../lib/crypto';
import { hashPassword, verifyAgainstDummy, verifyPassword } from '../../lib/password';
import { logActivity } from '../../lib/activity';
import { endSession, mustSetupTwoFactor, publicUser, requireUser, startSession } from '../../plugins/auth';
import { getSection } from '../settings/service';
import { displayName, getMailConfig, mailReady, notify } from '../mail/service';
import { issueLoginTicket } from './two-factor';

const RESET_TTL_MS = 60 * 60_000;

const authLimit = { rateLimit: { max: 10, timeWindow: '1 minute' } };

export const authRoutes: FastifyPluginAsync = async (app) => {
  app.post('/login', { config: authLimit }, async (req, reply) => {
    const { login, password } = loginSchema.parse(req.body);
    const user = await prisma.user.findFirst({
      where: login.includes('@') ? { email: login.toLowerCase() } : { username: login },
    });
    const ok = user ? await verifyPassword(user.passwordHash, password) : await verifyAgainstDummy(password);
    if (!user || !ok) {
      await logActivity(req, 'auth:login.failed', { actorId: user?.id ?? null, properties: { login } });
      throw new HttpError(401, 'invalid_credentials', 'Those credentials do not match our records.');
    }
    const { maintenanceMode } = await getSection('general');
    if (maintenanceMode && !user.rootAdmin) {
      throw new HttpError(503, 'maintenance', 'The panel is in maintenance mode. Please try again later.');
    }
    // Accounts with 2FA get a short-lived ticket instead of a session; see two-factor.ts.
    if (user.totpEnabled) return { twoFactor: { ticket: issueLoginTicket(user.id) } };
    await startSession(req, reply, user);
    await logActivity(req, 'auth:login', { actorId: user.id });
    return { user: publicUser(user) };
  });

  app.post('/register', { config: authLimit }, async (req, reply) => {
    const { registration } = await getSection('features');
    if (!registration) throw notFound('Route');
    const body = registerSchema.parse(req.body);
    const user = await prisma.user.create({
      data: { email: body.email.toLowerCase(), username: body.username, passwordHash: await hashPassword(body.password) },
    });
    await startSession(req, reply, user);
    await logActivity(req, 'auth:register', { actorId: user.id });
    void notify({ encrypter: app.encrypter, log: req.log }, 'welcome', user.email, {
      name: displayName(user),
      username: user.username,
      email: user.email,
      panelUrl: app.config.APP_URL.replace(/\/$/, ''),
    });
    return { user: publicUser(user) };
  });

  /**
   * Always answers the same way so it can't be used to find out which emails have accounts.
   * The email itself is sent in the background for the same reason (timing).
   */
  app.post('/forgot-password', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req) => {
    const { email } = z.object({ email: z.email() }).parse(req.body);
    if (!mailReady(await getMailConfig())) throw new HttpError(503, 'mail_disabled', 'Password reset by email is not available. Contact an administrator.');
    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    if (user) {
      const token = randomToken(32);
      await prisma.$transaction([
        prisma.passwordReset.deleteMany({ where: { userId: user.id, usedAt: null } }),
        prisma.passwordReset.create({ data: { userId: user.id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + RESET_TTL_MS) } }),
      ]);
      const resetUrl = `${app.config.APP_URL.replace(/\/$/, '')}/reset-password?token=${encodeURIComponent(token)}`;
      void notify({ encrypter: app.encrypter, log: req.log }, 'passwordReset', user.email, { name: displayName(user), resetUrl });
      await logActivity(req, 'auth:password-reset.requested', { actorId: user.id });
    }
    return { ok: true };
  });

  app.post('/reset-password', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const { token, password } = z.object({ token: z.string().min(10).max(200), password: passwordSchema }).parse(req.body);
    const reset = await prisma.passwordReset.findUnique({ where: { tokenHash: sha256(token) } });
    if (!reset || reset.usedAt || reset.expiresAt < new Date()) {
      throw unprocessable('This reset link is invalid or has expired. Request a new one.', [{ path: 'token', message: 'Invalid or expired' }]);
    }
    await prisma.$transaction([
      prisma.user.update({ where: { id: reset.userId }, data: { passwordHash: await hashPassword(password) } }),
      prisma.passwordReset.update({ where: { id: reset.id }, data: { usedAt: new Date() } }),
      // Whoever had the old password is signed out everywhere.
      prisma.session.deleteMany({ where: { userId: reset.userId } }),
    ]);
    await logActivity(req, 'auth:password-reset.completed', { actorId: reset.userId });
    return { ok: true };
  });

  app.post('/logout', { preHandler: requireUser }, async (req, reply) => {
    await endSession(req, reply);
    return { ok: true };
  });

  app.get('/me', async (req) => ({
    user: req.user ? publicUser(req.user) : null,
    mustSetupTwoFactor: req.user ? await mustSetupTwoFactor(req.user) : false,
  }));
};
