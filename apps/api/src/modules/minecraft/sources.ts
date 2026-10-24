import type { Loader, PluginSearchResult, PluginSource, PluginVersion } from '@glacier/shared';
import { HttpError } from '../../lib/errors';

/**
 * Plugin/mod catalogues, normalised to one shape. Modrinth and Hangar are free and keyless;
 * CurseForge needs an API key (https://console.curseforge.com), set by an admin.
 */

const UA = 'glacier-panel/0.1 (self-hosted game server panel)';

async function getJson<T>(url: string, headers: Record<string, string> = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json', ...headers }, signal: AbortSignal.timeout(10_000) });
  } catch {
    throw new HttpError(502, 'catalog_unreachable', `Couldn't reach ${new URL(url).host}. Try again in a moment.`);
  }
  if (res.status === 404) throw new HttpError(404, 'not_found', 'That project was not found.');
  if (!res.ok) throw new HttpError(502, 'catalog_error', `${new URL(url).host} answered HTTP ${res.status}.`);
  return (await res.json()) as T;
}

export interface CatalogQuery {
  query: string;
  loader: Loader | null;
  gameVersion: string | null;
  page: number;
}

export interface Catalog {
  search(q: CatalogQuery): Promise<{ results: PluginSearchResult[]; total: number }>;
  versions(projectId: string, loader: Loader | null, gameVersion: string | null): Promise<PluginVersion[]>;
  project(projectId: string): Promise<{ name: string; iconUrl: string | null }>;
}

const PAGE_SIZE = 20;

// --- Modrinth ---------------------------------------------------------------------------------------

/** Modrinth tags plugins by the platforms they run on; Paper runs Bukkit/Spigot plugins too. */
function modrinthLoaders(loader: Loader | null): string[] {
  switch (loader) {
    case 'paper':
      return ['paper', 'spigot', 'bukkit'];
    case 'purpur':
      return ['purpur', 'paper', 'spigot', 'bukkit'];
    case 'folia':
      return ['folia'];
    case 'spigot':
      return ['spigot', 'bukkit'];
    case 'waterfall':
      return ['waterfall', 'bungeecord'];
    case null:
      return [];
    default:
      return [loader];
  }
}

interface ModrinthHit {
  project_id: string;
  slug: string;
  title: string;
  author: string;
  description: string;
  icon_url: string | null;
  downloads: number;
  project_type: string;
}

interface ModrinthVersion {
  id: string;
  name: string;
  version_number: string;
  game_versions: string[];
  loaders: string[];
  date_published: string;
  files: { url: string; filename: string; primary: boolean; size: number; hashes: { sha1?: string; sha512?: string } }[];
}

const modrinth: Catalog = {
  async search({ query, loader, gameVersion, page }) {
    const facets: string[][] = [];
    const loaders = modrinthLoaders(loader);
    if (loaders.length) facets.push(loaders.map((l) => `categories:${l}`));
    if (gameVersion) facets.push([`versions:${gameVersion}`]);
    facets.push(['project_type:mod', 'project_type:plugin']);
    const params = new URLSearchParams({ query, limit: String(PAGE_SIZE), offset: String((page - 1) * PAGE_SIZE), index: query ? 'relevance' : 'downloads', facets: JSON.stringify(facets) });
    const data = await getJson<{ hits: ModrinthHit[]; total_hits: number }>(`https://api.modrinth.com/v2/search?${params}`);
    return {
      total: data.total_hits,
      results: data.hits.map((h) => ({
        source: 'modrinth',
        id: h.project_id,
        slug: h.slug,
        name: h.title,
        author: h.author,
        description: h.description,
        iconUrl: h.icon_url,
        downloads: h.downloads,
        pageUrl: `https://modrinth.com/${h.project_type === 'mod' ? 'mod' : 'plugin'}/${h.slug}`,
      })),
    };
  },
  async versions(projectId, loader, gameVersion) {
    const params = new URLSearchParams();
    const loaders = modrinthLoaders(loader);
    if (loaders.length) params.set('loaders', JSON.stringify(loaders));
    if (gameVersion) params.set('game_versions', JSON.stringify([gameVersion]));
    const data = await getJson<ModrinthVersion[]>(`https://api.modrinth.com/v2/project/${encodeURIComponent(projectId)}/version?${params}`);
    return data.map((v) => {
      const file = v.files.find((f) => f.primary) ?? v.files[0];
      return {
        id: v.id,
        name: v.version_number || v.name,
        gameVersions: v.game_versions,
        loaders: v.loaders,
        publishedAt: v.date_published,
        file: file ? { filename: file.filename, size: file.size, url: file.url, sha1: file.hashes.sha1, sha512: file.hashes.sha512 } : null,
      };
    });
  },
  async project(projectId) {
    const p = await getJson<{ title: string; icon_url: string | null }>(`https://api.modrinth.com/v2/project/${encodeURIComponent(projectId)}`);
    return { name: p.title, iconUrl: p.icon_url };
  },
};

