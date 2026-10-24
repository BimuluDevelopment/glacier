import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Boxes, Egg, Server, Users } from 'lucide-react';
import type { DaemonSystemInfo } from '@glacier/shared';
import { api } from '../../lib/api';
import { formatBytes, timeAgo } from '../../lib/format';
import type { ActivityEntry } from '../../lib/types';
import { ActivityTable } from '../account';
import { Badge, Card, EmptyState, PageHeader, PageLoader } from '../../components/ui';

interface Overview {
  version: string;
  counts: { users: number; servers: number; nodes: number; eggs: number };
  serversByStatus: Record<string, number>;
  nodes: { id: number; name: string; state: 'online' | 'offline' | 'unpaired'; info?: DaemonSystemInfo; lastSeenAt?: string | null }[];
  recentActivity: ActivityEntry[];
}

export function OverviewPage() {
  const { data, isLoading } = useQuery({ queryKey: ['admin', 'overview'], queryFn: () => api.get<Overview>('/admin/overview'), refetchInterval: 30_000 });
  if (isLoading || !data) return <PageLoader />;

  const tiles = [
    { label: 'Servers', value: data.counts.servers, icon: Server, to: '/admin/servers' },
    { label: 'Users', value: data.counts.users, icon: Users, to: '/admin/users' },
    { label: 'Nodes', value: data.counts.nodes, icon: Boxes, to: '/admin/nodes' },
    { label: 'Eggs', value: data.counts.eggs, icon: Egg, to: '/admin/eggs' },
  ];

  return (
    <>
      <PageHeader title="Overview" description={`Glacier Panel v${data.version}`} />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {tiles.map(({ label, value, icon: Icon, to }) => (
          <Link key={label} to={to} className="rounded-ui border border-border bg-surface p-5 transition hover:border-primary/50">
            <div className="flex items-center justify-between text-muted">
              <span className="text-sm">{label}</span>
              <Icon className="size-4" />
            </div>
            <div className="mt-2 text-3xl font-semibold tabular-nums">{value}</div>
          </Link>
        ))}
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-[22rem_1fr]">
        <Card title="Nodes" padded={false}>
          {data.nodes.length === 0 ? (
            <EmptyState title="No nodes yet">
              <Link to="/admin/nodes" className="text-primary hover:underline">
                Add your first node
              </Link>{' '}
              to start hosting servers.
            </EmptyState>
          ) : (
            <ul className="divide-y divide-border">
              {data.nodes.map((n) => (
                <li key={n.id}>
                  <Link to={`/admin/nodes/${n.id}`} className="flex items-center justify-between gap-3 px-5 py-3 hover:bg-surface-alt">
                    <div className="min-w-0">
                      <p className="truncate font-medium">{n.name}</p>
                      <p className="text-xs text-muted">
                        {n.info
                          ? `${n.info.servers} servers · ${n.info.cpuCount} CPU · ${formatBytes(n.info.memoryTotal, 0)}`
                          : n.lastSeenAt
                            ? `Last seen ${timeAgo(n.lastSeenAt)}`
                            : n.state === 'unpaired'
                              ? 'Waiting for daemon to pair'
                              : 'Never seen'}
                      </p>
                    </div>
                    <Badge tone={n.state === 'online' ? 'success' : n.state === 'offline' ? 'danger' : 'warning'}>{n.state}</Badge>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Recent activity" padded={false} actions={<Link to="/admin/activity" className="text-xs text-primary hover:underline">View all</Link>}>
          <ActivityTable rows={data.recentActivity} />
        </Card>
      </div>
    </>
  );
}

export function ActivityPage() {
  const { data, isLoading } = useQuery({ queryKey: ['admin', 'activity'], queryFn: () => api.get<{ data: ActivityEntry[] }>('/admin/overview/activity') });
  return (
    <>
      <PageHeader title="Activity" description="Audit log of sign-ins and changes across the panel." />
      <Card padded={false}>{isLoading ? <PageLoader /> : <ActivityTable rows={data?.data ?? []} showServer />}</Card>
    </>
  );
}
