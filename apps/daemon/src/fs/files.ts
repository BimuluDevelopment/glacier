import { createReadStream, createWriteStream, type Stats } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { MAX_EDITABLE_FILE_BYTES, PathMatcher, type FileEntry, type FileSearchHit } from '@glacier/shared';
import { createTarGz, extractArchive } from './archive';
import { chownPath, chownRecursive } from './ownership';
import { directorySize, resolveSafe, SandboxError } from './sandbox';

export class FileError extends Error {
  constructor(
    message: string,
    public readonly statusCode = 400,
  ) {
    super(message);
  }
}

/** Disk accounting for one server. `remaining()` is Infinity for unlimited servers. */
export interface Quota {
  remaining(): Promise<number>;
  add(bytes: number): void;
}

const BINARY_EXTENSIONS = new Set([
  'jar', 'zip', 'gz', 'tgz', 'tar', 'rar', '7z', 'xz', 'bz2', 'mrpack', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp',
  'mp3', 'ogg', 'wav', 'mp4', 'webm', 'exe', 'dll', 'so', 'bin', 'dat', 'db', 'sqlite', 'mca', 'mcr', 'nbt', 'class', 'pdf',
]);

const MIME: Record<string, string> = {
  txt: 'text/plain', log: 'text/plain', properties: 'text/x-java-properties', json: 'application/json', yml: 'text/yaml',
  yaml: 'text/yaml', toml: 'application/toml', ini: 'text/plain', cfg: 'text/plain', conf: 'text/plain', xml: 'application/xml',
  js: 'text/javascript', mjs: 'text/javascript', ts: 'text/typescript', py: 'text/x-python', sh: 'text/x-shellscript',
  md: 'text/markdown', html: 'text/html', css: 'text/css', jar: 'application/java-archive', zip: 'application/zip',
  gz: 'application/gzip', tgz: 'application/gzip', tar: 'application/x-tar', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
};

function extension(name: string) {
  const i = name.lastIndexOf('.');
  return i === -1 ? '' : name.slice(i + 1).toLowerCase();
}

function modeString(stats: Stats): string {
  const type = stats.isDirectory() ? 'd' : stats.isSymbolicLink() ? 'l' : '-';
  const bits = ['r', 'w', 'x'];
  let out = type;
  for (let i = 8; i >= 0; i--) out += stats.mode & (1 << i) ? bits[(8 - i) % 3] : '-';
  return out;
}

export function toEntry(name: string, stats: Stats): FileEntry {
  const ext = extension(name);
  const isFile = stats.isFile();
  return {
    name,
    mode: modeString(stats),
    modeBits: (stats.mode & 0o777).toString(8).padStart(3, '0'),
    size: stats.size,
    isFile,
    isDirectory: stats.isDirectory(),
    isSymlink: stats.isSymbolicLink(),
    mimetype: stats.isDirectory() ? 'inode/directory' : (MIME[ext] ?? 'application/octet-stream'),
    editable: isFile && stats.size <= MAX_EDITABLE_FILE_BYTES && !BINARY_EXTENSIONS.has(ext),
    createdAt: stats.birthtime.toISOString(),
    modifiedAt: stats.mtime.toISOString(),
  };
}

function translate(err: unknown): never {
  if (err instanceof FileError) throw err;
  if (err instanceof SandboxError) throw new FileError(err.message, 403);
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') throw new FileError('That file or folder does not exist.', 404);
  if (code === 'EEXIST') throw new FileError('Something with that name already exists.', 409);
  if (code === 'ENOTEMPTY') throw new FileError('That folder is not empty.', 409);
  if (code === 'EISDIR') throw new FileError('That is a folder, not a file.', 400);
  if (code === 'ENOTDIR') throw new FileError('That is a file, not a folder.', 400);
  throw err;
}

/**
 * Every file operation on a server's data directory, used by the HTTP API and SFTP alike.
 * All paths are server-relative ("/plugins/x.jar"); nothing can escape the data directory, and
 * files on the egg's denylist can be listed but not read, changed or deleted.
 */
export class ServerFilesystem {
  constructor(
    readonly root: string,
    private readonly opts: { uid: number; gid: number; denylist: () => string[]; quota: Quota },
  ) {}

  get quota() {
    return this.opts.quota;
  }

  /** Server-relative path with forward slashes and no leading slash. */
  relative(abs: string, rootReal: string) {
    return path.relative(rootReal, abs).split(path.sep).join('/');
  }

  async resolve(userPath: string, opts: { allowDenied?: boolean } = {}): Promise<string> {
    const abs = await resolveSafe(this.root, userPath).catch(translate);
    if (!opts.allowDenied && (await this.isDenied(abs))) {
      throw new FileError('This file is protected by the server type and cannot be accessed.', 403);
    }
    return abs;
  }

