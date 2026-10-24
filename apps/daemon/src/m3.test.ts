import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { crc32 } from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import ssh2 from 'ssh2';
import { createTarGz, extractArchive } from './fs/archive';
import { FileError, ServerFilesystem, type Quota } from './fs/files';
import { parseConfig } from './config';
import { startSftpServer } from './sftp/server';

let root: string;
let scratch: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'glacier-fs-'));
  scratch = await mkdtemp(path.join(os.tmpdir(), 'glacier-scratch-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(scratch, { recursive: true, force: true });
});

function quota(limit = Infinity): Quota & { used: number } {
  const q = {
    used: 0,
    remaining: async () => limit - q.used,
    add: (n: number) => {
      q.used += n;
    },
  };
  return q;
}

const fsFor = (denylist: string[] = [], q: Quota = quota()) => new ServerFilesystem(root, { uid: 988, gid: 988, denylist: () => denylist, quota: q });

describe('ServerFilesystem', () => {
  it('writes, lists, reads, renames, copies and deletes', async () => {
    const fs = fsFor();
    await fs.write('/config/server.properties', Buffer.from('motd=hi\n'));
    expect((await fs.readText('config/server.properties')).toString()).toBe('motd=hi\n');

    const listing = await fs.list('/config');
    expect(listing).toHaveLength(1);
    expect(listing[0]).toMatchObject({ name: 'server.properties', isFile: true, editable: true, mimetype: 'text/x-java-properties' });

    await fs.rename('/config', [{ from: 'server.properties', to: '../moved.properties' }]);
    expect((await fs.list('/')).map((e) => e.name).sort()).toEqual(['config', 'moved.properties']);

    expect(await fs.copy('/moved.properties')).toBe('moved copy.properties');
    expect(await fs.copy('/moved.properties')).toBe('moved copy 2.properties');

    await fs.delete('/', ['config', 'moved copy.properties']);
    expect((await fs.list('/')).map((e) => e.name).sort()).toEqual(['moved copy 2.properties', 'moved.properties']);
  });

  it('refuses to escape the server directory or delete its root', async () => {
    const fs = fsFor();
    await expect(fs.write('../../evil.txt', Buffer.from('x'))).rejects.toMatchObject({ statusCode: 403 });
    await expect(fs.list('/../..')).rejects.toBeInstanceOf(FileError);
    await expect(fs.delete('/', ['.'])).rejects.toMatchObject({ statusCode: 403 });
  });

  it('enforces the egg denylist but still lists protected files', async () => {
    await writeFile(path.join(root, 'server.jar'), 'jar');
    const fs = fsFor(['server.jar']);
    expect((await fs.list('/')).map((e) => e.name)).toContain('server.jar');
    await expect(fs.readText('/server.jar')).rejects.toMatchObject({ statusCode: 403 });
    await expect(fs.delete('/', ['server.jar'])).rejects.toMatchObject({ statusCode: 403 });
    await expect(fs.rename('/', [{ from: 'server.jar', to: 'x.jar' }])).rejects.toMatchObject({ statusCode: 403 });
  });

  it('enforces the disk limit while streaming and cleans up the partial file', async () => {
    const q = quota(10);
    const fs = fsFor([], q);
    await fs.write('/small.txt', Buffer.from('12345'));
    expect(q.used).toBe(5);
    await expect(fs.write('/big.txt', Buffer.alloc(100))).rejects.toMatchObject({ statusCode: 507 });
    expect((await fs.list('/')).map((e) => e.name)).toEqual(['small.txt']);
    // Overwriting gives the old size back first.
    await fs.write('/small.txt', Buffer.from('1234567890'));
    expect(q.used).toBe(10);
    await fs.delete('/', ['small.txt']);
    expect(q.used).toBe(0);
  });

  it('compresses and extracts tar.gz archives', async () => {
    const fs = fsFor();
    await fs.write('/world/level.dat', Buffer.from('level'));
    await fs.write('/world/region/r.0.0.mca', Buffer.from('region'));
    const archive = await fs.compress('/', ['world']);
    expect(archive.name).toMatch(/^archive-.*\.tar\.gz$/);
    await fs.delete('/', ['world']);
    await fs.decompress('/', archive.name);
    expect(await readFile(path.join(root, 'world/region/r.0.0.mca'), 'utf8')).toBe('region');
  });
});

