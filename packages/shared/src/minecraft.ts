/** Types shared by the plugin/mod browser, version switcher and player manager. */

export const PLUGIN_SOURCES = ['modrinth', 'hangar', 'curseforge'] as const;
export type PluginSource = (typeof PLUGIN_SOURCES)[number];

/** Server software a plugin/mod targets. Plugins go in plugins/, mods in mods/. */
export const LOADERS = ['paper', 'purpur', 'spigot', 'folia', 'velocity', 'fabric', 'quilt', 'forge', 'neoforge'] as const;
export type Loader = (typeof LOADERS)[number];

export const MOD_LOADERS: readonly Loader[] = ['fabric', 'quilt', 'forge', 'neoforge'];

export function loaderDirectory(loader: Loader): 'plugins' | 'mods' {
  return MOD_LOADERS.includes(loader) ? 'mods' : 'plugins';
}

export interface PluginSearchResult {
  source: PluginSource;
  id: string;
  slug: string;
  name: string;
  author: string;
  description: string;
  iconUrl: string | null;
  downloads: number;
  pageUrl: string;
}

export interface PluginVersion {
  id: string;
  name: string;
  gameVersions: string[];
  loaders: string[];
  publishedAt: string;
  /** Null when the author doesn't allow third-party downloads (download from pageUrl instead). */
  file: { filename: string; size: number; url: string; sha1?: string; sha256?: string; sha512?: string } | null;
}

export interface InstalledPluginInfo {
  id: number;
  source: PluginSource;
  projectId: string;
  versionId: string;
  name: string;
  versionName: string;
  path: string;
  iconUrl: string | null;
  installedAt: string;
  enabled: boolean;
  /** Newer version for this server's software and Minecraft version, if any. */
  update: { id: string; name: string } | null;
}

/** What the panel worked out about a server's Minecraft setup. */
export interface MinecraftContext {
  loader: Loader | null;
  /** e.g. "1.21.4"; null when the server tracks "latest". */
  gameVersion: string | null;
  /** Server type for the version switcher, when the egg supports switching. */
  versionSource: 'paper' | 'purpur' | 'vanilla' | 'fabric' | null;
}

export interface MinecraftStatus {
  online: boolean;
  version?: string;
  motd?: string;
  players?: { online: number; max: number; sample: { name: string; id: string }[] };
  latencyMs?: number;
}

export interface PlayerEntry {
  name: string;
  uuid: string;
  /** Ban reason, op level, etc. */
  detail?: string;
}

export interface ResourceSample {
  /** Unix ms */
  t: number;
  cpu: number;
  memoryBytes: number;
  networkRxBytes: number;
  networkTxBytes: number;
}

export interface FileSearchHit {
  path: string;
  /** For content matches: line number and the line's text. */
  line?: number;
  preview?: string;
}
