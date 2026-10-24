import { createReadStream } from 'node:fs';
import { rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { z } from 'zod';
import { MAX_EDITABLE_FILE_BYTES, type TransferTokenClaims } from '@glacier/shared';
import type { DaemonConfig } from '../config';
import { pullFile } from '../fs/remote';
import { FileError } from '../fs/files';
import { verifyPanelToken } from '../lib/jwt';
import type { ServerManager } from '../server/manager';
import { ServerError } from '../server/server';

const uuidParam = z.object({ uuid: z.uuid() });
const fileName = z.string().min(1).max(255);
const pathString = z.string().max(4096);

/** Routes the panel calls (bearer-authenticated by the caller's hook). */
export function registerFileRoutes(api: FastifyInstance, manager: ServerManager, config: DaemonConfig) {
  const server = (params: unknown) => manager.get(uuidParam.parse(params).uuid);

  api.post('/api/servers/:uuid/files/pull', async (req) => {
    const body = z
      .object({
        url: z.url(),
        directory: pathString.default('/'),
        filename: fileName,
        sha1: z.string().regex(/^[a-f0-9]{40}$/i).optional(),
        sha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
        sha512: z.string().regex(/^[a-f0-9]{128}$/i).optional(),
      })
      .parse(req.body);
    return pullFile(server(req.params).fs, body, config.downloads.allowedHosts);
  });

  api.get('/api/servers/:uuid/files/search', async (req) => {
    const q = z
      .object({ query: z.string().trim().min(2).max(100), directory: pathString.default('/'), content: z.enum(['true', 'false']).default('false') })
      .parse(req.query);
    return server(req.params).fs.search(q.query, { directory: q.directory, content: q.content === 'true' });
  });

  api.get('/api/servers/:uuid/files/list', async (req) => {
    const { directory } = z.object({ directory: pathString.default('/') }).parse(req.query);
    return { data: await server(req.params).fs.list(directory) };
  });

  api.get('/api/servers/:uuid/files/contents', async (req, reply) => {
    const { file } = z.object({ file: pathString.min(1) }).parse(req.query);
    const data = await server(req.params).fs.readText(file);
    return reply.type('text/plain; charset=utf-8').send(data);
  });

  api.post('/api/servers/:uuid/files/write', { bodyLimit: MAX_EDITABLE_FILE_BYTES + 64 * 1024 }, async (req) => {
    // base64 lets the panel write small binary files, like a Minecraft server-icon.png.
    const body = z
      .object({ file: pathString.min(1), content: z.string().max(MAX_EDITABLE_FILE_BYTES), encoding: z.enum(['utf8', 'base64']).default('utf8') })
      .parse(req.body);
    return server(req.params).fs.write(body.file, Buffer.from(body.content, body.encoding));
  });

  api.post('/api/servers/:uuid/files/create-directory', async (req) => {
    const body = z.object({ root: pathString.default('/'), name: fileName }).parse(req.body);
    await server(req.params).fs.mkdir(body.root, body.name);
    return { ok: true };
  });

  api.put('/api/servers/:uuid/files/rename', async (req) => {
    const body = z
      .object({ root: pathString.default('/'), files: z.array(z.object({ from: pathString.min(1), to: pathString.min(1) })).min(1).max(100) })
      .parse(req.body);
    await server(req.params).fs.rename(body.root, body.files);
    return { ok: true };
  });

  api.post('/api/servers/:uuid/files/copy', async (req) => {
    const { location } = z.object({ location: pathString.min(1) }).parse(req.body);
    return { name: await server(req.params).fs.copy(location) };
  });

  api.post('/api/servers/:uuid/files/delete', async (req) => {
    const body = z.object({ root: pathString.default('/'), files: z.array(pathString.min(1)).min(1).max(500) }).parse(req.body);
    await server(req.params).fs.delete(body.root, body.files);
    return { ok: true };
  });

  api.post('/api/servers/:uuid/files/chmod', async (req) => {
    const body = z
      .object({ root: pathString.default('/'), files: z.array(z.object({ file: pathString.min(1), mode: z.string() })).min(1).max(100) })
      .parse(req.body);
    await server(req.params).fs.chmod(body.root, body.files);
    return { ok: true };
  });

  api.post('/api/servers/:uuid/files/compress', async (req) => {
    const body = z.object({ root: pathString.default('/'), files: z.array(pathString.min(1)).min(1).max(500) }).parse(req.body);
    return server(req.params).fs.compress(body.root, body.files);
  });

  api.post('/api/servers/:uuid/files/decompress', async (req) => {
    const body = z.object({ root: pathString.default('/'), file: pathString.min(1) }).parse(req.body);
    await server(req.params).fs.decompress(body.root, body.file);
    return { ok: true };
  });

  // --- Backups -----------------------------------------------------------------------------------

  api.post('/api/servers/:uuid/backup', async (req, reply) => {
    const body = z.object({ uuid: z.uuid(), ignore: z.array(z.string()).max(500).default([]) }).parse(req.body);
    const s = server(req.params);
    void s.backup(body.uuid, body.ignore);
    return reply.status(202).send({ ok: true });
  });

  api.post('/api/servers/:uuid/backup/:backup/restore', async (req, reply) => {
    const { backup } = z.object({ backup: z.uuid() }).parse(req.params);
    const { truncate } = z.object({ truncate: z.boolean().default(false) }).parse(req.body ?? {});
    const s = server(req.params);
    if (s.restoring || s.installing) throw new ServerError('The server is busy installing or restoring.');
    await stat(s.backupPath(backup)).catch(() => {
      throw new ServerError('That backup is not on this node.', 404);
    });
    void s.restore(backup, truncate).catch(() => undefined);
    return reply.status(202).send({ ok: true });
  });

  api.delete('/api/servers/:uuid/backup/:backup', async (req) => {
    const { backup } = z.object({ backup: z.uuid() }).parse(req.params);
    await rm(server(req.params).backupPath(backup), { force: true });
    return { ok: true };
  });

  // --- Access revocation -------------------------------------------------------------------------

  api.post('/api/servers/:uuid/ws/deny', async (req) => {
    const { users } = z.object({ users: z.array(z.string()).min(1).max(100) }).parse(req.body);
    server(req.params).denyUsers(users);
    return { ok: true };
  });
}

/**
 * Browser -> daemon transfers. Authorized by short-lived panel-signed tokens instead of the
 * panel bearer token, so large files never stream through the panel.
 */
export async function registerTransferRoutes(app: FastifyInstance, config: DaemonConfig, manager: ServerManager) {
  await app.register(multipart, { limits: { fileSize: config.api.uploadLimit * 1024 * 1024, files: 50, fields: 10 } });

  async function authorize(token: string, kind: TransferTokenClaims['kind']) {
    let claims: TransferTokenClaims & { iat?: number };
    try {
      claims = await verifyPanelToken<TransferTokenClaims>(token, config);
    } catch {
      throw new FileError('This link has expired or is invalid. Try again from the panel.', 401);
    }
    if (claims.kind !== kind) throw new FileError('This link is not valid for that action.', 401);
    const server = manager.get(claims.server);
    if (!server.tokenAllowed(claims.sub, claims.iat)) throw new FileError('Your access to this server was revoked.', 401);
    return { claims, server };
  }

  const asciiName = (name: string) => name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');

  app.get('/download/file', async (req, reply) => {
    const { token } = z.object({ token: z.string().min(10) }).parse(req.query);
    const { claims, server } = await authorize(token, 'download-file');
    const file = await server.fs.openRead(claims.path ?? '');
    reply.header('content-length', file.size);
    reply.header('content-disposition', `attachment; filename="${asciiName(file.name)}"; filename*=UTF-8''${encodeURIComponent(file.name)}`);
    return reply.type('application/octet-stream').send(file.stream);
  });

  app.get('/download/backup', async (req, reply) => {
    const { token } = z.object({ token: z.string().min(10) }).parse(req.query);
    const { claims, server } = await authorize(token, 'download-backup');
    const target = server.backupPath(claims.backup ?? '');
    const stats = await stat(target).catch(() => {
      throw new FileError('That backup is not on this node.', 404);
    });
    reply.header('content-length', stats.size);
    reply.header('content-disposition', `attachment; filename="backup-${server.uuid.slice(0, 8)}-${path.basename(target)}"`);
    return reply.type('application/gzip').send(createReadStream(target));
  });

  app.post('/upload/file', async (req) => {
    const { token, directory } = z.object({ token: z.string().min(10), directory: pathString.default('/') }).parse(req.query);
    const { server } = await authorize(token, 'upload');
    const uploaded: string[] = [];
    for await (const part of req.files()) {
      const name = path.posix.basename(part.filename.replace(/\\/g, '/'));
      if (!name || name === '.' || name === '..') {
        part.file.resume();
        continue;
      }
      await server.fs.write(path.posix.join(directory, name), part.file);
      if (part.file.truncated) {
        await server.fs.delete(directory, [name]);
        throw new FileError(`"${name}" is larger than the ${config.api.uploadLimit} MiB upload limit.`, 413);
      }
      uploaded.push(name);
    }
    return { uploaded };
  });
}
