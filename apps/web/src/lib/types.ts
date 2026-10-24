export type ServerStatus = 'INSTALLING' | 'INSTALL_FAILED' | 'REINSTALL_FAILED' | 'ACTIVE' | 'SUSPENDED';

export interface ClientServerSummary {
  id: string;
  uuid: string;
  name: string;
  description: string | null;
  status: ServerStatus;
  iconVersion: number;
  isOwner: boolean;
  node: string;
  egg: string;
  address: { ip: string; port: number };
  /** Set for servers behind a proxy: players join through the proxy, not the address. */
  network: { proxyName: string; name: string | null } | null;
  limits: { memory: number; disk: number; cpu: number };
}

export interface ClientServer {
  id: string;
  uuid: string;
  name: string;
  description: string | null;
  status: ServerStatus;
  iconVersion: number;
  /** The proxy network this server belongs to. */
  network: { proxyId: string; proxyName: string; name: string | null } | null;
  isOwner: boolean;
  permissions: string[];
  node: { name: string; fqdn: string; sftpPort: number };
  sftp: { host: string; port: number; username: string };
  egg: { name: string; features: string[]; dockerImages: Record<string, string> };
  image: string;
  invocation: string;
  limits: { memory: number; swap: number; disk: number; io: number; cpu: number; threads: string | null };
  featureLimits: { databases: number; allocations: number; backups: number };
  allocations: { id: number; ip: string; alias: string | null; port: number; notes: string | null; primary: boolean }[];
}

export interface ActivityEntry {
  id: string;
  event: string;
  ip: string | null;
  properties: Record<string, unknown>;
  createdAt: string;
  actor?: { username: string } | null;
  server?: { name: string; shortId: string } | null;
}
