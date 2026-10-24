export const MAX_PORTS_PER_REQUEST = 1000;

/** Parse "25565, 25570-25580" into a sorted, de-duplicated list of ports. Throws on bad input. */
export function parsePortList(input: string): number[] {
  const ports = new Set<number>();
  for (const raw of input.split(',')) {
    const part = raw.trim();
    if (!part) continue;
    const range = /^(\d+)\s*-\s*(\d+)$/.exec(part);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (start > end) throw new Error(`Invalid range "${part}": start is after end`);
      assertPort(start, part);
      assertPort(end, part);
      if (end - start + 1 > MAX_PORTS_PER_REQUEST) throw new Error(`Range "${part}" is larger than ${MAX_PORTS_PER_REQUEST} ports`);
      for (let p = start; p <= end; p++) ports.add(p);
    } else if (/^\d+$/.test(part)) {
      const port = Number(part);
      assertPort(port, part);
      ports.add(port);
    } else {
      throw new Error(`"${part}" is not a port or port range`);
    }
    if (ports.size > MAX_PORTS_PER_REQUEST) throw new Error(`More than ${MAX_PORTS_PER_REQUEST} ports requested`);
  }
  if (ports.size === 0) throw new Error('No ports given');
  return [...ports].sort((a, b) => a - b);
}

function assertPort(port: number, source: string) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(`Port in "${source}" must be between 1024 and 65535`);
  }
}
