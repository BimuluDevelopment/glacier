import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { Cpu, HardDrive, LayoutGrid, List, MemoryStick, Search, Server as ServerIcon, X } from 'lucide-react';
import type { ServerResourceUsage } from '@glacier/shared';
import { api, type Paged } from '../lib/api';
import { formatBytes, formatMiB } from '../lib/format';
import type { ClientServerSummary } from '../lib/types';
import { ServerLogo } from '../components/ServerLogo';
import { useAuth } from '../auth/AuthProvider';
import { useTheme } from '../theme/ThemeProvider';
import { Markdown, useT } from '../theme/i18n';
import { Badge, EmptyState, Input, PageHeader, PageLoader, ServerStatusBadge } from '../components/ui';

const stateTone = { running: 'success', starting: 'warning', stopping: 'warning', offline: 'neutral' } as const;
const LAYOUT_KEY = 'glacier-dashboard-layout';
const DISMISSED_KEY = 'glacier-dismissed-announcements';

interface Announcement {
  id: number;
  title: string;
  body: string;
  tone: 'primary' | 'success' | 'warning' | 'danger';
  updatedAt: string;
}

function readDismissed(): string[] {
  try {
    return JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? '[]');
  } catch {
    return [];
  }
}

/** Admin announcements. Dismissal is per browser and per version, so an edited one shows again. */
function Announcements() {
  const { branding } = useTheme();
  const [dismissed, setDismissed] = useState(readDismissed);
  const { data } = useQuery({
    queryKey: ['announcements'],
    queryFn: () => api.get<{ data: Announcement[] }>('/client/announcements').then((r) => r.data),
    enabled: branding.features.announcements,
    staleTime: 60_000,
  });
  const visible = (data ?? []).filter((a) => !dismissed.includes(`${a.id}:${a.updatedAt}`));
  if (!visible.length) return null;
  const dismiss = (a: Announcement) => {
    const next = [...dismissed, `${a.id}:${a.updatedAt}`].slice(-100);
    setDismissed(next);
    try {
      localStorage.setItem(DISMISSED_KEY, JSON.stringify(next));
    } catch {
      // Storage blocked; it stays dismissed for this visit.
    }
  };
  return (
    <div className="mb-6 flex flex-col gap-3">
      {visible.map((a) => (
        <div key={a.id} className={clsx('relative rounded-ui border px-5 py-4 pr-12 text-sm', bannerTones[a.tone])}>
          <p className="font-semibold">{a.title}</p>
          {a.body && <Markdown source={a.body} className="mt-1" />}
          <button className="absolute right-3 top-3 rounded p-1 text-muted hover:text-text" aria-label="Dismiss" onClick={() => dismiss(a)}>
            <X className="size-4" />
          </button>
        </div>
      ))}
    </div>
  );
}

function useResources(server: ClientServerSummary, enabled: boolean) {
  return useQuery({
    queryKey: ['server', server.id, 'resources'],
    queryFn: () => api.get<ServerResourceUsage>(`/client/servers/${server.id}/resources`),
    enabled: enabled && server.status === 'ACTIVE',
    refetchInterval: 15_000,
    retry: false,
  });
}

function StatusBadge({ server, usage }: { server: ClientServerSummary; usage?: ServerResourceUsage }) {
  if (server.status !== 'ACTIVE') return <ServerStatusBadge status={server.status} />;
  return usage ? <Badge tone={stateTone[usage.state]}>{usage.state}</Badge> : <Badge>unknown</Badge>;
}

function Stat({ icon, label, value, limit }: { icon: React.ReactNode; label: string; value: string; limit: string }) {
  return (
    <div className="rounded-ui bg-surface-alt px-2.5 py-2">
      <div className="flex items-center gap-1 text-muted">
        {icon}
        {label}
      </div>
      <div className="mt-1 font-medium">
        {value} <span className="text-muted">/ {limit}</span>
      </div>
    </div>
  );
}

/** Where players connect; servers behind a proxy are reached through it. */
function ServerAddress({ server }: { server: ClientServerSummary }) {
  if (server.network) {
    return (
      <span className="font-sans">
        via {server.network.proxyName}
        {server.network.name && <span className="font-mono"> · {server.network.name}</span>}
      </span>
    );
  }
  return (
    <>
      {server.address.ip}:{server.address.port}
    </>
  );
}

function ServerCard({ server }: { server: ClientServerSummary }) {
  const { branding } = useTheme();
  const opts = branding.dashboard;
  const t = useT();
  const { data: usage } = useResources(server, true);
  return (
    <Link
      to={`/server/${server.id}`}
      className="group flex flex-col gap-4 rounded-ui border border-border bg-surface p-5 transition hover:border-primary/50 hover:shadow-lg hover:shadow-primary/5"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <ServerLogo server={server} />
          <div className="min-w-0">
            <h3 className="truncate font-semibold group-hover:text-primary">{server.name}</h3>
            <p className="mt-0.5 truncate font-mono text-xs text-muted">
              <ServerAddress server={server} />
            </p>
          </div>
        </div>
        <StatusBadge server={server} usage={usage} />
      </div>
      {opts.showResources && (
        <div className="grid grid-cols-3 gap-2 text-xs">
          <Stat icon={<Cpu className="size-3.5" />} label={t('server.stats.cpu')} value={usage ? `${usage.cpu.toFixed(0)}%` : '—'} limit={server.limits.cpu ? `${server.limits.cpu}%` : '∞'} />
          <Stat icon={<MemoryStick className="size-3.5" />} label={t('server.stats.memory')} value={usage ? formatBytes(usage.memoryBytes, 0) : '—'} limit={formatMiB(server.limits.memory)} />
          <Stat icon={<HardDrive className="size-3.5" />} label={t('server.stats.disk')} value={usage ? formatBytes(usage.diskBytes, 0) : '—'} limit={formatMiB(server.limits.disk)} />
        </div>
      )}
      {(opts.showEgg || opts.showNode) && (
        <div className="flex items-center justify-between text-xs text-muted">
          <span>{opts.showEgg && server.egg}</span>
          <span>{opts.showNode && server.node}</span>
        </div>
      )}
    </Link>
  );
}

