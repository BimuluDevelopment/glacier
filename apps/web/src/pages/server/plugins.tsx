import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ArrowUpCircle, Download, ExternalLink, Package, Puzzle, RefreshCw, Search, Trash2 } from 'lucide-react';
import {
  LOADERS,
  MOD_LOADERS,
  loaderDirectory,
  type InstalledPluginInfo,
  type Loader,
  type MinecraftContext,
  type PluginSearchResult,
  type PluginSource,
  type PluginVersion,
} from '@glacier/shared';
import { api, errorMessage } from '../../lib/api';
import { formatBytes, formatDate, timeAgo } from '../../lib/format';
import { useServer } from '../../features/server/context';
import { Alert, Badge, Button, Card, EmptyState, Field, Input, Modal, PageLoader, Select, Spinner, Switch } from '../../components/ui';

const SOURCE_LABELS: Record<PluginSource, string> = { modrinth: 'Modrinth', hangar: 'Hangar', curseforge: 'CurseForge' };
const LOADER_LABELS: Record<Loader, string> = {
  paper: 'Paper / Spigot',
  purpur: 'Purpur',
  spigot: 'Spigot',
  folia: 'Folia',
  velocity: 'Velocity (proxy)',
  bungeecord: 'BungeeCord (proxy)',
  waterfall: 'Waterfall (proxy)',
  fabric: 'Fabric',
  quilt: 'Quilt',
  forge: 'Forge',
  neoforge: 'NeoForge',
};

const compact = (n: number) => Intl.NumberFormat(undefined, { notation: 'compact' }).format(n);

interface Overview {
  context: MinecraftContext;
  sources: PluginSource[];
  installed: InstalledPluginInfo[];
}

