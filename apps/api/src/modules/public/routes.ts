import type { FastifyPluginAsync } from 'fastify';
import { setupSchema, type PublicBranding } from '@glacier/shared';
import { prisma } from '../../db';
import { VERSION } from '../../config';
import { conflict } from '../../lib/errors';
import { hashPassword } from '../../lib/password';
import { logActivity } from '../../lib/activity';
import { publicUser, startSession } from '../../plugins/auth';
import { getSettings, updateSection } from '../settings/service';
import { ensureBundledEggs } from '../eggs/service';
import { getMailConfig, mailReady } from '../mail/service';
import { enabledProviders } from '../auth/oauth';

let setupComplete = false;

async function needsSetup() {
  if (setupComplete) return false;
  setupComplete = (await prisma.user.count({ where: { rootAdmin: true } })) > 0;
  return !setupComplete;
}

export const publicRoutes: FastifyPluginAsync = async (app) => {
  app.get('/branding', async (): Promise<PublicBranding> => {
    const [s, footerPages, mail] = await Promise.all([
      getSettings(),
      prisma.page.findMany({ where: { published: true, showInFooter: true }, orderBy: [{ sort: 'asc' }, { title: 'asc' }], select: { slug: true, title: true } }),
      getMailConfig(),
    ]);
    return {
      branding: s.branding,
      theme: s.theme,
      customCode: s.customCode,
      features: s.features,
      auth: { loginMessage: s.auth.loginMessage },
      general: { maintenanceMode: s.general.maintenanceMode, maintenanceMessage: s.general.maintenanceMessage },
      landing: s.landing,
      navigation: s.navigation,
      localization: s.localization,
      dashboard: s.dashboard,
      footerPages,
      mailEnabled: mailReady(mail),
      oauthProviders: await enabledProviders(),
      needsSetup: await needsSetup(),
      version: VERSION,
    };
  });

  /** First-run wizard: creates the root admin. Only works while no admin exists. */
  app.post('/setup', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req, reply) => {
    if (!(await needsSetup())) throw conflict('This panel has already been set up.');
    const body = setupSchema.parse(req.body);

    const user = await prisma.$transaction(async (tx) => {
      // Re-check inside the transaction so two simultaneous wizards cannot both win.
      if ((await tx.user.count({ where: { rootAdmin: true } })) > 0) throw conflict('This panel has already been set up.');
      return tx.user.create({
        data: { email: body.email.toLowerCase(), username: body.username, passwordHash: await hashPassword(body.password), rootAdmin: true },
      });
    });
    setupComplete = true;

    await updateSection('branding', { name: body.panelName });
    await ensureBundledEggs();
    await prisma.location.upsert({ where: { short: 'default' }, create: { short: 'default', long: 'Default location' }, update: {} });
    await startSession(req, reply, user);
    await logActivity(req, 'admin:setup.complete', { actorId: user.id });
    return { user: publicUser(user) };
  });
};
