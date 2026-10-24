import { useCallback, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ResourceSample } from '@glacier/shared';
import { api } from '../../lib/api';
import { ResourceChart } from '../../features/server/ResourceChart';
import { Cpu, HardDrive, MemoryStick, Network, Play, RotateCw, Skull, Square, Timer } from 'lucide-react';
import type { PowerAction, ServerPermission } from '@glacier/shared';
import { formatBytes, formatMiB, formatUptime } from '../../lib/format';
import { Console } from '../../features/server/Console';
import { useServer } from '../../features/server/context';
import { useServerSocket, type Line } from '../../features/server/useServerSocket';
import { useT } from '../../theme/i18n';
import { Alert, Badge, Button, EmptyState } from '../../components/ui';

const statusTone = { running: 'success', starting: 'warning', stopping: 'warning', installing: 'warning', offline: 'neutral' } as const;

export function ConsoleTab() {
  const { server, can } = useServer();
  if (!can('control.console')) return <EmptyState title="You don't have access to this server's console." />;
  return <ConsoleView key={server.id} />;
}

function ConsoleView() {
  const { server, can } = useServer();
  const writer = useRef<((line: Line) => void) | null>(null);
  const buffer = useRef<Line[]>([]);
  const onLine = useCallback((line: Line) => {
    if (writer.current) writer.current(line);
    else buffer.current.push(line);
  }, []);
  const register = useCallback((write: (line: Line) => void) => {
    writer.current = write;
    buffer.current.splice(0).forEach(write);
  }, []);

  const { socketState, status, stats, error, power, command } = useServerSocket(server.id, onLine);
  const t = useT();
  const busy = status === 'installing' || server.status !== 'ACTIVE';

  const powerButton = (action: PowerAction, label: string, icon: React.ReactNode, variant: 'primary' | 'secondary' | 'danger', disabled: boolean) =>
    can(`control.${action}` as ServerPermission) && (
      <Button variant={variant} size="sm" icon={icon} disabled={disabled || busy || socketState !== 'connected'} onClick={() => power(action)}>
        {label}
      </Button>
    );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Badge tone={statusTone[status as keyof typeof statusTone] ?? 'neutral'}>{socketState === 'connected' ? status : 'connecting…'}</Badge>
        <div className="flex flex-wrap gap-2">
          {powerButton('start', t('server.power.start'), <Play className="size-4" />, 'primary', status !== 'offline')}
          {powerButton('restart', t('server.power.restart'), <RotateCw className="size-4" />, 'secondary', status === 'offline')}
          {powerButton('stop', t('server.power.stop'), <Square className="size-4" />, 'secondary', status === 'offline' || status === 'stopping')}
          {powerButton('kill', t('server.power.kill'), <Skull className="size-4" />, 'danger', status === 'offline')}
        </div>
      </div>

      {socketState !== 'connected' && socketState !== 'connecting' && (
        <Alert tone="warning">
          Can't reach the node's console{error ? `: ${error}` : ''}. Retrying… If this keeps happening, the daemon may be offline or its certificate
          untrusted by your browser.
        </Alert>
      )}

      <div className="grid gap-6 xl:grid-cols-[1fr_18rem]">
        <Console register={register} onCommand={command} canCommand={can('control.command') && status !== 'offline'} placeholder={t('server.console.placeholder')} />
        <div className="grid content-start gap-3 sm:grid-cols-2 xl:grid-cols-1">
          <StatTile icon={<Timer className="size-4" />} label={t('server.stats.uptime')} value={stats ? formatUptime(stats.uptimeMs) : '—'} />
          <StatTile
            icon={<Cpu className="size-4" />}
            label={t('server.stats.cpu')}
            value={stats ? `${stats.cpu.toFixed(1)}%` : '—'}
            limit={server.limits.cpu ? `${server.limits.cpu}%` : 'Unlimited'}
            pct={stats && server.limits.cpu ? stats.cpu / server.limits.cpu : undefined}
          />
          <StatTile
            icon={<MemoryStick className="size-4" />}
            label={t('server.stats.memory')}
            value={stats ? formatBytes(stats.memoryBytes) : '—'}
            limit={formatMiB(server.limits.memory)}
            pct={stats && server.limits.memory ? stats.memoryBytes / (server.limits.memory * 1048576) : undefined}
          />
          <StatTile
            icon={<HardDrive className="size-4" />}
            label={t('server.stats.disk')}
            value={stats ? formatBytes(stats.diskBytes) : '—'}
            limit={formatMiB(server.limits.disk)}
            pct={stats && server.limits.disk ? stats.diskBytes / (server.limits.disk * 1048576) : undefined}
          />
          <StatTile icon={<Network className="size-4" />} label={t('server.stats.network')} value={stats ? `↓ ${formatBytes(stats.networkRxBytes)}  ↑ ${formatBytes(stats.networkTxBytes)}` : '—'} />
        </div>
      </div>
      <History />
    </div>
  );
}

/** CPU and memory over the last hour (kept by the node in memory). */
function History() {
  const { server, base } = useServer();
  const t = useT();
  const { data } = useQuery({
    queryKey: ['server', server.id, 'history'],
    queryFn: () => api.get<{ data: ResourceSample[] }>(`${base}/stats/history`).then((r) => r.data),
    refetchInterval: 30_000,
    retry: false,
  });
  if (!data) return null;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <ResourceChart samples={data} label={t('server.stats.cpu')} value={(s) => s.cpu} format={(v) => `${v.toFixed(0)}%`} max={server.limits.cpu || undefined} />
      <ResourceChart
        samples={data}
        label={t('server.stats.memory')}
        value={(s) => s.memoryBytes}
        format={(v) => formatBytes(v, 1)}
        max={server.limits.memory ? server.limits.memory * 1048576 : undefined}
      />
    </div>
  );
}

function StatTile({ icon, label, value, limit, pct }: { icon: React.ReactNode; label: string; value: string; limit?: string; pct?: number }) {
  const tone = pct === undefined ? 'bg-primary' : pct > 0.9 ? 'bg-danger' : pct > 0.7 ? 'bg-warning' : 'bg-primary';
  return (
    <div className="rounded-ui border border-border bg-surface p-4">
      <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted">
        {icon}
        {label}
      </div>
      <div className="mt-2 text-lg font-semibold tabular-nums">{value}</div>
      {limit && <div className="text-xs text-muted">of {limit}</div>}
      {pct !== undefined && (
        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-surface-alt">
          <div className={`h-full rounded-full transition-all ${tone}`} style={{ width: `${Math.min(100, pct * 100)}%` }} />
        </div>
      )}
    </div>
  );
}
