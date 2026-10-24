import type { FastifyBaseLogger } from 'fastify';
import nodemailer, { type Transporter } from 'nodemailer';
import { z } from 'zod';
import { escapeHtml, escapeMarkdown, markdownToText, renderMarkdown, type EmailTemplateKey } from '@glacier/shared';
import { prisma } from '../../db';
import type { Encrypter } from '../../lib/crypto';
import { getSettings } from '../settings/service';

/**
 * SMTP settings are stored apart from the regular settings sections because they hold a secret:
 * the password is encrypted with APP_KEY and never sent back to the browser.
 */
const MAIL_KEY = 'mail';

export const mailConfigSchema = z.object({
  enabled: z.boolean().default(false),
  host: z.string().trim().max(255).default(''),
  port: z.number().int().min(1).max(65535).default(587),
  /** tls = implicit TLS (465), starttls = upgrade (587), none = plain (local relays only). */
  security: z.enum(['tls', 'starttls', 'none']).default('starttls'),
  username: z.string().max(255).default(''),
  passwordEncrypted: z.string().default(''),
  fromName: z.string().max(100).default(''),
  fromAddress: z.union([z.email(), z.literal('')]).default(''),
});
export type MailConfig = z.infer<typeof mailConfigSchema>;

let cached: { config: MailConfig; transport: Transporter | null } | null = null;

export async function getMailConfig(): Promise<MailConfig> {
  if (cached) return cached.config;
  const row = await prisma.setting.findUnique({ where: { key: MAIL_KEY } });
  const parsed = mailConfigSchema.safeParse(row?.value ?? {});
  const config = parsed.success ? parsed.data : mailConfigSchema.parse({});
  cached = { config, transport: null };
  return config;
}

export async function saveMailConfig(config: MailConfig) {
  await prisma.setting.upsert({ where: { key: MAIL_KEY }, create: { key: MAIL_KEY, value: config }, update: { value: config } });
  cached = null;
}

export function mailReady(config: MailConfig) {
  return config.enabled && Boolean(config.host && config.fromAddress);
}

function transportFor(config: MailConfig, encrypter: Encrypter): Transporter {
  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.security === 'tls',
    requireTLS: config.security === 'starttls',
    ignoreTLS: config.security === 'none',
    auth: config.username ? { user: config.username, pass: config.passwordEncrypted ? encrypter.decrypt(config.passwordEncrypted) : '' } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
  });
}

/** Fill `{{var}}` placeholders. Values are Markdown-escaped so user input can't add links or formatting. */
export function fillTemplate(template: string, vars: Record<string, string>, escape = true): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (whole, key: string) => {
    if (!(key in vars)) return whole;
    // URLs are trusted (we build them) and must stay intact inside [text](url).
    return escape && !/Url$/.test(key) ? escapeMarkdown(vars[key]!) : vars[key]!;
  });
}

/** Wrap rendered Markdown in a simple, widely compatible HTML email layout using the panel's branding. */
export async function renderEmailHtml(bodyMarkdown: string): Promise<string> {
  const { branding, theme } = await getSettings();
  const primary = theme.light.primary;
  const logo = branding.logoUrl && /^https?:\/\//.test(branding.logoUrl) ? `<img src="${escapeHtml(branding.logoUrl)}" alt="" height="32" style="height:32px;vertical-align:middle;margin-right:10px">` : '';
  const footer = branding.footerText || branding.name;
  const body = renderMarkdown(bodyMarkdown)
    // Inline styles: most email clients ignore <style> blocks.
    .replace(/<a /g, `<a style="color:${primary};font-weight:600" `)
    .replace(/<h1>/g, '<h1 style="font-size:22px;margin:0 0 16px">')
    .replace(/<h2>/g, '<h2 style="font-size:18px;margin:24px 0 12px">')
    .replace(/<p>/g, '<p style="margin:0 0 14px;line-height:1.6">')
    .replace(/<code>/g, '<code style="background:#f1f3f5;padding:2px 5px;border-radius:4px;font-family:monospace">');
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#f4f5f7;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1d2125">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center">
<table role="presentation" width="560" cellspacing="0" cellpadding="0" style="max-width:560px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e3e5e8">
<tr><td style="padding:18px 28px;border-bottom:4px solid ${primary};font-size:18px;font-weight:700">${logo}${escapeHtml(branding.name)}</td></tr>
<tr><td style="padding:28px;font-size:15px">${body}</td></tr>
<tr><td style="padding:16px 28px;background:#fafbfc;color:#6b7280;font-size:12px">${escapeHtml(footer)}</td></tr>
</table></td></tr></table></body></html>`;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export async function renderTemplate(
  key: EmailTemplateKey,
  vars: Record<string, string>,
  draft?: { subject: string; body: string },
): Promise<RenderedEmail> {
  const { emailTemplates, branding } = await getSettings();
  const template = draft ?? emailTemplates[key];
  const all = { panelName: branding.name, ...vars };
  const body = fillTemplate(template.body, all);
  return {
    // Subjects are plain text, so no Markdown escaping.
    subject: fillTemplate(template.subject, all, false).replace(/[\r\n]+/g, ' '),
    html: await renderEmailHtml(body),
    text: markdownToText(body),
  };
}

export async function sendMail(encrypter: Encrypter, to: string, email: RenderedEmail): Promise<void> {
  const config = await getMailConfig();
  if (!mailReady(config)) throw new Error('Email is not configured.');
  cached!.transport ??= transportFor(config, encrypter);
  await cached!.transport.sendMail({
    from: config.fromName ? { name: config.fromName, address: config.fromAddress } : config.fromAddress,
    to,
    subject: email.subject,
    html: email.html,
    text: email.text,
  });
}

/**
 * Send a templated email if mail is set up and the template is enabled. Never throws: a broken
 * SMTP server must not break sign-ups or server creation.
 */
export async function notify(
  deps: { encrypter: Encrypter; log: FastifyBaseLogger },
  key: EmailTemplateKey,
  to: string,
  vars: Record<string, string>,
): Promise<boolean> {
  try {
    const config = await getMailConfig();
    if (!mailReady(config)) return false;
    const { emailTemplates } = await getSettings();
    if (!emailTemplates[key].enabled) return false;
    await sendMail(deps.encrypter, to, await renderTemplate(key, vars));
    return true;
  } catch (err) {
    deps.log.warn({ err, template: key }, 'failed to send email');
    return false;
  }
}

export function displayName(user: { firstName: string | null; username: string }) {
  return user.firstName || user.username;
}
