import { existsSync, readFileSync, type Stats } from 'node:fs';
import fsp, { type FileHandle } from 'node:fs/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import ssh2, { type Connection, type SFTPWrapper } from 'ssh2';
import { hasPermission, type ServerPermission } from '@glacier/shared';
import type { DaemonConfig } from '../config';
import type { Logger } from '../logger';
import type { PanelClient } from '../panel';
import { PanelError } from '../panel';
import type { ServerManager } from '../server/manager';
import type { ServerInstance } from '../server/server';
import { FileError } from '../fs/files';

const { STATUS_CODE } = ssh2.utils.sftp;

interface Session {
  server: ServerInstance;
  user: string;
  username: string;
  permissions: string[];
}

type Handle =
  | { kind: 'file'; fh: FileHandle; abs: string; writing: boolean; written: number }
  | { kind: 'dir'; abs: string; sent: boolean };

/** Load the SSH host key, generating an ed25519 key on first start. */
export function loadHostKey(file: string, log: Logger): string {
  if (existsSync(file)) return readFileSync(file, 'utf8');
  const keys = ssh2.utils.generateKeyPairSync('ed25519');
  mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  writeFileSync(file, keys.private, { mode: 0o600 });
  log.info({ file }, 'generated SFTP host key');
  return keys.private;
}

function attrs(stats: Stats) {
  return {
    mode: stats.mode,
    uid: stats.uid,
    gid: stats.gid,
    size: stats.size,
    atime: Math.floor(stats.atimeMs / 1000),
    mtime: Math.floor(stats.mtimeMs / 1000),
  };
}

