import { NavLink, Outlet, useParams } from 'react-router';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { ArrowLeft } from 'lucide-react';
import type { ServerPermission, StringKey } from '@glacier/shared';
import { useT } from '../../theme/i18n';
import { useTheme } from '../../theme/ThemeProvider';
import { api } from '../../lib/api';
import type { ClientServer } from '../../lib/types';
import { makeServerContext } from '../../features/server/context';
import { Alert, PageLoader, ServerStatusBadge } from '../../components/ui';

const TABS: { to: string; label: StringKey; permission: ServerPermission | ServerPermission[] }[] = [
  { to: '', label: 'server.tab.console', permission: 'control.console' },
  { to: 'files', label: 'server.tab.files', permission: 'file.read' },
  { to: 'databases', label: 'server.tab.databases', permission: 'database.read' },
  { to: 'schedules', label: 'server.tab.schedules', permission: 'schedule.read' },
  { to: 'users', label: 'server.tab.users', permission: 'user.read' },
  { to: 'backups', label: 'server.tab.backups', permission: 'backup.read' },
  { to: 'network', label: 'server.tab.network', permission: 'allocation.read' },
  { to: 'startup', label: 'server.tab.startup', permission: 'startup.read' },
  { to: 'settings', label: 'server.tab.settings', permission: ['settings.rename', 'settings.reinstall', 'file.sftp'] },
  { to: 'activity', label: 'server.tab.activity', permission: 'activity.read' },
];

/** Tabs that only make sense for Minecraft: Java servers. */
const MINECRAFT_TABS: typeof TABS = [
  { to: 'plugins', label: 'server.tab.plugins', permission: 'plugins.read' },
  { to: 'players', label: 'server.tab.players', permission: 'players.read' },
];
const isMinecraft = (eggName: string) => /minecraft|paper|purpur|spigot|bukkit|fabric|forge|quilt|folia|velocity/i.test(eggName);

export function ServerLayout() {
  const { id = '' } = useParams();
  const t = useT();
  const { branding } = useTheme();
  const { data: server, isLoading, error } = useQuery({
    queryKey: ['server', id],
    queryFn: () => api.get<ClientServer>(`/client/servers/${id}`),
    refetchInterval: (q) => (q.state.data?.status === 'INSTALLING' ? 5_000 : false),
  });

  if (isLoading) return <PageLoader />;
  if (error || !server) return <Alert>{(error as Error)?.message ?? 'Server not found.'}</Alert>;

  const ctx = makeServerContext(server);
  const available = isMinecraft(server.egg.name)
    ? [TABS[0]!, TABS[1]!, ...MINECRAFT_TABS.filter((tab) => tab.to !== 'plugins' || branding.features.plugins), ...TABS.slice(2)]
    : TABS;
  const tabs = available.filter((t) => (Array.isArray(t.permission) ? t.permission.some(ctx.can) : ctx.can(t.permission)));
  const primary = server.allocations.find((a) => a.primary);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link to="/" className="mb-2 inline-flex items-center gap-1 text-sm text-muted hover:text-text">
          <ArrowLeft className="size-3.5" /> Servers
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{server.name}</h1>
          {server.status !== 'ACTIVE' && <ServerStatusBadge status={server.status} />}
        </div>
        {primary && (
          <p className="mt-1 font-mono text-sm text-muted">
            {primary.alias ?? primary.ip}:{primary.port}
          </p>
        )}
      </div>

      <nav className="-mb-2 flex gap-1 overflow-x-auto border-b border-border">
        {tabs.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            end={tab.to === ''}
            className={({ isActive }) =>
              clsx(
                '-mb-px shrink-0 border-b-2 px-3 py-2.5 text-sm font-medium transition',
                isActive ? 'border-primary text-text' : 'border-transparent text-muted hover:text-text',
              )
            }
          >
            {t(tab.label)}
          </NavLink>
        ))}
      </nav>

      {server.status === 'SUSPENDED' && <Alert>This server is suspended. Contact support if you think this is a mistake.</Alert>}
      {(server.status === 'INSTALL_FAILED' || server.status === 'REINSTALL_FAILED') && (
        <Alert>The last installation failed. Check the console for details, then reinstall from Settings.</Alert>
      )}

      <Outlet context={ctx} />
    </div>
  );
}
