import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { User } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../db';
import { randomToken, sha256 } from '../../lib/crypto';
import { HttpError, conflict, unprocessable } from '../../lib/errors';
import { verifyPassword } from '../../lib/password';
import { logActivity } from '../../lib/activity';
import { generateRecoveryCodes, generateSecret, normalizeRecoveryCode, otpauthUrl, verifyTotp } from '../../lib/totp';
import { publicUser, requireUser, startSession } from '../../plugins/auth';
import { getSection } from '../settings/service';

/**
 * Second step of sign-in. After the password (or a social login) checks out for an account with
 * 2FA, the browser gets a short-lived ticket instead of a session and trades it plus a code for one.
 * Tickets live in memory: the panel is a single process, and an expired ticket only means
 * signing in again.
 */
const TICKET_TTL_MS = 5 * 60_000;
const TICKET_MAX_ATTEMPTS = 5;
const tickets = new Map<string, { userId: string; expiresAt: number; attempts: number }>();

export function issueLoginTicket(userId: string): string {
  const now = Date.now();
  for (const [k, t] of tickets) if (t.expiresAt < now) tickets.delete(k);
  const ticket = randomToken(24);
  tickets.set(ticket, { userId, expiresAt: now + TICKET_TTL_MS, attempts: 0 });
  return ticket;
}

/**
 * Check a TOTP or recovery code for a user, consuming it so it can't be used again. "reused" is
 * a correct authenticator code that was already spent (e.g. signing in twice within 30 seconds),
 * which deserves a different message than a wrong one.
 */
export async function consumeSecondFactor(user: User, code: string, decrypt: (v: string) => string): Promise<'totp' | 'recovery' | 'reused' | null> {
  if (user.totpEnabled && user.totpSecret) {
    const secret = decrypt(user.totpSecret);
    const step = verifyTotp(secret, code, { lastStep: user.totpLastStep });
    if (step !== null) {
      // Conditional update: two concurrent requests with the same code can't both win.
      const { count } = await prisma.user.updateMany({
        where: { id: user.id, OR: [{ totpLastStep: null }, { totpLastStep: { lt: step } }] },
        data: { totpLastStep: step },
      });
      return count ? 'totp' : 'reused';
    }
    if (verifyTotp(secret, code) !== null) return 'reused';
  }
  const normalized = normalizeRecoveryCode(code);
  if (normalized.length === 12) {
    const { count } = await prisma.recoveryCode.deleteMany({ where: { userId: user.id, codeHash: sha256(normalized) } });
    if (count) return 'recovery';
  }
  return null;
}

function rejectSecondFactor(result: 'reused' | null): never {
  if (result === 'reused') {
    throw unprocessable('That code was already used. Wait for the next code in your authenticator app (it changes every 30 seconds) and enter that one.', [
      { path: 'code', message: 'Code already used, wait for the next one' },
    ]);
  }
  throw unprocessable('That code is not valid. Check the time on your phone and try again.', [{ path: 'code', message: 'Invalid code' }]);
}

async function storeRecoveryCodes(userId: string): Promise<string[]> {
  const codes = generateRecoveryCodes();
  await prisma.$transaction([
    prisma.recoveryCode.deleteMany({ where: { userId } }),
    prisma.recoveryCode.createMany({ data: codes.map((c) => ({ userId, codeHash: sha256(normalizeRecoveryCode(c)) })) }),
  ]);
  return codes;
}

/** Pending TOTP setups (secret not yet confirmed with a code), per user. */
const pendingSecrets = new Map<string, { secret: string; expiresAt: number }>();