export function PluginsTab() {
  const { server, base, can } = useServer();
  const qc = useQueryClient();
  const [checkUpdates, setCheckUpdates] = useState(false);
  const key = ['server', server.id, 'plugins', checkUpdates];
  const { data, isLoading, error } = useQuery({ queryKey: key, queryFn: () => api.get<Overview>(`${base}/plugins?updates=${checkUpdates}`) });

  const [loader, setLoader] = useState<Loader | ''>('');
  const [gameVersion, setGameVersion] = useState('');
  useEffect(() => {
    if (!data) return;
    setLoader((l) => l || data.context.loader || '');
    setGameVersion((v) => v || data.context.gameVersion || '');
  }, [data]);

  const [source, setSource] = useState<PluginSource>('modrinth');
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [page, setPage] = useState(1);
  useEffect(() => {
    const t = setTimeout(() => {
      setDebounced(query);
      setPage(1);
    }, 350);
    return () => clearTimeout(t);
  }, [query]);
  const filterParams = new URLSearchParams({ ...(loader ? { loader } : {}), ...(gameVersion ? { gameVersion } : {}) });

  const results = useQuery({
    queryKey: ['plugin-search', server.id, source, debounced, loader, gameVersion, page],
    queryFn: () => api.get<{ results: PluginSearchResult[]; total: number }>(`${base}/plugins/search?source=${source}&q=${encodeURIComponent(debounced)}&page=${page}&${filterParams}`),
    enabled: Boolean(data),
    placeholderData: (prev) => prev,
  });
  const [selected, setSelected] = useState<PluginSearchResult | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['server', server.id, 'plugins'] });

  const toggle = useMutation({ mutationFn: (p: InstalledPluginInfo) => api.post(`${base}/plugins/${p.id}/toggle`, { enabled: !p.enabled }), onSuccess: refresh });
  const remove = useMutation({ mutationFn: (p: InstalledPluginInfo) => api.delete(`${base}/plugins/${p.id}`), onSuccess: refresh });
  const update = useMutation({
    mutationFn: (p: InstalledPluginInfo) => api.post(`${base}/plugins/install`, { source: p.source, projectId: p.projectId, versionId: p.update!.id, ...(loader ? { loader } : {}), ...(gameVersion ? { gameVersion } : {}) }),
    onSuccess: (_r, p) => {
      setNotice(`Updated ${p.name}. Restart the server to load it.`);
      void refresh();
    },
  });

  if (isLoading) return <PageLoader />;
  if (error || !data) return <Alert>{errorMessage(error)}</Alert>;
  const manage = can('plugins.manage');
  const mutationError = toggle.error ?? remove.error ?? update.error;

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <div className="grid gap-4 sm:grid-cols-[1fr_1fr_2fr]">
          <Field label="Server software" hint={data.context.loader ? 'Detected from the server type.' : 'Pick what this server runs.'}>
            {(id) => (
              <Select id={id} value={loader} onChange={(e) => setLoader(e.target.value as Loader)}>
                <option value="">Choose…</option>
                {LOADERS.map((l) => (
                  <option key={l} value={l}>
                    {LOADER_LABELS[l]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Minecraft version" hint={data.context.gameVersion ? 'From the server settings.' : 'Empty shows every version.'}>
            {(id) => <Input id={id} placeholder="e.g. 1.21.4" value={gameVersion} onChange={(e) => setGameVersion(e.target.value.trim())} />}
          </Field>
          <div className="flex items-end text-xs text-muted">
            {loader ? `Files go into ${loaderDirectory(loader)}/. Restart the server after installing to load them.` : 'Choose the server software to see compatible plugins and mods.'}
          </div>
        </div>
      </Card>

      {notice && <Alert tone="success">{notice}</Alert>}
      {mutationError && <Alert>{mutationError.message}</Alert>}

      <Card
        title={`Installed (${data.installed.length})`}
        padded={false}
        actions={
          <Button size="sm" variant="secondary" icon={<RefreshCw className="size-4" />} onClick={() => setCheckUpdates(true)} disabled={checkUpdates}>
            {checkUpdates ? 'Checked for updates' : 'Check for updates'}
          </Button>
        }
      >
        {data.installed.length === 0 ? (
          <EmptyState icon={<Package className="size-7" />} title="Nothing installed from the panel yet">
            Plugins and mods you install below show up here, with update checks.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-border">
            {data.installed.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                <Icon url={p.iconUrl} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2 font-medium">
                    {p.name} <Badge>{SOURCE_LABELS[p.source]}</Badge>
                    {!p.enabled && <Badge tone="warning">Disabled</Badge>}
                    {p.update && <Badge tone="primary">Update: {p.update.name}</Badge>}
                  </div>
                  <div className="truncate font-mono text-xs text-muted">
                    {p.path} · {p.versionName} · {timeAgo(p.installedAt)}
                  </div>
                </div>
                {manage && (
                  <div className="flex items-center gap-2">
                    {p.update && (
                      <Button size="sm" icon={<ArrowUpCircle className="size-4" />} loading={update.isPending && update.variables?.id === p.id} onClick={() => update.mutate(p)}>
                        Update
                      </Button>
                    )}
                    <Switch checked={p.enabled} onChange={() => toggle.mutate(p)} label="Enabled" />
                    <button className="rounded p-1.5 text-muted hover:text-danger" aria-label={`Remove ${p.name}`} onClick={() => confirm(`Remove ${p.name}?`) && remove.mutate(p)}>
                      <Trash2 className="size-4" />
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {manage && (
        <Card title="Browse" padded={false}>
          <div className="flex flex-wrap items-center gap-3 border-b border-border p-4">
            <div className="flex rounded-ui border border-border p-0.5 text-sm">
              {data.sources.map((s) => (
                <button
                  key={s}
                  onClick={() => {
                    setSource(s);
                    setPage(1);
                  }}
                  className={clsx('rounded px-3 py-1.5', source === s ? 'bg-surface-alt text-text' : 'text-muted')}
                >
                  {SOURCE_LABELS[s]}
                </button>
              ))}
            </div>
            <div className="relative min-w-60 flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
              <Input className="pl-9" placeholder={`Search ${SOURCE_LABELS[source]}…`} value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
            {results.isFetching && <Spinner />}
          </div>
          {results.error ? (
            <div className="p-4">
              <Alert>{results.error.message}</Alert>
            </div>
          ) : !results.data?.results.length ? (
            <EmptyState icon={<Puzzle className="size-7" />} title={results.isLoading ? 'Loading…' : 'No results'}>
              {!results.isLoading && 'Try another search, source or Minecraft version.'}
            </EmptyState>
          ) : (
            <>
              <div className="grid gap-px bg-border sm:grid-cols-2 xl:grid-cols-3">
                {results.data.results.map((r) => (
                  <button key={`${r.source}:${r.id}`} onClick={() => setSelected(r)} className="flex gap-3 bg-surface p-4 text-left transition hover:bg-surface-alt">
                    <Icon url={r.iconUrl} />
                    <div className="min-w-0">
                      <div className="truncate font-medium">{r.name}</div>
                      <div className="text-xs text-muted">
                        by {r.author} · <Download className="inline size-3" /> {compact(r.downloads)}
                      </div>
                      <p className="mt-1 line-clamp-2 text-xs text-muted">{r.description}</p>
                    </div>
                  </button>
                ))}
              </div>
              <div className="flex items-center justify-between border-t border-border px-4 py-3 text-sm text-muted">
                <span>{compact(results.data.total)} results</span>
                <div className="flex gap-2">
                  <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                    Previous
                  </Button>
                  <Button size="sm" variant="secondary" disabled={page * 20 >= results.data.total} onClick={() => setPage((p) => p + 1)}>
                    Next
                  </Button>
                </div>
              </div>
            </>
          )}
        </Card>
      )}

      {selected && (
        <VersionPicker
          project={selected}
          filters={filterParams}
          loader={loader || null}
          gameVersion={gameVersion}
          onClose={() => setSelected(null)}
          onInstalled={(name) => {
            setNotice(`Installed ${name}. Restart the server to load it.`);
            setSelected(null);
            void refresh();
          }}
        />
      )}
    </div>
  );
}

function Icon({ url }: { url: string | null }) {
  return url ? (
    <img src={url} alt="" loading="lazy" className="size-11 shrink-0 rounded-ui bg-surface-alt object-cover" />
  ) : (
    <span className="flex size-11 shrink-0 items-center justify-center rounded-ui bg-surface-alt text-muted">
      <Puzzle className="size-5" />
    </span>
  );
}

function VersionPicker({
  project,
  filters,
  loader,
  gameVersion,
  onClose,
  onInstalled,
}: {
  project: PluginSearchResult;
  filters: URLSearchParams;
  loader: Loader | null;
  gameVersion: string;
  onClose: () => void;
  onInstalled: (name: string) => void;
}) {
  const { base } = useServer();
  const { data, isLoading, error } = useQuery({
    queryKey: ['plugin-versions', project.source, project.id, filters.toString()],
    queryFn: () => api.get<{ data: PluginVersion[] }>(`${base}/plugins/${project.source}/${encodeURIComponent(project.id)}/versions?${filters}`).then((r) => r.data),
  });
  const install = useMutation({
    mutationFn: (v: PluginVersion) => api.post(`${base}/plugins/install`, { source: project.source, projectId: project.id, versionId: v.id, ...(loader ? { loader } : {}), ...(gameVersion ? { gameVersion } : {}) }),
    onSuccess: () => onInstalled(project.name),
  });
  const wrongKind = loader && MOD_LOADERS.includes(loader) && project.source === 'hangar';

  return (
    <Modal open onClose={onClose} title={project.name} wide>
      <div className="flex flex-col gap-4">
        <div className="flex gap-3">
          <Icon url={project.iconUrl} />
          <div className="text-sm">
            <p className="text-muted">{project.description}</p>
            <a href={project.pageUrl} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 text-primary hover:underline">
              Project page <ExternalLink className="size-3" />
            </a>
          </div>
        </div>
        {!loader && <Alert tone="warning">Choose the server software first so the right files are picked.</Alert>}
        {wrongKind && <Alert tone="warning">Hangar hosts Paper/Velocity plugins; they won't load on a {loader} server.</Alert>}
        {install.error && <Alert>{install.error.message}</Alert>}
        {isLoading ? (
          <Spinner />
        ) : error ? (
          <Alert>{errorMessage(error)}</Alert>
        ) : !data?.length ? (
          <Alert tone="warning">No versions match this server's software and Minecraft version.</Alert>
        ) : (
          <ul className="max-h-[50vh] divide-y divide-border overflow-y-auto rounded-ui border border-border">
            {data.map((v, i) => (
              <li key={v.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 font-medium">
                    {v.name} {i === 0 && <Badge tone="primary">Latest</Badge>}
                  </div>
                  <div className="text-xs text-muted">
                    {formatDate(v.publishedAt)} · MC {summarizeVersions(v.gameVersions)}
                    {v.file && ` · ${formatBytes(v.file.size)}`}
                  </div>
                </div>
                {v.file ? (
                  <Button size="sm" disabled={!loader} loading={install.isPending && install.variables?.id === v.id} onClick={() => install.mutate(v)}>
                    Install
                  </Button>
                ) : (
                  <a href={project.pageUrl} target="_blank" rel="noreferrer">
                    <Button size="sm" variant="secondary" type="button" tabIndex={-1}>
                      Manual download
                    </Button>
                  </a>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}

/** "1.20.1 – 1.21.4" instead of a list of forty versions. */
function summarizeVersions(list: string[]) {
  if (list.length <= 3) return list.join(', ') || 'any';
  return `${list[0]} – ${list.at(-1)}`;
}
