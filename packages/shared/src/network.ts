/**
 * Proxy networks: a Velocity, BungeeCord or Waterfall server plus the backend servers it links,
 * all on the same node. Backends get a loopback-only port and the proxy reaches them over the
 * node's Docker network, so players can only get in through the proxy.
 */

export const PROXY_TYPES = ['velocity', 'bungeecord', 'waterfall'] as const;
export type ProxyType = (typeof PROXY_TYPES)[number];

export const PROXY_LABELS: Record<ProxyType, string> = { velocity: 'Velocity', bungeecord: 'BungeeCord', waterfall: 'Waterfall' };

/** Which proxy software an egg runs, judged by its name (works for our eggs and Pterodactyl's). */
export function proxyType(eggName: string): ProxyType | null {
  const n = eggName.toLowerCase();
  if (n.includes('velocity')) return 'velocity';
  if (n.includes('waterfall')) return 'waterfall';
  if (n.includes('bungee')) return 'bungeecord';
  return null;
}

/**
 * Whether servers of this egg can sit behind a proxy. Velocity's secure "modern" forwarding needs
 * Paper or a fork; BungeeCord-style forwarding also works on plain Spigot.
 */
export function canJoinNetwork(eggName: string, proxy: ProxyType): boolean {
  if (proxyType(eggName)) return false;
  const n = eggName.toLowerCase();
  if (/paper|purpur|folia|pufferfish/.test(n)) return true;
  return proxy !== 'velocity' && /spigot|bukkit/.test(n);
}

/** Name of a server in the proxy's server list: what players type in `/server <name>`. */
export const NETWORK_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export interface NetworkServer {
  id: string;
  uuid: string;
  name: string;
  networkName: string;
  /** Players join this server first and fall back to it when kicked (Velocity "try", Bungee "priorities"). */
  fallback: boolean;
  /** Hostnames that send players straight to this server. */
  forcedHosts: string[];
  egg: string;
  status: string;
  state: 'offline' | 'starting' | 'running' | 'stopping' | 'unknown';
  memory: number;
  disk: number;
  cpu: number;
  hasIcon: boolean;
  iconVersion: number;
  /** Created from the proxy page, so its owner may delete it there. */
  managed: boolean;
}

export interface NetworkLimits {
  servers: number;
  memory: number;
  disk: number;
  cpu: number;
}

export interface NetworkInfo {
  proxy: {
    type: ProxyType;
    /** "modern" is Velocity's signed forwarding; "legacy" is BungeeCord's IP forwarding. */
    forwarding: 'modern' | 'legacy';
    address: string;
    state: NetworkServer['state'];
  };
  servers: NetworkServer[];
  /** Admins can add servers limited only by the node; others use the proxy's network limits. */
  unlimited: boolean;
  limits: NetworkLimits;
  used: NetworkLimits;
  /** Server types that can be added. */
  eggs: { id: number; name: string }[];
  /** The user's other servers on this node that could be linked into the network. */
  attachable: { id: string; name: string; egg: string }[];
}
