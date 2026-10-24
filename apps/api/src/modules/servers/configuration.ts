import type { Allocation, Egg, EggVariable, Location, Node, Prisma, Server, ServerVariable } from '@prisma/client';
import { proxyType, type ConfigFile, type InstallationScript, type ServerConfiguration } from '@glacier/shared';
import { buildConfigFiles, type EggConfigFile } from '@glacier/eggs';
import { prisma } from '../../db';
import { notFound } from '../../lib/errors';
import { backendConfigs, proxyConfigs } from '../network/config';

export const configurationInclude = {
  allocation: true,
  allocations: true,
  egg: { include: { variables: true } },
  variables: true,
  node: { include: { location: true } },
  backends: { include: { allocation: true }, orderBy: [{ networkOrder: 'asc' }, { id: 'asc' }] },
  proxy: { select: { forwardingSecret: true, egg: { select: { name: true } } } },
} satisfies Prisma.ServerInclude;

type FullServer = Server & {
  allocation: Allocation;
  allocations: Allocation[];
  egg: Egg & { variables: EggVariable[] };
  variables: ServerVariable[];
  node: Node & { location: Location };
  backends: (Server & { allocation: Allocation })[];
  proxy: { forwardingSecret: string | null; egg: { name: string } } | null;
};

/** Extra config files and environment for proxies and their backends. */
function networkSetup(server: FullServer): { configs: ConfigFile[]; environment: Record<string, string> } {
  const type = proxyType(server.egg.name);
  if (type) {
    return {
      configs: proxyConfigs(type, server.backends),
      // Velocity reads its forwarding secret from here before falling back to forwarding.secret.
      environment: type === 'velocity' && server.forwardingSecret ? { VELOCITY_FORWARDING_SECRET: server.forwardingSecret } : {},
    };
  }
  const proxy = server.proxy && proxyType(server.proxy.egg.name);
  if (proxy) return { configs: backendConfigs(proxy, server.proxy!.forwardingSecret), environment: {} };
  return { configs: [], environment: {} };
}

/** Egg variable values for a server: its own value, or the egg default. */
export function serverEnvironment(server: FullServer): Record<string, string> {
  const values = new Map(server.variables.map((v) => [v.variableId, v.value]));
  return Object.fromEntries(server.egg.variables.map((v) => [v.envVariable, values.get(v.id) ?? v.defaultValue]));
}

export function buildConfiguration(server: FullServer): ServerConfiguration {
  const eggEnv = serverEnvironment(server);
  const primary = server.allocation;

  const mappings: Record<string, number[]> = {};
  for (const a of [primary, ...server.allocations.filter((a) => a.id !== primary.id)]) {
    (mappings[a.ip] ??= []).push(a.port);
  }

  const environment: Record<string, string> = {
    ...eggEnv,
    SERVER_MEMORY: String(server.memory),
    SERVER_IP: primary.ip,
    SERVER_PORT: String(primary.port),
    P_SERVER_LOCATION: server.node.location.short,
    P_SERVER_UUID: server.uuid,
    P_SERVER_ALLOCATION_LIMIT: String(server.allocationLimit),
  };
  const network = networkSetup(server);

  const stop = server.egg.stopCommand;
  const signal = { '^C': 'SIGINT', '^\\': 'SIGQUIT', '^Z': 'SIGTSTP' }[stop];

  return {
    uuid: server.uuid,
    suspended: server.status === 'SUSPENDED',
    invocation: server.startup,
    environment: { ...environment, ...network.environment },
    allocations: { default: { ip: primary.ip, port: primary.port }, mappings },
    build: {
      memoryLimit: server.memory,
      swap: server.swap,
      ioWeight: server.io,
      cpuLimit: server.cpu,
      threads: server.threads,
      diskSpace: server.disk,
      oomKiller: server.oomKiller,
    },
    container: { image: server.image },
    egg: { uuid: server.egg.uuid, fileDenylist: server.egg.fileDenylist },
    process: {
      startup: { done: server.egg.startupDone.filter(Boolean), stripAnsi: false },
      stop: signal ? { type: 'signal', value: signal } : { type: 'command', value: stop },
      configs: [
        ...buildConfigFiles(server.egg.configFiles as unknown as Record<string, EggConfigFile>, {
          ip: primary.ip,
          port: primary.port,
          memory: server.memory,
          env: environment,
        }),
        ...network.configs,
      ],
    },
  };
}

export async function loadConfiguration(where: { uuid: string; nodeId: number }): Promise<ServerConfiguration> {
  const server = await prisma.server.findFirst({ where, include: configurationInclude });
  if (!server) throw notFound('Server');
  return buildConfiguration(server);
}

export function installationScript(egg: Egg): InstallationScript {
  return { containerImage: egg.installContainer, entrypoint: egg.installEntrypoint, script: egg.installScript };
}