function ServerRow({ server }: { server: ClientServerSummary }) {
  const { branding } = useTheme();
  const opts = branding.dashboard;
  const { data: usage } = useResources(server, opts.showResources);
  return (
    <Link to={`/server/${server.id}`} className="flex flex-wrap items-center gap-x-6 gap-y-1 px-5 py-3 transition hover:bg-surface-alt/60">
      <ServerLogo server={server} size="sm" />
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{server.name}</div>
        <div className="truncate font-mono text-xs text-muted">
          <ServerAddress server={server} />
          {opts.showEgg && <span className="font-sans"> · {server.egg}</span>}
          {opts.showNode && <span className="font-sans"> · {server.node}</span>}
        </div>
      </div>
      {opts.showResources && usage && (
        <div className="hidden gap-5 text-xs tabular-nums text-muted sm:flex">
          <span>{usage.cpu.toFixed(0)}% CPU</span>
          <span>{formatBytes(usage.memoryBytes, 0)}</span>
          <span>{formatBytes(usage.diskBytes, 0)}</span>
        </div>
      )}
      <StatusBadge server={server} usage={usage} />
    </Link>
  );
}

function readLayout(): 'grid' | 'list' | null {
  try {
    const v = localStorage.getItem(LAYOUT_KEY);
    return v === 'grid' || v === 'list' ? v : null;
  } catch {
    return null;
  }
}

const bannerTones = {
  primary: 'border-primary/40 bg-primary/10',
  success: 'border-success/40 bg-success/10',
  warning: 'border-warning/40 bg-warning/10',
  danger: 'border-danger/40 bg-danger/10',
};

export function DashboardPage() {
  const { user } = useAuth();
  const { branding } = useTheme();
  const t = useT();
  const opts = branding.dashboard;
  const [search, setSearch] = useState('');
  const [scope, setScope] = useState<'mine' | 'all'>('mine');
  const [userLayout, setUserLayout] = useState(readLayout);
  const layout = opts.allowUserLayout && userLayout ? userLayout : opts.layout;
  const chooseLayout = (l: 'grid' | 'list') => {
    setUserLayout(l);
    try {
      localStorage.setItem(LAYOUT_KEY, l);
    } catch {
      // Storage blocked; keep it for this visit.
    }
  };

  const { data, isLoading } = useQuery({
    queryKey: ['servers', scope, search],
    queryFn: () => api.get<Paged<ClientServerSummary>>(`/client/servers?perPage=100&scope=${scope}&search=${encodeURIComponent(search)}`),
  });

  return (
    <>
      <PageHeader
        title={t('dashboard.title')}
        description={user ? t('dashboard.welcome', { name: user.firstName || user.username }) : undefined}
        actions={
          <>
            {user?.rootAdmin && (
              <div className="flex rounded-ui border border-border p-0.5 text-sm">
                {(['mine', 'all'] as const).map((s) => (
                  <button key={s} onClick={() => setScope(s)} className={clsx('rounded-[calc(var(--sl-radius)-2px)] px-3 py-1.5', scope === s ? 'bg-surface-alt text-text' : 'text-muted')}>
                    {s === 'mine' ? 'Mine' : 'All servers'}
                  </button>
                ))}
              </div>
            )}
            {opts.allowUserLayout && (
              <div className="flex rounded-ui border border-border p-0.5">
                <button onClick={() => chooseLayout('grid')} className={clsx('rounded p-1.5', layout === 'grid' ? 'bg-surface-alt text-text' : 'text-muted')} aria-label="Card layout">
                  <LayoutGrid className="size-4" />
                </button>
                <button onClick={() => chooseLayout('list')} className={clsx('rounded p-1.5', layout === 'list' ? 'bg-surface-alt text-text' : 'text-muted')} aria-label="List layout">
                  <List className="size-4" />
                </button>
              </div>
            )}
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
              <Input placeholder={t('dashboard.search')} value={search} onChange={(e) => setSearch(e.target.value)} className="w-56 pl-9" />
            </div>
          </>
        }
      />
      <Announcements />
      {opts.banner && (
        <div className={clsx('mb-6 rounded-ui border px-5 py-4 text-sm', bannerTones[opts.bannerTone])}>
          <Markdown source={opts.banner} />
        </div>
      )}
      {isLoading ? (
        <PageLoader />
      ) : data && data.data.length > 0 ? (
        layout === 'grid' ? (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {data.data.map((s) => (
              <ServerCard key={s.uuid} server={s} />
            ))}
          </div>
        ) : (
          <div className="divide-y divide-border overflow-hidden rounded-ui border border-border bg-surface">
            {data.data.map((s) => (
              <ServerRow key={s.uuid} server={s} />
            ))}
          </div>
        )
      ) : (
        <div className="rounded-ui border border-dashed border-border">
          <EmptyState icon={<ServerIcon className="size-8" />} title={t('dashboard.empty')}>
            {user?.rootAdmin ? (
              <>
                Create one from <Link to="/admin/servers/new" className="text-primary hover:underline">Admin → Servers</Link>.
              </>
            ) : (
              t('dashboard.emptyHint')
            )}
          </EmptyState>
        </div>
      )}
    </>
  );
}
