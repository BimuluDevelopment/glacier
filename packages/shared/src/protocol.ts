/**
 * Contract between the panel API and glacierd (the node daemon).
 *
 * Panel -> daemon: HTTP with `Authorization: Bearer <node secret>`.
 * Daemon -> panel: HTTP with `Authorization: Bearer <node uuid>.<node secret>` under /api/remote.
 * Browser -> daemon: WebSocket authenticated with a short-lived HS256 JWT the panel signs with the node secret.
 */

export type PowerAction = 'start' | 'stop' | 'restart' | 'kill';
export const POWER_ACTIONS: PowerAction[] = ['start', 'stop', 'restart', 'kill'];

export type ProcessState = 'offline' | 'starting' | 'running' | 'stopping';

export type ConfigFileParser = 'properties' | 'json' | 'yaml' | 'ini' | 'toml' | 'file';

export interface ConfigFileReplacement {
  /** Key path (dot-separated for json/yaml, plain key for properties/ini, line prefix for `file`). */
  match: string;
  /** Value with panel-side templates already resolved. `{{env.X}}` placeholders are resolved by the daemon. */
  replaceWith: string;
  /**
   * A structured value (list, map) for json/yaml/toml, used instead of `replaceWith`. For toml, a map
   * with a plain table name as `match` replaces that whole table.
   */
  value?: unknown;
}

export interface ConfigFile {
  file: string;
  parser: ConfigFileParser;
  replace: ConfigFileReplacement[];
}

export interface ServerConfiguration {
  uuid: string;
  suspended: boolean;
  /** Startup command with `{{VAR}}` placeholders; passed to the container as `STARTUP`. */
  invocation: string;
  environment: Record<string, string>;
  allocations: {
    default: { ip: string; port: number };
    /** Every IP/port pair bound to the container, including the default. */
    mappings: Record<string, number[]>;
  };
  build: {
    /** MiB, 0 = unlimited. */
    memoryLimit: number;
    /** MiB, -1 = unlimited, 0 = disabled. */
    swap: number;
    /** Block IO weight 10-1000. */
    ioWeight: number;
    /** Percent of one core (100 = one core), 0 = unlimited. */
    cpuLimit: number;
    /** e.g. "0-1,3", null for any. */
    threads: string | null;
    /** MiB, 0 = unlimited. */
    diskSpace: number;
    oomKiller: boolean;
  };
  container: { image: string };
  egg: { uuid: string; fileDenylist: string[] };
  process: {
    startup: { done: string[]; stripAnsi: boolean };
    stop: { type: 'command' | 'signal'; value: string };
    configs: ConfigFile[];
  };
}

export interface InstallationScript {
  containerImage: string;
  entrypoint: string;
  script: string;
}

export interface InstallStatusReport {
  successful: boolean;
  reinstall: boolean;
}

export interface PairRequest {
  token: string;
}

export interface PairResponse {
  nodeUuid: string;
  secret: string;
  panelUrl: string;
  daemonPort: number;
  sftpPort: number;
  dataDirectory: string;
  /** Hostname the browser uses to reach the daemon; used for the TLS hint during pairing. */
  fqdn: string;
  /** Largest upload in MiB. */
  uploadSize: number;
}

export interface DaemonSystemInfo {
  version: string;
  os: string;
  arch: string;
  kernel: string;
  cpuCount: number;
  memoryTotal: number;
  dockerVersion: string | null;
  servers: number;
  uptime: number;
}

export interface ServerResourceUsage {
  state: ProcessState;
  /** Percent where 100 = one full core. */
  cpu: number;
  memoryBytes: number;
  memoryLimitBytes: number;
  diskBytes: number;
  networkRxBytes: number;
  networkTxBytes: number;
  uptimeMs: number;
}

/** Claims of the JWT a browser presents to the daemon websocket. */
export interface WebsocketTokenClaims {
  /** User UUID. */
  sub: string;
  server: string;
  permissions: string[];
  /** Unique id so a token can be revoked (e.g. when a subuser is removed). */
  jti: string;
}

// --- Files ------------------------------------------------------------------------------------------

export interface FileEntry {
  name: string;
  /** e.g. "-rw-r--r--" */
  mode: string;
  /** e.g. "644" */
  modeBits: string;
  size: number;
  isFile: boolean;
  isDirectory: boolean;
  isSymlink: boolean;
  mimetype: string;
  /** Small enough and not a known binary format, so the editor may open it. */
  editable: boolean;
  createdAt: string;
  modifiedAt: string;
}

/** Largest file the panel's editor will open or save. */
export const MAX_EDITABLE_FILE_BYTES = 5 * 1024 * 1024;

/**
 * Claims of the JWT that lets a browser upload/download straight to/from the daemon without
 * streaming through the panel. Signed with the node secret like websocket tokens.
 */
export interface TransferTokenClaims {
  sub: string;
  server: string;
  kind: 'download-file' | 'upload' | 'download-backup';
  /** File to download (download-file). */
  path?: string;
  /** Backup UUID (download-backup). */
  backup?: string;
  jti: string;
}

// --- Backups ----------------------------------------------------------------------------------------

export interface BackupRequest {
  uuid: string;
  /** Gitignore-style patterns to leave out. */
  ignore: string[];
}

export interface BackupCompletion {
  successful: boolean;
  checksum: string | null;
  bytes: number;
}

export interface RestoreRequest {
  /** Delete every existing file before extracting. */
  truncate: boolean;
}

// --- SFTP -------------------------------------------------------------------------------------------

export interface SftpAuthRequest {
  /** "<panel username>.<server short id>" */
  username: string;
  password: string;
  ip: string;
}

export interface SftpAuthResponse {
  server: string;
  user: string;
  permissions: string[];
}

/** Websocket messages, in both directions, are `{ event, args? }`. */
export interface WsMessage {
  event: string;
  args?: string[];
}

export const WS_EVENTS = {
  // client -> daemon
  AUTH: 'auth',
  SEND_COMMAND: 'send command',
  SET_STATE: 'set state',
  SEND_LOGS: 'send logs',
  SEND_STATS: 'send stats',
  // daemon -> client
  AUTH_SUCCESS: 'auth success',
  CONSOLE_OUTPUT: 'console output',
  INSTALL_OUTPUT: 'install output',
  INSTALL_STARTED: 'install started',
  INSTALL_COMPLETED: 'install completed',
  BACKUP_COMPLETED: 'backup completed',
  BACKUP_RESTORE_COMPLETED: 'backup restore completed',
  STATUS: 'status',
  STATS: 'stats',
  DAEMON_MESSAGE: 'daemon message',
  DAEMON_ERROR: 'daemon error',
  TOKEN_EXPIRING: 'token expiring',
  TOKEN_EXPIRED: 'token expired',
  JWT_ERROR: 'jwt error',
} as const;
