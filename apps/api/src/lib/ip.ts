import { BlockList, isIPv4, isIPv6 } from 'node:net';

/** "::ffff:203.0.113.5" (IPv4 seen through an IPv6 socket) -> "203.0.113.5". */
export function normalizeIp(ip: string) {
  return ip.startsWith('::ffff:') && isIPv4(ip.slice(7)) ? ip.slice(7) : ip;
}

/** Whether `ip` is in any of the IPs / CIDR ranges. Malformed entries are ignored. */
export function ipMatches(ip: string, list: readonly string[]): boolean {
  const addr = normalizeIp(ip);
  const family = isIPv4(addr) ? 'ipv4' : isIPv6(addr) ? 'ipv6' : null;
  if (!family) return false;
  const block = new BlockList();
  for (const entry of list) {
    const [net, prefix] = entry.trim().split('/');
    if (!net) continue;
    const fam = isIPv4(net) ? 'ipv4' : isIPv6(net) ? 'ipv6' : null;
    if (!fam) continue;
    try {
      if (prefix === undefined) block.addAddress(net, fam);
      else block.addSubnet(net, Number(prefix), fam);
    } catch {
      // Out-of-range prefix etc.
    }
  }
  return block.check(addr, family);
}
