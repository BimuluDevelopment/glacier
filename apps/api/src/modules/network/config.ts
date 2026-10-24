import type { Allocation, Server } from '@prisma/client';
import type { ConfigFile, ProxyType } from '@glacier/shared';

/**
 * Config files for proxy networks. They ride along with the egg's own replacements, so the daemon
 * rewrites them before every start (and right away when the network changes).
 */

type Backend = Pick<Server, 'uuid' | 'networkName' | 'networkFallback' | 'networkForcedHosts'> & { allocation: Pick<Allocation, 'port'> };

/**
 * Containers are named after the server uuid on the node's Docker network, so the proxy reaches a
 * backend by name. Backends only publish their port on the host's loopback.
 */
export function backendAddress(b: Backend) {
  return `${b.uuid}:${b.allocation.port}`;
}

/** The proxy's server list, join order and forced hosts. Left alone while the network is empty. */
export function proxyConfigs(type: ProxyType, backends: Backend[]): ConfigFile[] {
  const members = backends.filter((b) => b.networkName);
  const fallbacks = members.filter((b) => b.networkFallback).map((b) => b.networkName!);
  const order = fallbacks.length ? fallbacks : members.slice(0, 1).map((b) => b.networkName!);

  if (type === 'velocity') {
    const replace: ConfigFile['replace'] = [{ match: 'player-info-forwarding-mode', replaceWith: 'modern' }];
    if (members.length) {
      const servers = Object.fromEntries(members.map((b) => [b.networkName!, backendAddress(b)]));
      const forced: Record<string, string[]> = {};
      for (const b of members) for (const host of b.networkForcedHosts) (forced[host.toLowerCase()] ??= []).push(b.networkName!);
      replace.push({ match: 'servers', replaceWith: '', value: { ...servers, try: order } }, { match: 'forced-hosts', replaceWith: '', value: forced });
    }
    return [{ file: 'velocity.toml', parser: 'toml', replace }];
  }

  // BungeeCord and Waterfall.
  const replace: ConfigFile['replace'] = [{ match: 'ip_forward', replaceWith: 'true' }];
  if (members.length) {
    const servers = Object.fromEntries(members.map((b) => [b.networkName!, { address: backendAddress(b), motd: `&7${b.networkName}`, restricted: false }]));
    const forced: Record<string, string> = {};
    for (const b of members) for (const host of b.networkForcedHosts) forced[host.toLowerCase()] = b.networkName!;
    replace.push(
      { match: 'servers', replaceWith: '', value: servers },
      { match: 'listeners[0].priorities', replaceWith: '', value: order },
      { match: 'listeners[0].forced_hosts', replaceWith: '', value: forced },
    );
  }
  return [{ file: 'config.yml', parser: 'yaml', replace }];
}

/** What a Paper/Spigot backend needs to accept players from its proxy. */
export function backendConfigs(type: ProxyType, secret: string | null): ConfigFile[] {
  const velocity = type === 'velocity';
  return [
    // The proxy authenticates players; the backend trusts its forwarding instead.
    { file: 'server.properties', parser: 'properties', replace: [{ match: 'online-mode', replaceWith: 'false' }] },
    { file: 'spigot.yml', parser: 'yaml', replace: [{ match: 'settings.bungeecord', replaceWith: String(!velocity) }] },
    {
      file: 'config/paper-global.yml',
      parser: 'yaml',
      replace: velocity
        ? [
            { match: 'proxies.velocity.enabled', replaceWith: 'true' },
            { match: 'proxies.velocity.online-mode', replaceWith: 'true' },
            // A structured value so a secret that happens to look like a number stays a string.
            { match: 'proxies.velocity.secret', replaceWith: '', value: secret ?? '' },
          ]
        : [{ match: 'proxies.velocity.enabled', replaceWith: 'false' }],
    },
  ];
}

/** Undo `backendConfigs` when a server leaves a network, so it accepts players directly again. */
export function standaloneConfigs(): ConfigFile[] {
  return [
    { file: 'server.properties', parser: 'properties', replace: [{ match: 'online-mode', replaceWith: 'true' }] },
    { file: 'spigot.yml', parser: 'yaml', replace: [{ match: 'settings.bungeecord', replaceWith: 'false' }] },
    { file: 'config/paper-global.yml', parser: 'yaml', replace: [{ match: 'proxies.velocity.enabled', replaceWith: 'false' }] },
  ];
}

/** Console command that makes a running proxy re-read its server list. */
export function reloadCommand(type: ProxyType) {
  return type === 'velocity' ? 'velocity reload' : 'greload';
}
