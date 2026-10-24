import { describe, expect, it } from 'vitest';
import { detectLoader, minecraftContext } from './context';
import { subdomainRecords } from './manage';

const egg = (name: string, vars: { env: string; def: string }[] = []) => ({
  egg: { name, variables: vars.map((v, i) => ({ id: i + 1, envVariable: v.env, defaultValue: v.def })) },
  variables: [] as { variableId: number; value: string }[],
});

describe('minecraft context', () => {
  it('detects the server software from the egg name', () => {
    expect(detectLoader('Paper')).toBe('paper');
    expect(detectLoader('Purpur')).toBe('purpur');
    expect(detectLoader('Fabric')).toBe('fabric');
    expect(detectLoader('NeoForge 1.21')).toBe('neoforge');
    expect(detectLoader('Forge Enhanced')).toBe('forge');
    expect(detectLoader('Vanilla Minecraft')).toBeNull();
    expect(detectLoader('Node.js App')).toBeNull();
  });

  it('reads the version variable and picks a version source', () => {
    const paper = egg('Paper', [{ env: 'MINECRAFT_VERSION', def: '1.21.4' }]);
    expect(minecraftContext(paper as never)).toEqual({ loader: 'paper', gameVersion: '1.21.4', versionSource: 'paper' });
    const latest = egg('Vanilla Minecraft', [{ env: 'MINECRAFT_VERSION', def: 'latest' }]);
    expect(minecraftContext(latest as never)).toEqual({ loader: null, gameVersion: null, versionSource: 'vanilla' });
    const override = { ...egg('Fabric', [{ env: 'MC_VERSION', def: 'latest' }]), variables: [{ variableId: 1, value: '1.20.1' }] };
    expect(minecraftContext(override as never)).toMatchObject({ loader: 'fabric', gameVersion: '1.20.1', versionSource: 'fabric' });
    expect(minecraftContext(egg('Node.js App') as never).versionSource).toBeNull();
  });
});

describe('subdomain records', () => {
  it('uses CNAME for hostnames and A/AAAA for IPs, plus a Minecraft SRV record', () => {
    const r = subdomainRecords('smp.play.example.com', 'node1.example.com', 25570, true);
    expect(r.main).toMatchObject({ type: 'CNAME', content: 'node1.example.com', proxied: false });
    expect(r.srv).toMatchObject({ name: '_minecraft._tcp.smp.play.example.com', data: { port: 25570, target: 'smp.play.example.com' } });
    expect(subdomainRecords('a.example.com', '203.0.113.5', 25565, false)).toMatchObject({ main: { type: 'A' }, srv: null });
    expect(subdomainRecords('a.example.com', '2001:db8::1', 25565, false).main.type).toBe('AAAA');
  });
});