/** Build a minimal stored (uncompressed) zip so the zip-slip test needs no zip library. */
function makeZip(entries: { name: string; data: string }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name);
    const data = Buffer.from(e.data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

describe('archives', () => {
  it('extracts zips and skips entries that try to escape (zip-slip)', async () => {
    const zip = path.join(root, 'mods.zip');
    await writeFile(zip, makeZip([{ name: 'mods/a.jar', data: 'A' }, { name: '../../escaped.txt', data: 'pwned' }, { name: 'config/', data: '' }]));
    const q = quota();
    await extractArchive(zip, root, q);
    expect(await readFile(path.join(root, 'mods/a.jar'), 'utf8')).toBe('A');
    expect(await readdir(path.dirname(root))).not.toContain('escaped.txt');
    expect(q.used).toBe(1);
  });

  it('stops zip extraction at the disk limit', async () => {
    const zip = path.join(root, 'big.zip');
    await writeFile(zip, makeZip([{ name: 'big.bin', data: 'x'.repeat(100) }]));
    await expect(extractArchive(zip, root, quota(10))).rejects.toMatchObject({ statusCode: 507 });
  });

  it('backs up with ignore rules', async () => {
    await mkdir(path.join(root, 'logs'));
    await writeFile(path.join(root, 'logs/latest.log'), 'log');
    await writeFile(path.join(root, 'server.properties'), 'motd=hi');
    const target = path.join(scratch, 'backup.tar.gz');
    await createTarGz(root, ['.'], target, ['logs/']);
    const out = await mkdtemp(path.join(os.tmpdir(), 'glacier-restore-'));
    try {
      await extractArchive(target, out, quota());
      expect(await readdir(out)).toEqual(['server.properties']);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });
});

describe('SFTP', () => {
  it('authenticates through the panel and enforces permissions', async () => {
    const config = parseConfig({
      uuid: '00000000-0000-4000-8000-000000000000',
      token: 'x'.repeat(48),
      panel: { url: 'http://localhost:1' },
      api: { host: '127.0.0.1' },
      sftp: { port: 0, hostKey: path.join(scratch, 'host_key') },
    });
    const fs = fsFor();
    await fs.write('/hello.txt', Buffer.from('hello'));
    const fakeServer = { uuid: 'srv', fs };
    const manager = { find: (uuid: string) => (uuid === 'srv' ? fakeServer : undefined) };
    const panel = {
      // Read + create only: no delete.
      sftpAuth: async ({ username, password }: { username: string; password: string }) => {
        if (username !== 'alice.abcd1234' || password !== 'pw') throw Object.assign(new Error('nope'), { status: 403 });
        return { server: 'srv', user: 'u1', permissions: ['file.read', 'file.create'] };
      },
    };
    const silent = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    const server = startSftpServer(config, manager as never, panel as never, silent as never);
    await new Promise((r) => server.once('listening', r));
    const port = (server.address() as { port: number }).port;

    const connect = (password: string) =>
      new Promise<ssh2.Client>((resolve, reject) => {
        const client = new ssh2.Client();
        client.on('ready', () => resolve(client)).on('error', reject);
        client.connect({ host: '127.0.0.1', port, username: 'alice.abcd1234', password });
      });

    try {
      await expect(connect('wrong')).rejects.toThrow(/authentication/i);

      const client = await connect('pw');
      const sftp = await new Promise<ssh2.SFTPWrapper>((res, rej) => client.sftp((err, s) => (err ? rej(err) : res(s))));
      const list = await new Promise<ssh2.FileEntryWithStats[]>((res, rej) => sftp.readdir('/', (err, l) => (err ? rej(err) : res(l))));
      expect(list.map((e) => e.filename)).toContain('hello.txt');

      const content = await new Promise<Buffer>((res, rej) => sftp.readFile('/hello.txt', (err, b) => (err ? rej(err) : res(b))));
      expect(content.toString()).toBe('hello');

      await new Promise<void>((res, rej) => sftp.writeFile('/new.txt', 'from sftp', (err) => (err ? rej(err) : res())));
      expect(await readFile(path.join(root, 'new.txt'), 'utf8')).toBe('from sftp');

      // No file.delete permission.
      await expect(new Promise<void>((res, rej) => sftp.unlink('/hello.txt', (err) => (err ? rej(err) : res())))).rejects.toThrow();
      // No escaping the server directory.
      await expect(new Promise<void>((res, rej) => sftp.readFile('/../../etc/passwd', (err) => (err ? rej(err) : res())))).rejects.toThrow();
      client.end();
    } finally {
      server.close();
    }
  }, 20_000);
});
