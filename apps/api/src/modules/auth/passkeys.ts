import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { z } from 'zod';
import { prisma } from '../../db';
import { randomToken } from '../../lib/crypto';
import { HttpError, notFound, unprocessable } from '../../lib/errors';
import { logActivity } from '../../lib/activity';
import { publicUser, requireUser, startSession } from '../../plugins/auth';
import { getSection } from '../settings/service';

/**
 * Passkeys (WebAuthn). They sign in without a password, and since they need the device plus
 * a PIN/biometric they count as two-factor on their own.
 *
 * Challenges are single-use and kept in memory for a few minutes; the panel is one process.
 */
const CHALLENGE_TTL_MS = 5 * 60_000;
const challenges = new Map<string, { challenge: string; userId?: string; expiresAt: number }>();

function rememberChallenge(key: string, challenge: string, userId?: string) {
  const now = Date.now();
  for (const [k, c] of challenges) if (c.expiresAt < now) challenges.delete(k);
  challenges.set(key, { challenge, userId, expiresAt: now + CHALLENGE_TTL_MS });
}

function takeChallenge(key: string) {
  const entry = challenges.get(key);
  challenges.delete(key);
  if (!entry || entry.expiresAt < Date.now()) throw new HttpError(400, 'challenge_expired', 'That passkey request expired. Please try again.');
  return entry;
}

/** The WebAuthn relying party is the panel's own host, taken from APP_URL. */
function relyingParty(app: FastifyInstance) {
  return { rpID: new URL(app.config.APP_URL).hostname, origin: app.config.appOrigin };
}

async function assertEnabled() {
  if (!(await getSection('features')).passkeys) throw notFound('Route');
}

/** /api/client/account/passkeys */
export const passkeyAccountRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireUser);
  app.addHook('preHandler', assertEnabled);

  app.get('/', async (req) => ({
    data: await prisma.passkey.findMany({
      where: { userId: req.user!.id },
      orderBy: { createdAt: 'asc' },
      select: { id: true, name: true, deviceType: true, backedUp: true, lastUsedAt: true, createdAt: true },
    }),
  }));

  app.post('/options', async (req) => {
    const user = req.user!;
    const { name } = await getSection('branding');
    const existing = await prisma.passkey.findMany({ where: { userId: user.id }, select: { id: true, transports: true } });
    const options = await generateRegistrationOptions({
      rpName: name,
      rpID: relyingParty(app).rpID,
      userName: user.username,
      userDisplayName: user.email,
      userID: new TextEncoder().encode(user.id),
      attestationType: 'none',
      // Discoverable credentials, so the passkey can sign in without typing a username.
      authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
      excludeCredentials: existing.map((c) => ({ id: c.id, transports: c.transports as AuthenticatorTransportFuture[] })),
    });
    rememberChallenge(`reg:${user.id}`, options.challenge, user.id);
    return options;
  });

  app.post('/', async (req) => {
    const body = z.object({ name: z.string().trim().min(1).max(60).default('Passkey'), response: z.record(z.string(), z.unknown()) }).parse(req.body);
    const { challenge } = takeChallenge(`reg:${req.user!.id}`);
    const { rpID, origin } = relyingParty(app);
    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response: body.response as unknown as RegistrationResponseJSON,
        expectedChallenge: challenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        requireUserVerification: false,
      });
    } catch (err) {
      throw unprocessable(`That passkey could not be verified: ${(err as Error).message}`);
    }
    if (!verification.verified) throw unprocessable('That passkey could not be verified.');
    const info = verification.registrationInfo;
    const passkey = await prisma.passkey.create({
      data: {
        id: info.credential.id,
        userId: req.user!.id,
        name: body.name,
        publicKey: Buffer.from(info.credential.publicKey),
        counter: BigInt(info.credential.counter),
        transports: info.credential.transports ?? [],
        deviceType: info.credentialDeviceType,
        backedUp: info.credentialBackedUp,
      },
      select: { id: true, name: true, deviceType: true, backedUp: true, lastUsedAt: true, createdAt: true },
    });
    await logActivity(req, 'user:passkey.add', { properties: { name: passkey.name } });
    return passkey;
  });

  app.patch('/:id', async (req) => {
    const { id } = z.object({ id: z.string().min(1).max(512) }).parse(req.params);
    const { name } = z.object({ name: z.string().trim().min(1).max(60) }).parse(req.body);
    const { count } = await prisma.passkey.updateMany({ where: { id, userId: req.user!.id }, data: { name } });
    if (!count) throw notFound('Passkey');
    return { ok: true };
  });

  app.delete('/:id', async (req) => {
    const { id } = z.object({ id: z.string().min(1).max(512) }).parse(req.params);
    const { count } = await prisma.passkey.deleteMany({ where: { id, userId: req.user!.id } });
    if (!count) throw notFound('Passkey');
    await logActivity(req, 'user:passkey.remove');
    return { ok: true };
  });
};

/** /api/auth/passkey — passwordless sign-in. */
export const passkeyLoginRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', assertEnabled);

  app.post('/passkey/options', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async () => {
    const options = await generateAuthenticationOptions({ rpID: relyingParty(app).rpID, userVerification: 'preferred' });
    const requestId = randomToken(16);
    rememberChallenge(`auth:${requestId}`, options.challenge);
    return { requestId, options };
  });

  app.post('/passkey/verify', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = z.object({ requestId: z.string().min(10), response: z.object({ id: z.string().min(1).max(512) }).loose() }).parse(req.body);
    const { challenge } = takeChallenge(`auth:${body.requestId}`);
    const passkey = await prisma.passkey.findUnique({ where: { id: body.response.id }, include: { user: true } });
    if (!passkey) throw new HttpError(401, 'unknown_passkey', 'This passkey is not registered here. It may have been removed.');
    const { rpID, origin } = relyingParty(app);

    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response: body.response as unknown as AuthenticationResponseJSON,
        expectedChallenge: challenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        credential: {
          id: passkey.id,
          publicKey: new Uint8Array(passkey.publicKey),
          counter: Number(passkey.counter),
          transports: passkey.transports as AuthenticatorTransportFuture[],
        },
        requireUserVerification: false,
      });
    } catch (err) {
      await logActivity(req, 'auth:passkey.failed', { actorId: passkey.userId });
      throw new HttpError(401, 'passkey_invalid', `Passkey sign-in failed: ${(err as Error).message}`);
    }
    if (!verification.verified) throw new HttpError(401, 'passkey_invalid', 'Passkey sign-in failed.');

    const user = passkey.user;
    const { maintenanceMode } = await getSection('general');
    if (maintenanceMode && !user.rootAdmin) throw new HttpError(503, 'maintenance', 'The panel is in maintenance mode. Please try again later.');

    await prisma.passkey.update({
      where: { id: passkey.id },
      data: { counter: BigInt(verification.authenticationInfo.newCounter), lastUsedAt: new Date() },
    });
    await startSession(req, reply, user);
    await logActivity(req, 'auth:login', { actorId: user.id, properties: { method: 'passkey' } });
    return { user: publicUser(user) };
  });
};

