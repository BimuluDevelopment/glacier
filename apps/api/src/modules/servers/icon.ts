import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../db';
import { notFound, unprocessable } from '../../lib/errors';
import { logActivity } from '../../lib/activity';
import { requireUser } from '../../plugins/auth';
import { daemonRequest } from '../nodes/daemon-client';
import { resolveServerAccess } from './service';

const MAX_ICON_BYTES = 256 * 1024;

/** Recognise an image by its first bytes rather than trusting the browser's label. */
export function sniffImage(buf: Buffer): 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' | null {
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.length > 6 && /^GIF8[79]a$/.test(buf.toString('ascii', 0, 6))) return 'image/gif';
  return null;
}

/** Width and height from a PNG's IHDR chunk. */
export function pngSize(buf: Buffer): { width: number; height: number } | null {
  if (sniffImage(buf) !== 'image/png' || buf.length < 24 || buf.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

const dataUrl = z
  .string()
  .max(Math.ceil((MAX_ICON_BYTES * 4) / 3) + 100)
  .regex(/^data:image\/[a-z+]+;base64,[A-Za-z0-9+/=]+$/, 'Expected an image');

const decode = (url: string) => Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');

/** /api/client/servers/:server/icon — the logo shown for a server across the panel. */
export const serverIconRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireUser);
  const params = z.object({ server: z.string().min(8).max(36) });

  app.get('/', async (req, reply) => {
    const { server } = await resolveServerAccess(req.user!, params.parse(req.params).server);
    const icon = await prisma.serverIcon.findUnique({ where: { serverId: server.id } });
    if (!icon) throw notFound('Logo');
    // The panel asks for ?v=<iconVersion>, so a cached copy is never stale.
    return reply
      .header('content-type', icon.type)
      .header('cache-control', 'private, max-age=31536000, immutable')
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'")
      .send(icon.data);
  });

  /**
   * Upload a logo (the browser crops it to a square first). For Minecraft servers it can also be
   * written as server-icon.png, the 64×64 picture players see in their server list.
   */
  app.put('/', { bodyLimit: 1024 * 1024 }, async (req) => {
    const { server } = await resolveServerAccess(req.user!, params.parse(req.params).server, 'settings.icon');
    const body = z.object({ image: dataUrl, minecraftIcon: dataUrl.optional() }).parse(req.body);

    const image = decode(body.image);
    const type = sniffImage(image);
    if (!type) throw unprocessable('Use a PNG, JPEG, WebP or GIF image.', [{ path: 'image', message: 'Unsupported image' }]);
    if (image.length > MAX_ICON_BYTES) throw unprocessable('That image is too large (256 KB at most).', [{ path: 'image', message: 'Too large' }]);

    let wroteMinecraftIcon = false;
    if (body.minecraftIcon) {
      const png = decode(body.minecraftIcon);
      const size = pngSize(png);
      if (!size || size.width !== 64 || size.height !== 64) throw unprocessable('The Minecraft icon must be a 64×64 PNG.', [{ path: 'minecraftIcon', message: 'Must be 64×64 PNG' }]);
      await daemonRequest(server.node, app.encrypter, 'POST', `/api/servers/${server.uuid}/files/write`, {
        file: '/server-icon.png',
        content: png.toString('base64'),
        encoding: 'base64',
      });
      wroteMinecraftIcon = true;
    }

    const iconVersion = Math.floor(Date.now() / 1000);
    await prisma.$transaction([
      prisma.serverIcon.upsert({ where: { serverId: server.id }, create: { serverId: server.id, data: image, type }, update: { data: image, type } }),
      prisma.server.update({ where: { id: server.id }, data: { iconVersion } }),
    ]);
    await logActivity(req, 'server:settings.icon', { serverId: server.id, properties: { minecraft: wroteMinecraftIcon } });
    return { iconVersion, wroteMinecraftIcon };
  });

  app.delete('/', async (req) => {
    const { server } = await resolveServerAccess(req.user!, params.parse(req.params).server, 'settings.icon');
    await prisma.$transaction([prisma.serverIcon.deleteMany({ where: { serverId: server.id } }), prisma.server.update({ where: { id: server.id }, data: { iconVersion: 0 } })]);
    await logActivity(req, 'server:settings.icon-removed', { serverId: server.id });
    return { ok: true };
  });
};