function longname(name: string, stats: Stats) {
  const type = stats.isDirectory() ? 'd' : stats.isSymbolicLink() ? 'l' : '-';
  let perms = '';
  for (let i = 8; i >= 0; i--) perms += stats.mode & (1 << i) ? 'rwx'[(8 - i) % 3] : '-';
  const date = stats.mtime.toLocaleString('en-US', { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  return `${type}${perms}    1 container container ${String(stats.size).padStart(10)} ${date} ${name}`;
}

/** Normalize an SFTP path into a server-relative virtual path ("/plugins/x.jar"). */
function virtual(p: string) {
  const normalized = path.posix.normalize('/' + p.replace(/\\/g, '/'));
  return normalized === '/.' ? '/' : normalized;
}

function statusFor(err: unknown) {
  if (err instanceof FileError) return err.statusCode === 404 ? STATUS_CODE.NO_SUCH_FILE : err.statusCode === 403 ? STATUS_CODE.PERMISSION_DENIED : STATUS_CODE.FAILURE;
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') return STATUS_CODE.NO_SUCH_FILE;
  if (code === 'EACCES' || code === 'EPERM') return STATUS_CODE.PERMISSION_DENIED;
  return STATUS_CODE.FAILURE;
}

/**
 * SFTP into a server's data directory. Users sign in as "<panel username>.<server short id>"
 * with their panel password; the panel checks the password and the `file.sftp` permission.
 */
export function startSftpServer(config: DaemonConfig, manager: ServerManager, panel: PanelClient, log: Logger) {
  const hostKey = loadHostKey(config.sftp.hostKey, log);
  const server = new ssh2.Server({ hostKeys: [hostKey], ident: 'glacierd' }, (client: Connection, info) => {
    let session: Session | null = null;

    client.on('authentication', (ctx) => {
      if (ctx.method !== 'password') return ctx.reject(['password']);
      panel
        .sftpAuth({ username: ctx.username, password: ctx.password, ip: info.ip })
        .then((res) => {
          const instance = manager.find(res.server);
          if (!instance) return ctx.reject(['password']);
          session = { server: instance, user: res.user, username: ctx.username, permissions: res.permissions };
          ctx.accept();
        })
        .catch((err) => {
          if (!(err instanceof PanelError && (err.status === 401 || err.status === 403))) log.warn({ err }, 'sftp auth error');
          ctx.reject(['password']);
        });
    });

    client.on('ready', () => {
      client.on('session', (accept) => {
        const s = accept();
        s.on('sftp', (acceptSftp) => {
          if (!session) return;
          attachSftp(acceptSftp(), session, log);
        });
      });
    });

    client.on('error', (err) => log.debug({ err }, 'sftp client error'));
  });

  server.on('error', (err: Error) => log.error({ err }, 'sftp server error'));
  server.listen(config.sftp.port, config.api.host, () => log.info({ port: config.sftp.port }, 'sftp listening'));
  return server;
}

function attachSftp(sftp: SFTPWrapper, session: Session, log: Logger) {
  const { server } = session;
  const fs = server.fs;
  const handles = new Map<number, Handle>();
  let nextHandle = 1;

  const can = (p: ServerPermission) => hasPermission(session.permissions, p);
  const deny = (reqid: number) => sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED);
  const fail = (reqid: number, err: unknown) => {
    log.debug({ err, server: server.uuid }, 'sftp operation failed');
    sftp.status(reqid, statusFor(err));
  };

  const makeHandle = (h: Handle) => {
    const id = nextHandle++;
    handles.set(id, h);
    const buf = Buffer.alloc(4);
    buf.writeUInt32BE(id);
    return buf;
  };
  const getHandle = (buf: Buffer) => (buf.length === 4 ? handles.get(buf.readUInt32BE(0)) : undefined);
  const dropHandle = (buf: Buffer) => buf.length === 4 && handles.delete(buf.readUInt32BE(0));

  sftp.on('REALPATH', (reqid, p) => {
    const v = virtual(p);
    sftp.name(reqid, [{ filename: v, longname: v, attrs: {} as never }]);
  });

  const statHandler = (follow: boolean) => async (reqid: number, p: string) => {
    if (!can('file.read')) return deny(reqid);
    try {
      const abs = await fs.resolve(virtual(p), { allowDenied: true });
      sftp.attrs(reqid, attrs(follow ? await fsp.stat(abs) : await fsp.lstat(abs)));
    } catch (err) {
      fail(reqid, err);
    }
  };
  sftp.on('STAT', statHandler(true));
  sftp.on('LSTAT', statHandler(false));

  sftp.on('OPENDIR', async (reqid, p) => {
    if (!can('file.read')) return deny(reqid);
    try {
      const abs = await fs.resolve(virtual(p), { allowDenied: true });
      if (!(await fsp.stat(abs)).isDirectory()) return sftp.status(reqid, STATUS_CODE.FAILURE);
      sftp.handle(reqid, makeHandle({ kind: 'dir', abs, sent: false }));
    } catch (err) {
      fail(reqid, err);
    }
  });

  sftp.on('READDIR', async (reqid, handle) => {
    const h = getHandle(handle);
    if (!h || h.kind !== 'dir') return sftp.status(reqid, STATUS_CODE.FAILURE);
    if (h.sent) return sftp.status(reqid, STATUS_CODE.EOF);
    h.sent = true;
    try {
      const names = await fsp.readdir(h.abs);
      const list = [];
      for (const name of names) {
        try {
          const stats = await fsp.lstat(path.join(h.abs, name));
          list.push({ filename: name, longname: longname(name, stats), attrs: attrs(stats) });
        } catch {
          // Vanished while listing.
        }
      }
      if (!list.length) return sftp.status(reqid, STATUS_CODE.EOF);
      sftp.name(reqid, list);
    } catch (err) {
      fail(reqid, err);
    }
  });

  sftp.on('OPEN', async (reqid, filename, flags) => {
    const mode = ssh2.utils.sftp.flagsToString(flags) ?? 'r';
    const writing = mode !== 'r';
    try {
      const abs = await fs.resolve(virtual(filename));
      const exists = await fsp.access(abs).then(
        () => true,
        () => false,
      );
      if (!can('file.read') && !writing) return deny(reqid);
      if (writing && !can(exists ? 'file.update' : 'file.create')) return deny(reqid);
      if (writing && (await fs.quota.remaining()) <= 0) return sftp.status(reqid, STATUS_CODE.FAILURE, 'Server disk limit reached');
      const fh = await fsp.open(abs, mode);
      sftp.handle(reqid, makeHandle({ kind: 'file', fh, abs, writing, written: 0 }));
    } catch (err) {
      fail(reqid, err);
    }
  });

  sftp.on('READ', async (reqid, handle, offset, length) => {
    const h = getHandle(handle);
    if (!h || h.kind !== 'file') return sftp.status(reqid, STATUS_CODE.FAILURE);
    try {
      const buf = Buffer.alloc(Math.min(length, 256 * 1024));
      const { bytesRead } = await h.fh.read(buf, 0, buf.length, offset);
      if (bytesRead === 0) return sftp.status(reqid, STATUS_CODE.EOF);
      sftp.data(reqid, buf.subarray(0, bytesRead));
    } catch (err) {
      fail(reqid, err);
    }
  });

  sftp.on('WRITE', async (reqid, handle, offset, data) => {
    const h = getHandle(handle);
    if (!h || h.kind !== 'file' || !h.writing) return sftp.status(reqid, STATUS_CODE.FAILURE);
    try {
      if ((await fs.quota.remaining()) < data.length) return sftp.status(reqid, STATUS_CODE.FAILURE, 'Server disk limit reached');
      await h.fh.write(data, 0, data.length, offset);
      h.written += data.length;
      fs.quota.add(data.length);
      sftp.status(reqid, STATUS_CODE.OK);
    } catch (err) {
      fail(reqid, err);
    }
  });

  sftp.on('FSTAT', async (reqid, handle) => {
    const h = getHandle(handle);
    if (!h) return sftp.status(reqid, STATUS_CODE.FAILURE);
    try {
      sftp.attrs(reqid, attrs(h.kind === 'file' ? await h.fh.stat() : await fsp.stat(h.abs)));
    } catch (err) {
      fail(reqid, err);
    }
  });

  sftp.on('CLOSE', async (reqid, handle) => {
    const h = getHandle(handle);
    dropHandle(handle);
    if (!h) return sftp.status(reqid, STATUS_CODE.FAILURE);
    try {
      if (h.kind === 'file') {
        await h.fh.close();
        if (h.writing) await fs.own(h.abs).catch(() => undefined);
      }
      sftp.status(reqid, STATUS_CODE.OK);
    } catch (err) {
      fail(reqid, err);
    }
  });

  sftp.on('MKDIR', async (reqid, p) => {
    if (!can('file.create')) return deny(reqid);
    try {
      const v = virtual(p);
      await fs.mkdir(path.posix.dirname(v), path.posix.basename(v));
      sftp.status(reqid, STATUS_CODE.OK);
    } catch (err) {
      fail(reqid, err);
    }
  });

  const remove = async (reqid: number, p: string) => {
    if (!can('file.delete')) return deny(reqid);
    try {
      const v = virtual(p);
      await fs.delete(path.posix.dirname(v), [path.posix.basename(v)]);
      sftp.status(reqid, STATUS_CODE.OK);
    } catch (err) {
      fail(reqid, err);
    }
  };
  sftp.on('REMOVE', remove);
  sftp.on('RMDIR', remove);

  sftp.on('RENAME', async (reqid, from, to) => {
    if (!can('file.update')) return deny(reqid);
    try {
      await fs.rename('/', [{ from: virtual(from), to: virtual(to) }]);
      sftp.status(reqid, STATUS_CODE.OK);
    } catch (err) {
      fail(reqid, err);
    }
  });

  // Ownership and permissions are managed by the daemon; accept and ignore attribute changes.
  sftp.on('SETSTAT', (reqid) => sftp.status(reqid, STATUS_CODE.OK));
  sftp.on('FSETSTAT', (reqid) => sftp.status(reqid, STATUS_CODE.OK));
  sftp.on('READLINK', (reqid) => sftp.status(reqid, STATUS_CODE.OP_UNSUPPORTED));
  sftp.on('SYMLINK', (reqid) => sftp.status(reqid, STATUS_CODE.OP_UNSUPPORTED));

  sftp.on('close', () => {
    for (const h of handles.values()) if (h.kind === 'file') void h.fh.close().catch(() => undefined);
    handles.clear();
  });
}
