import type { FastifyPluginAsync } from 'fastify';
import type { Prisma } from '@prisma/client';
import { adminUserSchema } from '@glacier/shared';
import { prisma } from '../../db';
import { conflict, notFound, unprocessable } from '../../lib/errors';
import { hashPassword } from '../../lib/password';
import { logActivity } from '../../lib/activity';
import { paged, paginate, paginationQuery, uuidParam } from '../../lib/http';
import { publicUser, requireAdmin } from '../../plugins/auth';
import { displayName, notify } from '../mail/service';

export const userRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireAdmin);

  app.get('/', async (req) => {
    const query = paginationQuery.parse(req.query);
    const where: Prisma.UserWhereInput = query.search
      ? {
          OR: [
            { email: { contains: query.search, mode: 'insensitive' } },
            { username: { contains: query.search, mode: 'insensitive' } },
          ],
        }
      : {};
    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        include: { _count: { select: { servers: true } } },
        ...paginate(query),
      }),
      prisma.user.count({ where }),
    ]);
    return paged(
      users.map((u) => ({ ...publicUser(u), serverCount: u._count.servers })),
      total,
      query,
    );
  });

  app.get('/:id', async (req) => {
    const { id } = uuidParam.parse(req.params);
    const user = await prisma.user.findUnique({
      where: { id },
      include: { servers: { select: { id: true, uuid: true, shortId: true, name: true, status: true } } },
    });
    if (!user) throw notFound('User');
    return { ...publicUser(user), servers: user.servers };
  });

  app.post('/', async (req) => {
    const body = adminUserSchema.parse(req.body);
    if (!body.password) throw unprocessable('A password is required for new users.', [{ path: 'password', message: 'Required' }]);
    const user = await prisma.user.create({
      data: {
        email: body.email.toLowerCase(),
        username: body.username,
        firstName: body.firstName,
        lastName: body.lastName,
        rootAdmin: body.rootAdmin,
        passwordHash: await hashPassword(body.password),
      },
    });
    await logActivity(req, 'admin:user.create', { properties: { userId: user.id, email: user.email } });
    void notify({ encrypter: app.encrypter, log: req.log }, 'welcome', user.email, {
      name: displayName(user),
      username: user.username,
      email: user.email,
      panelUrl: app.config.APP_URL.replace(/\/$/, ''),
    });
    return publicUser(user);
  });

  app.patch('/:id', async (req) => {
    const { id } = uuidParam.parse(req.params);
    const body = adminUserSchema.partial().parse(req.body);
    if (id === req.user!.id && body.rootAdmin === false) throw conflict('You cannot remove your own admin access.');
    const { password, ...rest } = body;
    const user = await prisma.user.update({
      where: { id },
      data: { ...rest, email: rest.email?.toLowerCase(), ...(password ? { passwordHash: await hashPassword(password) } : {}) },
    });
    if (password) await prisma.session.deleteMany({ where: { userId: id } });
    await logActivity(req, 'admin:user.update', { properties: { userId: id, fields: Object.keys(body) } });
    return publicUser(user);
  });

  app.delete('/:id', async (req) => {
    const { id } = uuidParam.parse(req.params);
    if (id === req.user!.id) throw conflict('You cannot delete your own account.');
    const servers = await prisma.server.count({ where: { ownerId: id } });
    if (servers > 0) throw conflict(`This user still owns ${servers} server(s). Delete or transfer them first.`);
    await prisma.user.delete({ where: { id } });
    await logActivity(req, 'admin:user.delete', { properties: { userId: id } });
    return { ok: true };
  });
};
