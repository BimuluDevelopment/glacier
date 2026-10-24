import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ServerConfiguration } from '@glacier/shared';
import { parseConfig } from './config';
import { resolveSafe, SandboxError } from './fs/sandbox';
import { applyFile, applyIni, applyJson, applyProperties, applyYaml, coerceScalar, parsePath } from './server/config-files';
import { cpuPercent, memoryLimits, memoryUsage, serverContainerSpec } from './docker/spec';

const daemonConfig = parseConfig({
  uuid: '00000000-0000-4000-8000-000000000000',
  token: 'x'.repeat(48),
  panel: { url: 'https://panel.example.com' },
});

describe('config', () => {
  it('fills nested defaults', () => {
    expect(daemonConfig.api.port).toBe(8080);
    expect(daemonConfig.docker.network.name).toBe('glacier0');
    expect(daemonConfig.system.user).toEqual({ uid: 988, gid: 988 });
  });
});

describe('resolveSafe', () => {
  let root: string;
  let outside: string;

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'glacier-root-'));
    outside = await mkdtemp(path.join(os.tmpdir(), 'glacier-out-'));
    await mkdir(path.join(root, 'plugins'));
    try {
      await symlink(outside, path.join(root, 'escape'), 'junction');
    } catch {
      // Symlinks may be unavailable (e.g. Windows without developer mode); that test is skipped below.
    }
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it('allows paths inside the root', async () => {
    expect(await resolveSafe(root, '/plugins/a.jar')).toBe(path.join(await realRoot(root), 'plugins', 'a.jar'));
    expect(await resolveSafe(root, 'new/dir/file.txt')).toContain('file.txt');
  });

  it('blocks traversal', async () => {
    await expect(resolveSafe(root, '../../etc/passwd')).rejects.toBeInstanceOf(SandboxError);
    await expect(resolveSafe(root, '/plugins/../../x')).rejects.toBeInstanceOf(SandboxError);
  });

  it('blocks symlinks that point outside', async (ctx) => {
    const { existsSync } = await import('node:fs');
    if (!existsSync(path.join(root, 'escape'))) return ctx.skip();
    await expect(resolveSafe(root, 'escape/secret.txt')).rejects.toBeInstanceOf(SandboxError);
  });
});

async function realRoot(p: string) {
  const { realpath } = await import('node:fs/promises');
  return realpath(p);
}

describe('config file parsers', () => {
  it('properties: replaces keys and appends missing ones', () => {
    const out = applyProperties('#comment\nserver-port=1\nmotd=hi\n', [
      { match: 'server-port', replaceWith: '25565' },
      { match: 'server-ip', replaceWith: '0.0.0.0' },
    ]);
    expect(out).toBe('#comment\nserver-port=25565\nmotd=hi\nserver-ip=0.0.0.0\n');
    expect(applyProperties('', [{ match: 'eula', replaceWith: 'true' }])).toBe('eula=true\n');
  });

  it('ini: handles sections', () => {
    const out = applyIni('top=1\n[Server]\nPort=1\n[Other]\nx=y\n', [
      { match: 'Server.Port', replaceWith: '7777' },
      { match: 'Server.Name', replaceWith: 'Glacier Panel' },
      { match: 'New.key', replaceWith: 'v' },
      { match: 'top', replaceWith: '2' },
    ]);
    expect(out).toBe('top=2\n[Server]\nPort=7777\nName=Glacier Panel\n[Other]\nx=y\n[New]\nkey=v\n');
  });

  it('json: sets nested paths with typed values and wildcards', () => {
    const out = JSON.parse(
      applyJson('{"listeners":[{"host":"a"},{"host":"b"}],"query":{"enabled":false}}', [
        { match: 'listeners[*].host', replaceWith: '0.0.0.0:25577' },
        { match: 'query.enabled', replaceWith: 'true' },
        { match: 'new.port', replaceWith: '25565' },
      ]),
    );
    expect(out).toEqual({
      listeners: [{ host: '0.0.0.0:25577' }, { host: '0.0.0.0:25577' }],
      query: { enabled: true },
      new: { port: 25565 },
    });
  });

  it('yaml: preserves comments', () => {
    const out = applyYaml('# keep me\nlisteners:\n  - host: 0.0.0.0:1\n', [{ match: 'listeners[0].host', replaceWith: '0.0.0.0:25577' }]);
    expect(out).toContain('# keep me');
    expect(out).toContain('host: 0.0.0.0:25577');
  });

  it('file: replaces lines by prefix only', () => {
    expect(applyFile('port 1\nname x', [{ match: 'port ', replaceWith: 'port 9' }])).toBe('port 9\nname x');
  });

  it('helpers', () => {
    expect(parsePath('a.b[0].c')).toEqual(['a', 'b', 0, 'c']);
    expect(parsePath('servers.*.address')).toEqual(['servers', '*', 'address']);
    expect(coerceScalar('25565')).toBe(25565);
    expect(coerceScalar('007')).toBe('007');
    expect(coerceScalar('false')).toBe(false);
  });
});

describe('container spec', () => {
  const cfg: ServerConfiguration = {
    uuid: '11111111-1111-4111-8111-111111111111',
    suspended: false,
    invocation: 'java -jar {{SERVER_JARFILE}}',
    environment: { SERVER_JARFILE: 'server.jar' },
    allocations: { default: { ip: '0.0.0.0', port: 25565 }, mappings: { '0.0.0.0': [25565, 25566] } },
    build: { memoryLimit: 2048, swap: 0, ioWeight: 500, cpuLimit: 200, threads: null, diskSpace: 10240, oomKiller: true },
    container: { image: 'ghcr.io/pterodactyl/yolks:java_21' },
    egg: { uuid: 'e', fileDenylist: [] },
    process: { startup: { done: [], stripAnsi: false }, stop: { type: 'command', value: 'stop' }, configs: [] },
  };

  it('maps limits, ports and environment', () => {
    const spec = serverContainerSpec(cfg, daemonConfig, '/data/x');
    expect(spec.HostConfig?.PortBindings?.['25566/udp']).toEqual([{ HostIp: '0.0.0.0', HostPort: '25566' }]);
    expect(spec.HostConfig?.CpuQuota).toBe(200_000);
    expect(spec.Env).toContain('STARTUP=java -jar {{SERVER_JARFILE}}');
    expect(spec.Env).toContain('SERVER_PORT=25565');
    expect(spec.User).toBe('988:988');
  });

  it('computes memory with overhead and swap modes', () => {
    const base = cfg.build;
    expect(memoryLimits(base).Memory).toBe(Math.round(2048 * 1.15 * 1024 * 1024));
    expect(memoryLimits(base).MemorySwap).toBe(memoryLimits(base).Memory);
    expect(memoryLimits({ ...base, swap: -1 }).MemorySwap).toBe(-1);
    expect(memoryLimits({ ...base, memoryLimit: 0 }).Memory).toBe(0);
  });

  it('reads docker stats like `docker stats`', () => {
    const stats = {
      cpu_stats: { cpu_usage: { total_usage: 2_000 }, system_cpu_usage: 20_000, online_cpus: 4 },
      precpu_stats: { cpu_usage: { total_usage: 1_000 }, system_cpu_usage: 10_000 },
      memory_stats: { usage: 1000, stats: { inactive_file: 200 } },
    };
    expect(cpuPercent(stats)).toBe(40);
    expect(memoryUsage(stats)).toBe(800);
  });
});
