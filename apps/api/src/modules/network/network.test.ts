import { describe, expect, it } from 'vitest';
import { canJoinNetwork, proxyType } from '@glacier/shared';
import { backendConfigs, proxyConfigs, standaloneConfigs } from './config';
import { pngSize, sniffImage } from '../servers/icon';

const backend = (name: string, port: number, extra: { fallback?: boolean; hosts?: string[] } = {}) => ({
  uuid: `uuid-${name}`,
  networkName: name,
  networkFallback: extra.fallback ?? false,
  networkForcedHosts: extra.hosts ?? [],
  allocation: { port },
});

describe('proxy networks', () => {
  it('recognises proxies and which servers can join them', () => {
    expect(proxyType('Velocity')).toBe('velocity');
    expect(proxyType('Waterfall')).toBe('waterfall');
    expect(proxyType('BungeeCord Proxy')).toBe('bungeecord');
    expect(proxyType('Paper')).toBeNull();
    expect(canJoinNetwork('Paper', 'velocity')).toBe(true);
    expect(canJoinNetwork('Spigot', 'velocity')).toBe(false);
    expect(canJoinNetwork('Spigot', 'bungeecord')).toBe(true);
    expect(canJoinNetwork('Velocity', 'velocity')).toBe(false);
    expect(canJoinNetwork('Fabric', 'velocity')).toBe(false);
  });

  it('builds the Velocity server list, join order and forced hosts', () => {
    const [file] = proxyConfigs('velocity', [backend('lobby', 30000, { fallback: true }), backend('survival', 30001, { hosts: ['SMP.example.com'] })]);
    expect(file!.file).toBe('velocity.toml');
    expect(file!.parser).toBe('toml');
    expect(file!.replace).toEqual([
      { match: 'player-info-forwarding-mode', replaceWith: 'modern' },
      { match: 'servers', replaceWith: '', value: { lobby: 'uuid-lobby:30000', survival: 'uuid-survival:30001', try: ['lobby'] } },
      { match: 'forced-hosts', replaceWith: '', value: { 'smp.example.com': ['survival'] } },
    ]);
  });

  it('leaves an empty network alone apart from forwarding', () => {
    expect(proxyConfigs('velocity', [])[0]!.replace).toHaveLength(1);
    expect(proxyConfigs('waterfall', [])[0]!.replace).toEqual([{ match: 'ip_forward', replaceWith: 'true' }]);
  });

  it('falls back to the first server when none is marked, for BungeeCord too', () => {
    const [file] = proxyConfigs('bungeecord', [backend('hub', 30000), backend('games', 30001, { hosts: ['games.example.com'] })]);
    expect(file!.file).toBe('config.yml');
    expect(file!.replace).toContainEqual({ match: 'listeners[0].priorities', replaceWith: '', value: ['hub'] });
    expect(file!.replace).toContainEqual({ match: 'listeners[0].forced_hosts', replaceWith: '', value: { 'games.example.com': 'games' } });
  });

  it('configures backends for the right forwarding, and can undo it', () => {
    const velocity = backendConfigs('velocity', 's3cret');
    const paper = velocity.find((f) => f.file === 'config/paper-global.yml')!;
    expect(paper.replace).toContainEqual({ match: 'proxies.velocity.secret', replaceWith: '', value: 's3cret' });
    expect(velocity.find((f) => f.file === 'spigot.yml')!.replace).toEqual([{ match: 'settings.bungeecord', replaceWith: 'false' }]);
    expect(backendConfigs('bungeecord', null).find((f) => f.file === 'spigot.yml')!.replace).toEqual([{ match: 'settings.bungeecord', replaceWith: 'true' }]);
    expect(standaloneConfigs().find((f) => f.file === 'server.properties')!.replace).toEqual([{ match: 'online-mode', replaceWith: 'true' }]);
  });
});

describe('server logos', () => {
  const png64 = Buffer.from('89504e470d0a1a0a0000000d494844520000004000000040080600000000', 'hex');

  it('recognises images by their bytes', () => {
    expect(sniffImage(png64)).toBe('image/png');
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0]))).toBe('image/jpeg');
    expect(sniffImage(Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'binary'))).toBe('image/webp');
    expect(sniffImage(Buffer.from('GIF89a......'))).toBe('image/gif');
    expect(sniffImage(Buffer.from('<svg onload=alert(1)>'))).toBeNull();
  });

  it('reads PNG dimensions', () => {
    expect(pngSize(png64)).toEqual({ width: 64, height: 64 });
    expect(pngSize(Buffer.from('GIF89a......'))).toBeNull();
  });
});