  async isDenied(abs: string): Promise<boolean> {
    const patterns = this.opts.denylist();
    if (!patterns.length) return false;
    const rootReal = await fsp.realpath(this.root);
    return new PathMatcher(patterns).matches(this.relative(abs, rootReal));
  }

  /** Hand a path to the container user. */
  async own(target: string, recursive = false) {
    if (recursive) await chownRecursive(target, this.opts.uid, this.opts.gid);
    else await chownPath(target, this.opts.uid, this.opts.gid);
  }

  async list(dir: string): Promise<FileEntry[]> {
    const abs = await this.resolve(dir || '/', { allowDenied: true });
    try {
      const dirents = await fsp.readdir(abs, { withFileTypes: true });
      const entries = await Promise.all(
        dirents.map(async (d) => {
          try {
            return toEntry(d.name, await fsp.lstat(path.join(abs, d.name)));
          } catch {
            return null;
          }
        }),
      );
      return entries
        .filter((e): e is FileEntry => e !== null)
        .sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name, undefined, { numeric: true }));
    } catch (err) {
      translate(err);
    }
  }

  async stat(file: string): Promise<{ abs: string; stats: Stats }> {
    const abs = await this.resolve(file);
    try {
      return { abs, stats: await fsp.stat(abs) };
    } catch (err) {
      translate(err);
    }
  }

  async readText(file: string): Promise<Buffer> {
    const { abs, stats } = await this.stat(file);
    if (!stats.isFile()) throw new FileError('That is not a file.');
    if (stats.size > MAX_EDITABLE_FILE_BYTES) throw new FileError('This file is too large to open in the editor; download it instead.', 413);
    return fsp.readFile(abs);
  }

  async openRead(file: string): Promise<{ stream: Readable; size: number; name: string }> {
    const { abs, stats } = await this.stat(file);
    if (!stats.isFile()) throw new FileError('Only files can be downloaded.');
    return { stream: createReadStream(abs), size: stats.size, name: path.basename(abs) };
  }

  /** Write a file from a buffer or stream, enforcing the disk limit while streaming. */
  async write(file: string, data: Buffer | Readable): Promise<FileEntry> {
    const abs = await this.resolve(file);
    let previous = 0;
    try {
      previous = (await fsp.stat(abs)).size;
    } catch {
      // New file.
    }
    let budget = (await this.quota.remaining()) + previous;
    const createdDir = await fsp.mkdir(path.dirname(abs), { recursive: true }).catch(translate);
    let written = 0;
    const limiter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        written += chunk.length;
        budget -= chunk.length;
        if (budget < 0) return cb(new FileError('Not enough disk space for this file.', 507));
        cb(null, chunk);
      },
    });
    const source = Buffer.isBuffer(data) ? Readable.from([data]) : data;
    try {
      await pipeline(source, limiter, createWriteStream(abs));
    } catch (err) {
      if (err instanceof FileError) await fsp.rm(abs, { force: true });
      translate(err);
    }
    this.quota.add(written - previous);
    if (createdDir) await this.own(createdDir, true);
    await this.own(abs);
    return toEntry(path.basename(abs), await fsp.lstat(abs));
  }

  async mkdir(root: string, name: string): Promise<void> {
    const abs = await this.resolve(path.posix.join(root || '/', name));
    try {
      await fsp.mkdir(abs);
    } catch (err) {
      translate(err);
    }
    await this.own(abs);
  }

  async rename(root: string, files: { from: string; to: string }[]): Promise<void> {
    for (const f of files) {
      const from = await this.resolve(path.posix.join(root || '/', f.from));
      const to = await this.resolve(path.posix.join(root || '/', f.to));
      try {
        await fsp.access(to).then(
          () => {
            throw new FileError(`"${f.to}" already exists.`, 409);
          },
          () => undefined,
        );
        await fsp.mkdir(path.dirname(to), { recursive: true });
        await fsp.rename(from, to);
      } catch (err) {
        translate(err);
      }
    }
  }

  /** Copy a file or folder next to itself as "name copy.ext", "name copy 2.ext", ... */
  async copy(location: string): Promise<string> {
    const { abs, stats } = await this.stat(location);
    const size = stats.isDirectory() ? 0 : stats.size;
    if (size > (await this.quota.remaining())) throw new FileError('Not enough disk space to copy this.', 507);
    const dir = path.dirname(abs);
    const ext = stats.isFile() ? path.extname(abs).replace(/^\.(gz)$/, '') : '';
    const base = path.basename(abs, ext);
    let target = '';
    for (let n = 1; n < 100; n++) {
      target = path.join(dir, `${base} copy${n > 1 ? ` ${n}` : ''}${ext}`);
      try {
        await fsp.access(target);
      } catch {
        break;
      }
    }
    await fsp.cp(abs, target, { recursive: true, errorOnExist: true, force: false }).catch(translate);
    this.quota.add(size);
    await this.own(target, stats.isDirectory());
    return path.basename(target);
  }

  async delete(root: string, files: string[]): Promise<void> {
    for (const name of files) {
      const abs = await this.resolve(path.posix.join(root || '/', name));
      if (abs === (await fsp.realpath(this.root))) throw new FileError('You cannot delete the server root.', 403);
      const stats = await fsp.lstat(abs).catch(() => null);
      if (!stats) continue;
      const freed = stats.isDirectory() ? await directorySize(abs) : stats.size;
      await fsp.rm(abs, { recursive: true, force: true }).catch(translate);
      this.quota.add(-freed);
    }
  }

  async chmod(root: string, files: { file: string; mode: string }[]): Promise<void> {
    for (const f of files) {
      if (!/^[0-7]{3}$/.test(f.mode)) throw new FileError(`"${f.mode}" is not a valid mode like 644.`);
      const abs = await this.resolve(path.posix.join(root || '/', f.file));
      await fsp.chmod(abs, parseInt(f.mode, 8)).catch(translate);
    }
  }

  async compress(root: string, files: string[]): Promise<FileEntry> {
    const dir = await this.resolve(root || '/', { allowDenied: true });
    const entries: string[] = [];
    for (const f of files) {
      const abs = await this.resolve(path.posix.join(root || '/', f));
      entries.push(path.relative(dir, abs));
    }
    if (!entries.length) throw new FileError('Select at least one file to compress.');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const target = path.join(dir, `archive-${stamp}.tar.gz`);
    await createTarGz(dir, entries, target);
    const stats = await fsp.lstat(target);
    if (stats.size > (await this.quota.remaining())) {
      await fsp.rm(target, { force: true });
      throw new FileError('Not enough disk space for this archive.', 507);
    }
    this.quota.add(stats.size);
    await this.own(target);
    return toEntry(path.basename(target), stats);
  }

  async decompress(root: string, file: string): Promise<void> {
    const dir = await this.resolve(root || '/', { allowDenied: true });
    const archive = await this.resolve(path.posix.join(root || '/', file));
    await extractArchive(archive, dir, this.quota).catch(translate);
    await this.own(dir, true);
  }

  /**
   * Find files by name and, optionally, by contents (text files under 1 MiB). Walks at most
   * 20,000 entries and stops at `limit` hits so a huge world folder can't stall the node.
   */
  async search(query: string, opts: { directory?: string; content?: boolean; limit?: number } = {}): Promise<{ hits: FileSearchHit[]; truncated: boolean }> {
    const needle = query.toLowerCase();
    const limit = Math.min(opts.limit ?? 200, 500);
    const rootReal = await fsp.realpath(this.root);
    const start = await this.resolve(opts.directory || '/', { allowDenied: true });
    const matcher = new PathMatcher(this.opts.denylist());
    const hits: FileSearchHit[] = [];
    const stack = [start];
    let visited = 0;
    let truncated = false;

    while (stack.length && hits.length < limit) {
      const dir = stack.pop()!;
      const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (++visited > 20_000) {
          truncated = true;
          break;
        }
        const abs = path.join(dir, entry.name);
        const rel = this.relative(abs, rootReal);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          if (entry.name.toLowerCase().includes(needle)) hits.push({ path: `/${rel}/` });
          stack.push(abs);
          continue;
        }
        if (!matcher.empty && matcher.matches(rel)) continue;
        if (entry.name.toLowerCase().includes(needle)) hits.push({ path: `/${rel}` });
        else if (opts.content && /^(txt|log|properties|json|ya?ml|toml|ini|cfg|conf|js|ts|py|sh|md|xml|csv|lang|sk|mcfunction)$/i.test(path.extname(entry.name).slice(1))) {
          const stats = await fsp.stat(abs).catch(() => null);
          if (!stats || stats.size > 1024 * 1024) continue;
          const lines = (await fsp.readFile(abs, 'utf8').catch(() => '')).split('\n');
          const i = lines.findIndex((l) => l.toLowerCase().includes(needle));
          if (i !== -1) hits.push({ path: `/${rel}`, line: i + 1, preview: lines[i]!.trim().slice(0, 200) });
        }
        if (hits.length >= limit) {
          truncated = true;
          break;
        }
      }
      if (visited > 20_000) break;
    }
    return { hits, truncated };
  }
}
