import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { renderMarkdown } from '@glacier/shared';
import { prisma } from '../../db';
import { notFound } from '../../lib/errors';
import { logActivity } from '../../lib/activity';
import { idParam } from '../../lib/http';
import { requireAdmin } from '../../plugins/auth';

const RESERVED = new Set(['admin', 'api', 'login', 'register', 'setup', 'server', 'account']);

const pageSchema = z.object({
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Lowercase letters, numbers and dashes, like terms-of-service')
    .max(80)
    .refine((s) => !RESERVED.has(s), 'That address is reserved'),
  title: z.string().trim().min(1).max(160),
  content: z.string().max(200_000).default(''),
  published: z.boolean().default(false),
  showInFooter: z.boolean().default(false),
  sort: z.number().int().default(0),
});

export const adminPageRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireAdmin);

  app.get('/', async () => ({
    data: await prisma.page.findMany({ orderBy: [{ sort: 'asc' }, { title: 'asc' }], select: { id: true, slug: true, title: true, published: true, showInFooter: true, sort: true, updatedAt: true } }),
  }));

  app.get('/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const page = await prisma.page.findUnique({ where: { id } });
    if (!page) throw notFound('Page');
    return page;
  });

  app.post('/', async (req) => {
    const page = await prisma.page.create({ data: pageSchema.parse(req.body) });
    await logActivity(req, 'admin:page.create', { properties: { slug: page.slug } });
    return page;
  });

  app.patch('/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const page = await prisma.page.update({ where: { id }, data: pageSchema.partial().parse(req.body) });
    await logActivity(req, 'admin:page.update', { properties: { slug: page.slug } });
    return page;
  });

  app.delete('/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const page = await prisma.page.delete({ where: { id } });
    await logActivity(req, 'admin:page.delete', { properties: { slug: page.slug } });
    return { ok: true };
  });

  /** Render Markdown exactly as the public page will, for the editor preview. */
  app.post('/preview', async (req) => {
    const { content } = z.object({ content: z.string().max(200_000) }).parse(req.body);
    return { html: renderMarkdown(content) };
  });
};

export const publicPageRoutes: FastifyPluginAsync = async (app) => {
  app.get('/pages/:slug', async (req) => {
    const { slug } = z.object({ slug: z.string().max(80) }).parse(req.params);
    const page = await prisma.page.findUnique({ where: { slug } });
    // Drafts are visible to admins so they can check them before publishing.
    if (!page || (!page.published && !req.user?.rootAdmin)) throw notFound('Page');
    return { slug: page.slug, title: page.title, html: renderMarkdown(page.content), published: page.published, updatedAt: page.updatedAt };
  });
};