export const twoFactorLoginRoutes: FastifyPluginAsync = async (app) => {
  app.post('/login/2fa', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req: FastifyRequest, reply: FastifyReply) => {
    const { ticket, code } = z.object({ ticket: z.string().min(10), code: z.string().min(6).max(32) }).parse(req.body);
    const entry = tickets.get(ticket);
    if (!entry || entry.expiresAt < Date.now()) {
      tickets.delete(ticket);
      throw new HttpError(401, 'ticket_expired', 'This sign-in attempt expired. Please sign in again.');
    }
    const user = await prisma.user.findUniqueOrThrow({ where: { id: entry.userId } });
    const method = await consumeSecondFactor(user, code, (v) => app.encrypter.decrypt(v));
    if (method !== 'totp' && method !== 'recovery') {
      if (++entry.attempts >= TICKET_MAX_ATTEMPTS) tickets.delete(ticket);
      await logActivity(req, 'auth:2fa.failed', { actorId: user.id, properties: { reason: method ?? 'invalid' } });
      rejectSecondFactor(method);
    }
    tickets.delete(ticket);
    await startSession(req, reply, user);
    await logActivity(req, 'auth:login', { actorId: user.id, properties: { method: method === 'recovery' ? 'recovery-code' : 'totp' } });
    const remaining = method === 'recovery' ? await prisma.recoveryCode.count({ where: { userId: user.id } }) : undefined;
    return { user: publicUser(user), recoveryCodesLeft: remaining };
  });
};

/** /api/client/account/two-factor */
export const twoFactorAccountRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireUser);

  app.get('/', async (req) => ({
    enabled: req.user!.totpEnabled,
    recoveryCodesLeft: await prisma.recoveryCode.count({ where: { userId: req.user!.id } }),
  }));

  /** Step 1: a new secret to show as a QR code. Nothing changes until it's confirmed. */
  app.post('/setup', async (req) => {
    if (req.user!.totpEnabled) throw conflict('Two-factor authentication is already on.');
    const secret = generateSecret();
    pendingSecrets.set(req.user!.id, { secret, expiresAt: Date.now() + 15 * 60_000 });
    const { name } = await getSection('branding');
    return { secret, otpauthUrl: otpauthUrl(secret, req.user!.username, name) };
  });

  /** Step 2: prove the app is set up by entering a code; returns recovery codes once. */
  app.post('/enable', async (req) => {
    const { code } = z.object({ code: z.string().min(6).max(10) }).parse(req.body);
    const pending = pendingSecrets.get(req.user!.id);
    if (!pending || pending.expiresAt < Date.now()) throw conflict('The setup expired. Start again.');
    const step = verifyTotp(pending.secret, code);
    if (step === null) throw unprocessable('That code is not valid. Check the time on your phone and try again.', [{ path: 'code', message: 'Invalid code' }]);
    await prisma.user.update({
      where: { id: req.user!.id },
      data: { totpEnabled: true, totpSecret: app.encrypter.encrypt(pending.secret), totpLastStep: step },
    });
    pendingSecrets.delete(req.user!.id);
    const recoveryCodes = await storeRecoveryCodes(req.user!.id);
    await logActivity(req, 'user:2fa.enabled');
    return { recoveryCodes };
  });

  app.post('/recovery-codes', async (req) => {
    const { password } = z.object({ password: z.string().min(1) }).parse(req.body);
    if (!req.user!.totpEnabled) throw conflict('Two-factor authentication is off.');
    if (!(await verifyPassword(req.user!.passwordHash, password))) throw unprocessable('Incorrect password.', [{ path: 'password', message: 'Incorrect password' }]);
    const recoveryCodes = await storeRecoveryCodes(req.user!.id);
    await logActivity(req, 'user:2fa.recovery-codes-regenerated');
    return { recoveryCodes };
  });

  /** Turning 2FA off needs the password and a current code (or recovery code). */
  app.post('/disable', async (req) => {
    const { password, code } = z.object({ password: z.string().min(1), code: z.string().min(6).max(32) }).parse(req.body);
    const user = req.user!;
    if (!user.totpEnabled) throw conflict('Two-factor authentication is already off.');
    if (!(await verifyPassword(user.passwordHash, password))) throw unprocessable('Incorrect password.', [{ path: 'password', message: 'Incorrect password' }]);
    const method = await consumeSecondFactor(user, code, (v) => app.encrypter.decrypt(v));
    if (method !== 'totp' && method !== 'recovery') rejectSecondFactor(method);
    await prisma.$transaction([
      prisma.user.update({ where: { id: user.id }, data: { totpEnabled: false, totpSecret: null, totpLastStep: null } }),
      prisma.recoveryCode.deleteMany({ where: { userId: user.id } }),
    ]);
    await logActivity(req, 'user:2fa.disabled');
    return { ok: true };
  });
};
