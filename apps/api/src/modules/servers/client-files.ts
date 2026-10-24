import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { MAX_EDITABLE_FILE_BYTES, type FileEntry, type ServerPermission } from '@glacier/shared';
import { logActivity } from '../../lib/activity';
import { requireUser } from '../../plugins/auth';
import { daemonRequest } from '../nodes/daemon-client';
import { transferUrl } from '../nodes/tokens';
import { assertServerUsable, resolveServerAccess } from './service';

const serverParam = z.object({ server: z.string().min(8).max(36) });
const pathString = z.string().max(4096);
const DOWNLOAD_TTL = 5 * 60;
const UPLOAD_TTL = 15 * 60;

/** File manager. Requests are checked here, then forwarded to the server's daemon. */
export const clientFileRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireUser);

  async function access(req: FastifyRequest, permission: ServerPermission) {
    const { server: id } = serverParam.parse(req.params);
    const result = await resolveServerAccess(req.user!, id, permission);
    assertServerUsable(result.server);
    return result.server;
  }

  const forward = <T>(server: Awaited<ReturnType<typeof access>>, method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown) =>
    daemonRequest<T>(server.node, app.encrypter, method, `/api/servers/${server.uuid}/files${path}`, body, 60_000);

  app.get('/list', async (req) => {
    const server = await access(req, 'file.read');
    const { directory } = z.object({ directory: pathString.default('/') }).parse(req.query);
    return forward<{ data: FileEntry[] }>(server, 'GET', `/list?directory=${encodeURIComponent(directory)}`);
  });

  app.get('/contents', async (req, reply) => {
    const server = await access(req, 'file.read');
    const { file } = z.object({ file: pathString.min(1) }).parse(req.query);
    const text = await daemonRequest<string>(
      server.node,
      app.encrypter,
      'GET',
      `/api/servers/${server.uuid}/files/contents?file=${encodeURIComponent(file)}`,
      undefined,
      30_000,
      'text',
    );
    return reply.type('text/plain; charset=utf-8').send(text);
  });

  app.post('/write', { bodyLimit: MAX_EDITABLE_FILE_BYTES + 64 * 1024 }, async (req) => {
    const body = z.object({ file: pathString.min(1), content: z.string(), create: z.boolean().default(false) }).parse(req.body);
    const server = await access(req, body.create ? 'file.create' : 'file.update');
    const entry = await forward<FileEntry>(server, 'POST', '/write', { file: body.file, content: body.content });
    await logActivity(req, body.create ? 'server:file.create' : 'server:file.write', { serverId: server.id, properties: { file: body.file } });
    return entry;
  });

  app.post('/create-directory', async (req) => {
    const server = await access(req, 'file.create');
    const body = z.object({ root: pathString.default('/'), name: z.string().min(1).max(255) }).parse(req.body);
    await forward(server, 'POST', '/create-directory', body);
    await logActivity(req, 'server:file.create-directory', { serverId: server.id, properties: body });
    return { ok: true };
  });

  app.put('/rename', async (req) => {
    const server = await access(req, 'file.update');
    const body = z
      .object({ root: pathString.default('/'), files: z.array(z.object({ from: pathString.min(1), to: pathString.min(1) })).min(1).max(100) })
      .parse(req.body);
    await forward(server, 'PUT', '/rename', body);
    await logActivity(req, 'server:file.rename', { serverId: server.id, properties: body });
    return { ok: true };
  });

  app.post('/copy', async (req) => {
    const server = await access(req, 'file.create');
    const body = z.object({ location: pathString.min(1) }).parse(req.body);
    const result = await forward<{ name: string }>(server, 'POST', '/copy', body);
    await logActivity(req, 'server:file.copy', { serverId: server.id, properties: body });
    return result;
  });

  app.post('/delete', async (req) => {
    const server = await access(req, 'file.delete');
    const body = z.object({ root: pathString.default('/'), files: z.array(pathString.min(1)).min(1).max(500) }).parse(req.body);
    await forward(server, 'POST', '/delete', body);
    await logActivity(req, 'server:file.delete', { serverId: server.id, properties: body });
    return { ok: true };
  });

  app.post('/chmod', async (req) => {
    const server = await access(req, 'file.update');
    const body = z
      .object({ root: pathString.default('/'), files: z.array(z.object({ file: pathString.min(1), mode: z.string().regex(/^[0-7]{3}$/) })).min(1).max(100) })
      .parse(req.body);
    await forward(server, 'POST', '/chmod', body);
    return { ok: true };
  });

  app.post('/compress', async (req) => {
    const server = await access(req, 'file.archive');
    const body = z.object({ root: pathString.default('/'), files: z.array(pathString.min(1)).min(1).max(500) }).parse(req.body);
    const entry = await forward<FileEntry>(server, 'POST', '/compress', body);
    await logActivity(req, 'server:file.compress', { serverId: server.id, properties: { ...body, archive: entry.name } });
    return entry;
  });

  app.post('/decompress', async (req) => {
    const server = await access(req, 'file.archive');
    const body = z.object({ root: pathString.default('/'), file: pathString.min(1) }).parse(req.body);
    await forward(server, 'POST', '/decompress', body);
    await logActivity(req, 'server:file.decompress', { serverId: server.id, properties: body });
    return { ok: true };
  });

  app.get('/search', async (req) => {
    const server = await access(req, 'file.read');
    const q = z
      .object({ query: z.string().trim().min(2).max(100), directory: pathString.default('/'), content: z.enum(['true', 'false']).default('false') })
      .parse(req.query);
    return forward(server, 'GET', `/search?${new URLSearchParams(q)}`);
  });

  /** A one-off link the browser downloads from straight off the node. */
  app.get('/download', async (req) => {
    const server = await access(req, 'file.read');
    const { file } = z.object({ file: pathString.min(1) }).parse(req.query);
    const url = await transferUrl(app, server.node, req.user!.id, { server: server.uuid, kind: 'download-file', path: file }, DOWNLOAD_TTL);
    await logActivity(req, 'server:file.download', { serverId: server.id, properties: { file } });
    return { url };
  });

  /** An upload URL; the browser POSTs multipart files to it with `&directory=/path`. */
  app.get('/upload', async (req) => {
    const server = await access(req, 'file.create');
    const url = await transferUrl(app, server.node, req.user!.id, { server: server.uuid, kind: 'upload' }, UPLOAD_TTL);
    await logActivity(req, 'server:file.upload', { serverId: server.id });
    return { url, maxBytes: server.node.uploadSize * 1024 * 1024 };
  });
};