// --- Hangar (PaperMC) -------------------------------------------------------------------------------

function hangarPlatform(loader: Loader | null) {
  if (loader === 'velocity') return 'VELOCITY';
  if (loader === 'waterfall' || loader === 'bungeecord') return 'WATERFALL';
  if (loader && ['paper', 'purpur', 'folia', 'spigot'].includes(loader)) return 'PAPER';
  return null;
}

interface HangarProject {
  id: number;
  name: string;
  namespace: { owner: string; slug: string };
  description: string;
  avatarUrl: string | null;
  stats: { downloads: number };
}

interface HangarVersion {
  id: number;
  name: string;
  createdAt: string;
  platformDependencies: Record<string, string[]>;
  downloads: Record<string, { fileInfo: { name: string; sizeBytes: number; sha256Hash: string } | null; externalUrl: string | null; downloadUrl: string | null }>;
}

const hangar: Catalog = {
  async search({ query, loader, gameVersion, page }) {
    const platform = hangarPlatform(loader);
    const params = new URLSearchParams({ q: query, limit: String(PAGE_SIZE), offset: String((page - 1) * PAGE_SIZE), sort: query ? '-stars' : '-downloads' });
    if (platform) params.set('platform', platform);
    if (platform && gameVersion) params.set('version', gameVersion);
    const data = await getJson<{ pagination: { count: number }; result: HangarProject[] }>(`https://hangar.papermc.io/api/v1/projects?${params}`);
    return {
      total: data.pagination.count,
      results: data.result.map((p) => ({
        source: 'hangar',
        id: String(p.id),
        slug: `${p.namespace.owner}/${p.namespace.slug}`,
        name: p.name,
        author: p.namespace.owner,
        description: p.description,
        iconUrl: p.avatarUrl,
        downloads: p.stats.downloads,
        pageUrl: `https://hangar.papermc.io/${p.namespace.owner}/${p.namespace.slug}`,
      })),
    };
  },
  async versions(projectId, loader, gameVersion) {
    const platform = hangarPlatform(loader) ?? 'PAPER';
    const url = (channel?: string) =>
      `https://hangar.papermc.io/api/v1/projects/${encodeURIComponent(projectId)}/versions?${new URLSearchParams({ limit: '25', platform, ...(channel ? { channel } : {}) })}`;
    // Prefer release builds; some projects only publish snapshots/betas.
    let result = (await getJson<{ result: HangarVersion[] }>(url('Release'))).result;
    if (!result.length) result = (await getJson<{ result: HangarVersion[] }>(url())).result;
    // Hangar has no Minecraft-version filter, so apply it here.
    if (gameVersion) result = result.filter((v) => (v.platformDependencies[platform] ?? []).some((d) => d === gameVersion || (d.includes('-') && versionInRange(gameVersion, d))));
    return result.map((v) => {
      const d = v.downloads[platform];
      return {
        id: String(v.id),
        name: v.name,
        gameVersions: v.platformDependencies[platform] ?? [],
        loaders: Object.keys(v.downloads).map((k) => k.toLowerCase()),
        publishedAt: v.createdAt,
        // External-only downloads (hosted elsewhere) can't be fetched safely by the node.
        file: d?.downloadUrl && d.fileInfo ? { filename: d.fileInfo.name, size: d.fileInfo.sizeBytes, url: d.downloadUrl, sha256: d.fileInfo.sha256Hash } : null,
      };
    });
  },
  async project(projectId) {
    const p = await getJson<HangarProject>(`https://hangar.papermc.io/api/v1/projects/${encodeURIComponent(projectId)}`);
    return { name: p.name, iconUrl: p.avatarUrl };
  },
};

