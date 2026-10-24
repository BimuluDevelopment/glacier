import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { EMAIL_TEMPLATE_KEYS, EMAIL_TEMPLATES, type EmailTemplateKey } from '@glacier/shared';
import { unprocessable } from '../../lib/errors';
import { logActivity } from '../../lib/activity';
import { requireAdmin } from '../../plugins/auth';
import { getMailConfig, mailConfigSchema, mailReady, renderTemplate, saveMailConfig, sendMail } from './service';

const updateSchema = mailConfigSchema.omit({ passwordEncrypted: true }).extend({
  /** Omit to keep the stored password; send "" to clear it. */
  password: z.string().max(500).optional(),
});

/** Example values so admins can preview templates without real data. */
const SAMPLE: Record<string, string> = {
  name: 'Alex',
  username: 'alex',
  email: 'alex@example.com',
  serverName: 'Survival SMP',
  serverAddress: 'play.example.com:25565',
  inviter: 'Sam',
};

export const mailRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireAdmin);

  const sampleVars = () => {
    const panel = app.config.APP_URL.replace(/\/$/, '');
    return { ...SAMPLE, panelUrl: panel, resetUrl: `${panel}/reset-password?token=example`, serverUrl: `${panel}/server/abcd1234` };
  };

  app.get('/', async () => {
    const { passwordEncrypted, ...config } = await getMailConfig();
    return { ...config, passwordSet: Boolean(passwordEncrypted), ready: mailReady({ ...config, passwordEncrypted }), templates: EMAIL_TEMPLATES };
  });

  app.put('/', async (req) => {
    const body = updateSchema.parse(req.body);
    const current = await getMailConfig();
    const { password, ...rest } = body;
    if (rest.enabled && (!rest.host || !rest.fromAddress)) {
      throw unprocessable('A host and a from address are required to turn email on.', [{ path: rest.host ? 'fromAddress' : 'host', message: 'Required' }]);
    }
    const passwordEncrypted = password === undefined ? current.passwordEncrypted : password ? app.encrypter.encrypt(password) : '';
    await saveMailConfig({ ...rest, passwordEncrypted });
    await logActivity(req, 'admin:mail.update', { properties: { host: rest.host, enabled: rest.enabled } });
    return { ok: true };
  });

  /** Send a sample of any template (default: welcome) to check delivery and looks. */
  app.post('/test', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const body = z.object({ to: z.email(), template: z.enum(EMAIL_TEMPLATE_KEYS as [EmailTemplateKey, ...EmailTemplateKey[]]).default('welcome') }).parse(req.body);
    try {
      await sendMail(app.encrypter, body.to, await renderTemplate(body.template, sampleVars()));
    } catch (err) {
      throw unprocessable(`Sending failed: ${(err as Error).message}`);
    }
    await logActivity(req, 'admin:mail.test', { properties: { to: body.to } });
    return { ok: true };
  });

  app.post('/preview', async (req) => {
    const body = z
      .object({
        template: z.enum(EMAIL_TEMPLATE_KEYS as [EmailTemplateKey, ...EmailTemplateKey[]]),
        // Preview unsaved edits from the template editor.
        subject: z.string().max(200).optional(),
        body: z.string().max(20_000).optional(),
      })
      .parse(req.body);
    const draft = body.subject !== undefined && body.body !== undefined ? { subject: body.subject, body: body.body } : undefined;
    return renderTemplate(body.template, sampleVars(), draft);
  });
};
