/**
 * Server-level permissions that can be granted to subusers. Owners and root admins hold all of them.
 * Grouped so the UI can render a permission matrix directly from this object.
 */
export const SERVER_PERMISSIONS = {
  control: {
    description: 'Console and power state',
    keys: {
      console: 'View the console and its history',
      command: 'Send commands to the console',
      start: 'Start the server',
      stop: 'Stop the server',
      restart: 'Restart the server',
      kill: 'Force-kill the server',
    },
  },
  file: {
    description: 'File manager and SFTP',
    keys: {
      read: 'List directories and read file contents',
      create: 'Create and upload files',
      update: 'Edit existing files',
      delete: 'Delete files',
      archive: 'Compress and extract archives',
      sftp: 'Connect over SFTP',
    },
  },
  backup: {
    description: 'Backups',
    keys: {
      read: 'View backups',
      create: 'Create backups',
      restore: 'Restore backups',
      download: 'Download backups',
      delete: 'Delete backups',
    },
  },
  database: {
    description: 'Databases',
    keys: {
      read: 'View databases',
      create: 'Create databases',
      'view-password': 'Reveal database passwords',
      update: 'Rotate database passwords',
      delete: 'Delete databases',
    },
  },
  schedule: {
    description: 'Scheduled tasks',
    keys: { read: 'View schedules', create: 'Create schedules', update: 'Edit schedules', delete: 'Delete schedules' },
  },
  user: {
    description: 'Subusers',
    keys: { read: 'View subusers', create: 'Invite subusers', update: 'Edit subusers', delete: 'Remove subusers' },
  },
  startup: {
    description: 'Startup configuration',
    keys: { read: 'View startup variables', update: 'Edit startup variables', 'docker-image': 'Change the Docker image' },
  },
  settings: {
    description: 'Server settings',
    keys: { rename: 'Rename the server', reinstall: 'Reinstall the server' },
  },
  allocation: {
    description: 'Network allocations',
    keys: { read: 'View allocations', create: 'Add allocations', update: 'Edit allocations', delete: 'Remove allocations' },
  },
  activity: {
    description: 'Activity log',
    keys: { read: 'View the server activity log' },
  },
  plugins: {
    description: 'Plugin and mod installer',
    keys: { read: 'Browse installed plugins and mods', manage: 'Install, update and remove plugins and mods' },
  },
  players: {
    description: 'Minecraft players',
    keys: { read: 'See online players, whitelist, ops and bans', manage: 'Whitelist, op, kick and ban players' },
  },
  subdomain: {
    description: 'Subdomains',
    keys: { manage: 'Add and remove subdomains for this server' },
  },
} as const;

type PermissionGroups = typeof SERVER_PERMISSIONS;
export type ServerPermission = {
  [G in keyof PermissionGroups]: `${G & string}.${keyof PermissionGroups[G]['keys'] & string}`;
}[keyof PermissionGroups];

export const ALL_SERVER_PERMISSIONS: ServerPermission[] = Object.entries(SERVER_PERMISSIONS).flatMap(
  ([group, def]) => Object.keys(def.keys).map((key) => `${group}.${key}` as ServerPermission),
);

/** Wildcard granted to owners and admins. */
export const PERMISSION_ALL = '*';

export function hasPermission(granted: readonly string[], needed: ServerPermission): boolean {
  return granted.includes(PERMISSION_ALL) || granted.includes(needed);
}

export function isServerPermission(value: string): value is ServerPermission {
  return (ALL_SERVER_PERMISSIONS as string[]).includes(value);
}