/** Hangar sometimes lists ranges like "1.20-1.21.4". */
function versionInRange(version: string, range: string) {
  const [lo, hi] = range.split('-').map((s) => s.trim().split('.').map(Number));
  const v = version.split('.').map(Number);
  const cmp = (a: number[], b: number[]) => {
    for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0);
    return 0;
  };
  return Boolean(lo && hi) && cmp(v, lo!) >= 0 && cmp(v, hi!) <= 0;
}

// --- CurseForge -------------------------------------------------------------------------------------

const CF_GAME_MINECRAFT = 432;
const CF_CLASS = { mods: 6, plugins: 5 };
const CF_LOADER: Partial<Record<Loader, number>> = { forge: 1, fabric: 4, quilt: 5, neoforge: 6 };

interface CfMod {
  id: number;
  slug: string;
  name: string;
  summary: string;
  downloadCount: number;
  logo: { thumbnailUrl: string } | null;
  authors: { name: string }[];
  links: { websiteUrl: string };
  classId: number;
}

interface CfFile {
  id: number;
  displayName: string;
  fileName: string;
  fileLength: number;
  fileDate: string;
  downloadUrl: string | null;
  gameVersions: string[];
  hashes: { value: string; algo: number }[];
}

function curseforge(apiKey: string): Catalog {
  const headers = { 'x-api-key': apiKey };
  return {
    async search({ query, loader, gameVersion, page }) {
      const params = new URLSearchParams({
        gameId: String(CF_GAME_MINECRAFT),
        classId: String(loader && CF_LOADER[loader] ? CF_CLASS.mods : CF_CLASS.plugins),
        searchFilter: query,
        sortField: '2',
        sortOrder: 'desc',
        pageSize: String(PAGE_SIZE),
        index: String((page - 1) * PAGE_SIZE),
      });
      if (loader && CF_LOADER[loader]) params.set('modLoaderType', String(CF_LOADER[loader]));
      if (gameVersion) params.set('gameVersion', gameVersion);
      const data = await getJson<{ data: CfMod[]; pagination: { totalCount: number } }>(`https://api.curseforge.com/v1/mods/search?${params}`, headers);
      return {
        total: Math.min(data.pagination.totalCount, 10_000),
        results: data.data.map((m) => ({
          source: 'curseforge',
          id: String(m.id),
          slug: m.slug,
          name: m.name,
          author: m.authors[0]?.name ?? '',
          description: m.summary,
          iconUrl: m.logo?.thumbnailUrl ?? null,
          downloads: m.downloadCount,
          pageUrl: m.links.websiteUrl,
        })),
      };
    },
    async versions(projectId, loader, gameVersion) {
      const params = new URLSearchParams({ pageSize: '25' });
      if (loader && CF_LOADER[loader]) params.set('modLoaderType', String(CF_LOADER[loader]));
      if (gameVersion) params.set('gameVersion', gameVersion);
      const data = await getJson<{ data: CfFile[] }>(`https://api.curseforge.com/v1/mods/${encodeURIComponent(projectId)}/files?${params}`, headers);
      return data.data.map((f) => ({
        id: String(f.id),
        name: f.displayName,
        gameVersions: f.gameVersions.filter((v) => /^\d/.test(v)),
        loaders: f.gameVersions.filter((v) => !/^\d/.test(v)).map((v) => v.toLowerCase()),
        publishedAt: f.fileDate,
        // Null when the author disabled third-party downloads.
        file: f.downloadUrl ? { filename: f.fileName, size: f.fileLength, url: f.downloadUrl, sha1: f.hashes.find((h) => h.algo === 1)?.value } : null,
      }));
    },
    async project(projectId) {
      const m = await getJson<{ data: CfMod }>(`https://api.curseforge.com/v1/mods/${encodeURIComponent(projectId)}`, headers);
      return { name: m.data.name, iconUrl: m.data.logo?.thumbnailUrl ?? null };
    },
  };
}

export function catalog(source: PluginSource, curseforgeKey: string | null): Catalog {
  if (source === 'modrinth') return modrinth;
  if (source === 'hangar') return hangar;
  if (!curseforgeKey) throw new HttpError(404, 'not_configured', 'CurseForge is not set up on this panel.');
  return curseforge(curseforgeKey);
}
