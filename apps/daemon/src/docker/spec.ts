import type { ContainerCreateOptions } from 'dockerode';
import type { ServerConfiguration } from '@glacier/shared';
import type { DaemonConfig } from '../config';

const MiB = 1024 * 1024;

/** Headroom on top of the configured memory so the JVM & co. are not OOM-killed at exactly the limit. */
export function memoryOverhead(memoryMiB: number): number {
  if (memoryMiB <= 2048) return 1.15;
  if (memoryMiB <= 4096) return 1.1;
  return 1.05;
}

export function memoryLimits(build: ServerConfiguration['build']) {
  if (build.memoryLimit <= 0) return { Memory: 0, MemoryReservation: 0, MemorySwap: -1 };
  const memory = Math.round(build.memoryLimit * memoryOverhead(build.memoryLimit) * MiB);
  const swap = build.swap < 0 ? -1 : memory + build.swap * MiB;
  return { Memory: memory, MemoryReservation: build.memoryLimit * MiB, MemorySwap: swap };
}

export function containerEnvironment(cfg: ServerConfiguration, config: DaemonConfig): string[] {
  const env: Record<string, string> = {
    ...cfg.environment,
    STARTUP: cfg.invocation,
    SERVER_MEMORY: String(cfg.build.memoryLimit),
    SERVER_IP: cfg.allocations.default.ip,
    SERVER_PORT: String(cfg.allocations.default.port),
    TZ: config.system.timezone,
  };
  return Object.entries(env).map(([k, v]) => `${k}=${v}`);
}

export function portBindings(cfg: ServerConfiguration) {
  const exposed: Record<string, object> = {};
  const bindings: Record<string, { HostIp: string; HostPort: string }[]> = {};
  for (const [ip, ports] of Object.entries(cfg.allocations.mappings)) {
    for (const port of ports) {
      for (const proto of ['tcp', 'udp']) {
        const key = `${port}/${proto}`;
        exposed[key] = {};
        (bindings[key] ??= []).push({ HostIp: ip, HostPort: String(port) });
      }
    }
  }
  return { exposed, bindings };
}

export function serverContainerSpec(cfg: ServerConfiguration, config: DaemonConfig, dataPath: string): ContainerCreateOptions {
  const { exposed, bindings } = portBindings(cfg);
  const { uid, gid } = config.system.user;
  return {
    name: cfg.uuid,
    Hostname: cfg.uuid.slice(0, 12),
    Image: cfg.container.image,
    User: `${uid}:${gid}`,
    Env: containerEnvironment(cfg, config),
    WorkingDir: '/home/container',
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    OpenStdin: true,
    StdinOnce: false,
    Tty: true,
    ExposedPorts: exposed,
    Labels: { 'glacier.server': cfg.uuid, 'glacier.role': 'server' },
    HostConfig: {
      PortBindings: bindings,
      Mounts: [{ Type: 'bind', Source: dataPath, Target: '/home/container', ReadOnly: false }],
      Tmpfs: { '/tmp': `rw,exec,nosuid,size=${config.docker.tmpfsSize}M` },
      ...memoryLimits(cfg.build),
      ...(cfg.build.cpuLimit > 0 ? { CpuQuota: cfg.build.cpuLimit * 1000, CpuPeriod: 100_000 } : {}),
      ...(cfg.build.threads ? { CpusetCpus: cfg.build.threads } : {}),
      BlkioWeight: cfg.build.ioWeight,
      OomKillDisable: !cfg.build.oomKiller,
      PidsLimit: config.docker.pidsLimit,
      NetworkMode: config.docker.network.name,
      Dns: config.docker.dns,
      ReadonlyRootfs: true,
      SecurityOpt: ['no-new-privileges'],
      CapDrop: ['setpcap', 'mknod', 'audit_write', 'net_raw', 'dac_override', 'fowner', 'fsetid', 'net_bind_service', 'sys_chroot', 'setfcap'],
      LogConfig: { Type: 'local', Config: { 'max-size': '5m', 'max-file': '1', compress: 'false' } },
      RestartPolicy: { Name: 'no' },
    },
  };
}

export function installContainerSpec(
  cfg: ServerConfiguration,
  config: DaemonConfig,
  install: { image: string; entrypoint: string },
  dataPath: string,
  scriptDir: string,
): ContainerCreateOptions {
  return {
    name: `${cfg.uuid}_installer`,
    Hostname: 'installer',
    Image: install.image,
    Cmd: [install.entrypoint, '/mnt/install/install.sh'],
    Env: containerEnvironment(cfg, config),
    AttachStdout: true,
    AttachStderr: true,
    Tty: true,
    Labels: { 'glacier.server': cfg.uuid, 'glacier.role': 'installer' },
    HostConfig: {
      Mounts: [
        { Type: 'bind', Source: dataPath, Target: '/mnt/server', ReadOnly: false },
        { Type: 'bind', Source: scriptDir, Target: '/mnt/install', ReadOnly: false },
      ],
      Tmpfs: { '/tmp': `rw,exec,nosuid,size=${config.docker.tmpfsSize}M` },
      Memory: config.docker.installer.memory * MiB,
      MemorySwap: config.docker.installer.memory * MiB,
      ...(config.docker.installer.cpu > 0 ? { CpuQuota: config.docker.installer.cpu * 1000, CpuPeriod: 100_000 } : {}),
      NetworkMode: config.docker.network.name,
      Dns: config.docker.dns,
      LogConfig: { Type: 'local', Config: { 'max-size': '5m', 'max-file': '1', compress: 'false' } },
    },
  };
}

/** Docker stats payload -> CPU percent where 100 = one core, as Wings and `docker stats` report it. */
export function cpuPercent(stats: any): number {
  const cpuDelta = (stats.cpu_stats?.cpu_usage?.total_usage ?? 0) - (stats.precpu_stats?.cpu_usage?.total_usage ?? 0);
  const systemDelta = (stats.cpu_stats?.system_cpu_usage ?? 0) - (stats.precpu_stats?.system_cpu_usage ?? 0);
  const cpus = stats.cpu_stats?.online_cpus ?? stats.cpu_stats?.cpu_usage?.percpu_usage?.length ?? 1;
  if (cpuDelta <= 0 || systemDelta <= 0) return 0;
  return Math.round((cpuDelta / systemDelta) * cpus * 100 * 1000) / 1000;
}

/** Memory in use minus reclaimable page cache, matching `docker stats`. */
export function memoryUsage(stats: any): number {
  const usage = stats.memory_stats?.usage ?? 0;
  const cache = stats.memory_stats?.stats?.inactive_file ?? stats.memory_stats?.stats?.total_inactive_file ?? 0;
  return Math.max(0, usage - cache);
}

export function networkTotals(stats: any): { rx: number; tx: number } {
  let rx = 0;
  let tx = 0;
  for (const iface of Object.values<any>(stats.networks ?? {})) {
    rx += iface.rx_bytes ?? 0;
    tx += iface.tx_bytes ?? 0;
  }
  return { rx, tx };
}
