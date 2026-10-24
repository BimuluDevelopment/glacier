import type { FastifyPluginAsync } from 'fastify';
import { changePasswordSchema, updateAccountSchema } from '@glacier/shared';
import { prisma } from '../../db';
import { unprocessable } from '../../lib/errors';
import { hashPassword, verifyPassword } from '../../lib/password';
import { logActivity } from '../../lib/activity';
import { paged, paginate, paginationQuery } from '../../lib/http';
import { publicUser, requireUser } from '../../plugins/auth';

export const accountRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireUser);

  app.patch('/', async (req) => {
    const body = updateAccountSchema.parse(req.body);
    const user = await prisma.user.update({
      where: { id: req.user!.id },
      data: { ...body, email: body.email?.toLowerCase() },
    });
    await logActivity(req, 'user:account.update', { properties: { fields: Object.keys(body) } });
    return { user: publicUser(user) };
  });

  app.put('/password', async (req) => {
    const { currentPassword, newPassword } = changePasswordSchema.parse(req.body);
    if (!(await verifyPassword(req.user!.passwordHash, currentPassword))) {
      throw unprocessable('Your current password is incorrect.', [{ path: 'currentPassword', message: 'Incorrect password' }]);
    }
    await prisma.$transaction([
      prisma.user.update({ where: { id: req.user!.id }, data: { passwordHash: await hashPassword(newPassword) } }),
      // Sign out every other device.
      prisma.session.deleteMany({ where: { userId: req.user!.id, id: { not: req.session!.id } } }),
    ]);
    await logActivity(req, 'user:account.password-changed');
    return { ok: true };
  });

  app.get('/sessions', async (req) => {
    const sessions = await prisma.session.findMany({ where: { userId: req.user!.id }, orderBy: { lastSeenAt: 'desc' } });
    return {
      data: sessions.map((s) => ({
        id: s.id.slice(0, 12),
        ip: s.ip,
        userAgent: s.userAgent,
        createdAt: s.createdAt,
        lastSeenAt: s.lastSeenAt,
        current: s.id === req.session!.id,
      })),
    };
  });

  app.delete('/sessions/:prefix', async (req) => {
    const { prefix } = req.params as { prefix: string };
    const { count } = await prisma.session.deleteMany({
      where: { userId: req.user!.id, id: { startsWith: prefix, not: req.session!.id } },
    });
    return { revoked: count };
  });

  app.get('/activity', async (req) => {
    const query = paginationQuery.parse(req.query);
    const where = { actorId: req.user!.id };
    const [rows, total] = await Promise.all([
      prisma.activityLog.findMany({ where, orderBy: { createdAt: 'desc' }, ...paginate(query) }),
      prisma.activityLog.count({ where }),
    ]);
    return paged(rows, total, query);
  });
};
