import type { FastifyPluginAsync } from 'fastify';
import { isSettingsSection } from '@glacier/shared';
import { notFound, unprocessable } from '../../lib/errors';
import { ipMatches, normalizeIp } from '../../lib/ip';
import { logActivity } from '../../lib/activity';
import { requireAdmin } from '../../plugins/auth';
import { getSettings, updateSection } from './service';

export const settingsRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireAdmin);

  app.get('/', async () => getSettings());

  app.put('/:section', async (req) => {
    const { section } = req.params as { section: string };
    if (!isSettingsSection(section)) throw notFound('Settings section');
    // Refuse an admin IP allowlist that would lock out the admin saving it.
    const allowlist = (req.body as { adminIpAllowlist?: unknown } | null)?.adminIpAllowlist;
    if (section === 'auth' && Array.isArray(allowlist) && allowlist.length && !ipMatches(req.ip, allowlist.map(String))) {
      throw unprocessable(`Your current IP (${normalizeIp(req.ip)}) is not in the list; saving it would lock you out.`, [
        { path: 'adminIpAllowlist', message: `Add ${normalizeIp(req.ip)} first` },
      ]);
    }
    const value = await updateSection(section, req.body);
    await logActivity(req, 'admin:settings.update', { properties: { section } });
    return value;
  });
};
