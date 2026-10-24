import { createServer, type Server } from 'node:net';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { __test, chatToText, pingMinecraft } from './lib/slp';
import { pullFile } from './fs/remote';
import { ServerFilesystem } from './fs/files';

const { varInt, readVarInt, packet, mcString } = __test;

describe('Server List Ping', () => {
  let fake: Server;
  let port: number;

  beforeEach(async () => {
    // A tiny fake Minecraft server that answers the status request.
    fake = createServer((sock) => {
      sock.once('data', () => {
        const json = JSON.stringify({
          version: { name: 'Paper 1.21.4', protocol: 769 },
          players: { max: 20, online: 2, sample: [{ name: 'Alex', id: 'a' }, { name: 'Steve', id: 'b' }] },
          description: { text: '§aWelcome ', extra: [{ text: 'home' }] },
        });
        sock.write(packet(0x00, mcString(json)));
      });
    });
    await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
    port = (fake.address() as { port: number }).port;
  });
  afterEach(() => fake.close());

  it('encodes and decodes VarInts', () => {
    for (const n of [0, 1, 127, 128, 255, 25565, 2097151, -1]) {
      expect(readVarInt(varInt(n), 0)!.value).toBe(n);
    }
  });

  it('reads status from a server', async () => {
    const s = await pingMinecraft('127.0.0.1', port);
    expect(s).toMatchObject({ online: true, version: 'Paper 1.21.4', motd: 'Welcome home', players: { online: 2, max: 20 } });
    expect(s.players!.sample.map((p) => p.name)).toEqual(['Alex', 'Steve']);
  });

  it('reports offline when nothing listens', async () => {
    fake.close();
    expect((await pingMinecraft('127.0.0.1', port, 1000)).online).toBe(false);
  });

  it('flattens chat components', () => {
    expect(chatToText({ text: 'a', extra: ['§cb', { text: 'c' }] })).toBe('abc');
  });
});

describe('downloads and search', () => {
  let root: string;
  let fs: ServerFilesystem;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'glacier-m6-'));
    fs = new ServerFilesystem(root, { uid: 988, gid: 988, denylist: () => ['secret.txt'], quota: { remaining: async () => Infinity, add: () => undefined } });
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  it('refuses http, unlisted hosts and odd file names before downloading anything', async () => {
    const allowed = ['cdn.modrinth.com', '*.forgecdn.net'];
    await expect(pullFile(fs, { url: 'http://cdn.modrinth.com/a.jar', directory: '/plugins', filename: 'a.jar' }, allowed)).rejects.toMatchObject({ statusCode: 403 });
    await expect(pullFile(fs, { url: 'https://evil.example/a.jar', directory: '/plugins', filename: 'a.jar' }, allowed)).rejects.toMatchObject({ statusCode: 403 });
    await expect(pullFile(fs, { url: 'https://169.254.169.254/latest', directory: '/plugins', filename: 'a.jar' }, allowed)).rejects.toMatchObject({ statusCode: 403 });
    await expect(pullFile(fs, { url: 'https://cdn.modrinth.com/a.jar', directory: '/plugins', filename: '../a.jar' }, allowed)).rejects.toThrow(/Invalid file name/);
  });

  it('finds files by name and content, skipping the denylist', async () => {
    await mkdir(path.join(root, 'plugins/LuckPerms'), { recursive: true });
    await writeFile(path.join(root, 'plugins/LuckPerms/config.yml'), 'storage-method: h2\nserver: survival\n');
    await writeFile(path.join(root, 'server.properties'), 'motd=Survival server\n');
    await writeFile(path.join(root, 'secret.txt'), 'survival password');
    const byName = await fs.search('luckperms');
    expect(byName.hits.map((h) => h.path)).toEqual(['/plugins/LuckPerms/']);
    const byContent = await fs.search('survival', { content: true });
    expect(byContent.hits).toEqual(
      expect.arrayContaining([
        { path: '/plugins/LuckPerms/config.yml', line: 2, preview: 'server: survival' },
        { path: '/server.properties', line: 1, preview: 'motd=Survival server' },
      ]),
    );
    expect(byContent.hits.some((h) => h.path === '/secret.txt')).toBe(false);
    expect((await fs.search('config')).hits.map((h) => h.path)).toEqual(['/plugins/LuckPerms/config.yml']);
  });
});
