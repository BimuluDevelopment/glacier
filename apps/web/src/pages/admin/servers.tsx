import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Search, Server as ServerIcon } from 'lucide-react';
import { api, ApiError, type Paged } from '../../lib/api';
import { formatDate, formatMiB } from '../../lib/format';
import type { ServerStatus } from '../../lib/types';
import { Alert, Button, Card, EmptyState, Field, Input, PageHeader, PageLoader, Select, ServerStatusBadge, Switch, Table, Td } from '../../components/ui';
import { useNodes } from './nodes';
import { useNests, type EggDetail } from './eggs';
import { useTemplates, type ServerTemplate } from './templates';
import { proxyType } from '@glacier/shared';
import { ServerLogo } from '../../components/ServerLogo';

interface AdminServerRow {
  id: number;
  uuid: string;
  shortId: string;
  name: string;
  status: ServerStatus;
  iconVersion: number;
  memory: number;
  disk: number;
  cpu: number;
  createdAt: string;
  owner: { id: string; username: string; email: string };
  node: { id: number; name: string };
  egg: { id: number; name: string };
  allocation: { ip: string; ipAlias: string | null; port: number };
}

export function ServersPage() {
  const [search, setSearch] = useState('');
  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'servers', search],
    queryFn: () => api.get<Paged<AdminServerRow>>(`/admin/servers?perPage=100&search=${encodeURIComponent(search)}`),
  });
  return (
    <>
      <PageHeader
        title="Servers"
        actions={
          <>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
              <Input placeholder="Name, id or owner" className="w-60 pl-9" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
            <Link to="/admin/servers/new">
              <Button icon={<Plus className="size-4" />}>New server</Button>
            </Link>
          </>
        }
      />
      <Card padded={false}>
        {isLoading ? (
          <PageLoader />
        ) : !data?.data.length ? (
          <EmptyState icon={<ServerIcon className="size-8" />} title="No servers">
            Create a server once you have a paired node with free allocations.
          </EmptyState>
        ) : (
          <Table head={['Server', 'Owner', 'Node', 'Address', 'Limits', 'Status']}>
            {data.data.map((s) => (
              <tr key={s.id} className="hover:bg-surface-alt/50">
                <Td>
                  <div className="flex items-center gap-3">
                    <ServerLogo server={{ id: s.shortId, name: s.name, iconVersion: s.iconVersion }} size="sm" />
                    <div className="min-w-0">
                      <Link to={`/admin/servers/${s.id}`} className="font-medium hover:text-primary">
                        {s.name}
                      </Link>
                      <div className="font-mono text-xs text-muted">
                        {s.shortId} · {s.egg.name}
                      </div>
                    </div>
                  </div>
                </Td>
                <Td>{s.owner.username}</Td>
                <Td>{s.node.name}</Td>
                <Td className="font-mono text-xs">
                  {s.allocation.ipAlias ?? s.allocation.ip}:{s.allocation.port}
                </Td>
                <Td className="text-xs text-muted">
                  {formatMiB(s.memory)} · {formatMiB(s.disk)} · {s.cpu ? `${s.cpu}%` : '∞'} CPU
                </Td>
                <Td>
                  <ServerStatusBadge status={s.status} />
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
}

interface UserOption {
  id: string;
  username: string;
  email: string;
}
interface AllocationOption {
  id: number;
  ip: string;
  ipAlias: string | null;
  port: number;
  server: unknown;
}

export function CreateServerPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data: nodes } = useNodes();
  const { data: nests } = useNests();
  const { data: users } = useQuery({ queryKey: ['admin', 'users', 'options'], queryFn: () => api.get<Paged<UserOption>>('/admin/users?perPage=100').then((r) => r.data) });

  const [v, setV] = useState({
    name: '',
    description: '',
    ownerId: '',
    nodeId: '',
    allocationId: '',
    additionalAllocationIds: [] as number[],
    eggId: '',
    image: '',
    startup: '',
    memory: '2048',
    swap: '0',
    disk: '10240',
    cpu: '200',
    io: '500',
    databaseLimit: '0',
    allocationLimit: '0',
    backupLimit: '2',
    startOnCompletion: true,
  });
  // Stable across renders so effects can depend on it.
  const set = useCallback(<K extends keyof typeof v>(k: K, value: (typeof v)[K]) => setV((cur) => ({ ...cur, [k]: value })), []);
  const [environment, setEnvironment] = useState<Record<string, string>>({});
  // Variable values from a chosen template, applied once its egg's defaults have loaded.
  const [templateEnv, setTemplateEnv] = useState<Record<string, string>>({});
  const { data: templates } = useTemplates();
  const applyTemplate = (t: ServerTemplate) => {
    setTemplateEnv(t.environment);
    setV((cur) => ({
      ...cur,
      eggId: String(t.eggId),
      memory: String(t.memory),
      swap: String(t.swap),
      disk: String(t.disk),
      cpu: String(t.cpu),
      io: String(t.io),
      databaseLimit: String(t.databaseLimit),
      allocationLimit: String(t.allocationLimit),
      backupLimit: String(t.backupLimit),
    }));
  };

  const paired = useMemo(() => nodes?.filter((n) => n.paired && !n.maintenance) ?? [], [nodes]);
  useEffect(() => {
    if (!v.nodeId && paired[0]) set('nodeId', String(paired[0].id));
  }, [paired, v.nodeId, set]);
  useEffect(() => {
    if (!v.ownerId && users?.[0]) set('ownerId', users[0].id);
  }, [users, v.ownerId, set]);
  useEffect(() => {
    const first = nests?.flatMap((n) => n.eggs)[0];
    if (!v.eggId && first) set('eggId', String(first.id));
  }, [nests, v.eggId, set]);

  const { data: allocations } = useQuery({
    queryKey: ['admin', 'node', v.nodeId, 'allocations'],
    queryFn: () => api.get<{ data: AllocationOption[] }>(`/admin/nodes/${v.nodeId}/allocations`).then((r) => r.data.filter((a) => !a.server)),
    enabled: Boolean(v.nodeId),
  });
  useEffect(() => {
    if (allocations && !allocations.some((a) => String(a.id) === v.allocationId)) set('allocationId', allocations[0] ? String(allocations[0].id) : '');
  }, [allocations, v.allocationId, set]);

  const { data: egg } = useQuery({ queryKey: ['admin', 'egg', v.eggId], queryFn: () => api.get<EggDetail>(`/admin/eggs/${v.eggId}`), enabled: Boolean(v.eggId) });
  useEffect(() => {
    if (!egg) return;
    setEnvironment({ ...Object.fromEntries(egg.variables.map((x) => [x.envVariable, x.defaultValue])), ...templateEnv });
    setV((cur) => ({ ...cur, image: Object.values(egg.dockerImages)[0] ?? '', startup: egg.startup }));
  }, [egg, templateEnv]);

  const create = useMutation({
    mutationFn: () =>
      api.post<{ id: number }>('/admin/servers', {
        name: v.name,
        description: v.description || null,
        ownerId: v.ownerId,
        eggId: Number(v.eggId),
        allocationId: Number(v.allocationId),
        additionalAllocationIds: v.additionalAllocationIds,
        image: v.image,
        startup: v.startup,
        environment,
        memory: Number(v.memory),
        swap: Number(v.swap),
        disk: Number(v.disk),
        cpu: Number(v.cpu),
        io: Number(v.io),
        databaseLimit: Number(v.databaseLimit),
        allocationLimit: Number(v.allocationLimit),
        backupLimit: Number(v.backupLimit),
        startOnCompletion: v.startOnCompletion,
      }),
    onSuccess: (server) => {
      void qc.invalidateQueries({ queryKey: ['admin', 'servers'] });
      navigate(`/admin/servers/${server.id}`);
    },
  });
  const err = create.error instanceof ApiError ? create.error : null;
  const fieldError = (k: string) => err?.field(k);

  if (nodes && paired.length === 0) {
    return (
      <>
        <PageHeader title="New server" />
        <Alert tone="warning">
          You need a paired node first. <Link to="/admin/nodes" className="underline">Set one up</Link>.
        </Alert>
      </>
    );
  }

  const num = (k: keyof typeof v) => ({ type: 'number', value: v[k] as string, onChange: (e: { target: { value: string } }) => set(k, e.target.value as never) });

  return (
    <>
      <PageHeader title="New server" description="Pick an owner, a node and an egg; the daemon installs it right away." />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
        className="flex flex-col gap-6"
      >
        {create.error && <Alert>{create.error.message}</Alert>}
        {templates && templates.length > 0 && (
          <Card title="Start from a template">
            <div className="flex flex-wrap gap-2">
              {templates.map((t) => (
                <Button key={t.id} type="button" size="sm" variant="secondary" onClick={() => applyTemplate(t)} title={t.description}>
                  {t.name}
                </Button>
              ))}
            </div>
          </Card>
        )}
        <Card title="Basics">
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Name" error={fieldError('name')}>{(id) => <Input id={id} required value={v.name} onChange={(e) => set('name', e.target.value)} placeholder="Survival SMP" />}</Field>
            <Field label="Owner" error={fieldError('ownerId')}>
              {(id) => (
                <Select id={id} value={v.ownerId} onChange={(e) => set('ownerId', e.target.value)}>
                  {users?.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.username} ({u.email})
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Description" className="md:col-span-2">{(id) => <Input id={id} value={v.description} onChange={(e) => set('description', e.target.value)} />}</Field>
          </div>
        </Card>

        <Card title="Placement">
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Node">
              {(id) => (
                <Select id={id} value={v.nodeId} onChange={(e) => setV((cur) => ({ ...cur, nodeId: e.target.value, allocationId: '', additionalAllocationIds: [] }))}>
                  {paired.map((n) => (
                    <option key={n.id} value={n.id}>
                      {n.name} ({n.location.short})
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Primary allocation" error={fieldError('allocationId')} hint={allocations && allocations.length === 0 ? 'No free allocations on this node. Add some on the node page.' : undefined}>
              {(id) => (
                <Select id={id} required value={v.allocationId} onChange={(e) => set('allocationId', e.target.value)}>
                  {allocations?.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.ipAlias ?? a.ip}:{a.port}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            {allocations && allocations.length > 1 && (
              <Field label="Additional allocations" className="md:col-span-2" hint="Ctrl/Cmd-click to select several.">
                {(id) => (
                  <select
                    id={id}
                    multiple
                    className="h-28 w-full rounded-ui border border-border bg-bg p-2 text-sm"
                    value={v.additionalAllocationIds.map(String)}
                    onChange={(e) => set('additionalAllocationIds', Array.from(e.target.selectedOptions, (o) => Number(o.value)))}
                  >
                    {allocations
                      .filter((a) => String(a.id) !== v.allocationId)
                      .map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.ipAlias ?? a.ip}:{a.port}
                        </option>
                      ))}
                  </select>
                )}
              </Field>
            )}
          </div>
        </Card>

        <Card title="Resources">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
            <Field label="Memory (MiB)" hint="0 = unlimited" error={fieldError('memory')}>{(id) => <Input id={id} min={0} {...num('memory')} />}</Field>
            <Field label="Swap (MiB)" hint="-1 = unlimited">{(id) => <Input id={id} min={-1} {...num('swap')} />}</Field>
            <Field label="Disk (MiB)" hint="0 = unlimited" error={fieldError('disk')}>{(id) => <Input id={id} min={0} {...num('disk')} />}</Field>
            <Field label="CPU (%)" hint="100 = one core">{(id) => <Input id={id} min={0} {...num('cpu')} />}</Field>
            <Field label="Block IO weight" hint="10–1000">{(id) => <Input id={id} min={10} max={1000} {...num('io')} />}</Field>
            <Field label="Databases">{(id) => <Input id={id} min={0} {...num('databaseLimit')} />}</Field>
            <Field label="Extra allocations">{(id) => <Input id={id} min={0} {...num('allocationLimit')} />}</Field>
            <Field label="Backups">{(id) => <Input id={id} min={0} {...num('backupLimit')} />}</Field>
          </div>
        </Card>

        <Card title="Software">
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Egg">
              {(id) => (
                <Select id={id} value={v.eggId} onChange={(e) => set('eggId', e.target.value)}>
                  {nests?.map((n) => (
                    <optgroup key={n.id} label={n.name}>
                      {n.eggs.map((e) => (
                        <option key={e.id} value={e.id}>
                          {e.name}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Docker image">
              {(id) => (
                <Select id={id} value={v.image} onChange={(e) => set('image', e.target.value)}>
                  {egg &&
                    Object.entries(egg.dockerImages).map(([label, image]) => (
                      <option key={image} value={image}>
                        {label} — {image}
                      </option>
                    ))}
                </Select>
              )}
            </Field>
            <Field label="Startup command" className="md:col-span-2">
              {(id) => <Input id={id} className="font-mono text-xs" value={v.startup} onChange={(e) => set('startup', e.target.value)} />}
            </Field>
            {egg?.variables.map((x) => (
              <Field key={x.id} label={x.name} hint={x.description} error={fieldError(x.envVariable)}>
                {(id) => <Input id={id} value={environment[x.envVariable] ?? ''} onChange={(e) => setEnvironment((env) => ({ ...env, [x.envVariable]: e.target.value }))} />}
              </Field>
            ))}
          </div>
        </Card>

        <div className="flex flex-wrap items-center justify-between gap-4">
          <Switch checked={v.startOnCompletion} onChange={(x) => set('startOnCompletion', x)} label="Start after installing" />
          <Button type="submit" loading={create.isPending} disabled={!v.allocationId || !v.eggId || !v.ownerId}>
            Create server
          </Button>
        </div>
      </form>
    </>
  );
}

interface AdminServerDetail extends AdminServerRow {
  description: string | null;
  swap: number;
  io: number;
  threads: string | null;
  oomKiller: boolean;
  image: string;
  startup: string;
  databaseLimit: number;
  allocationLimit: number;
  backupLimit: number;
  networkServerLimit: number;
  networkMemoryLimit: number;
  networkDiskLimit: number;
  networkCpuLimit: number;
  installedAt: string | null;
}

export function ServerDetailPage() {
  const { id } = useParams();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const key = ['admin', 'server', id];
  const { data: s, isLoading } = useQuery({ queryKey: key, queryFn: () => api.get<AdminServerDetail>(`/admin/servers/${id}`), refetchInterval: (q) => (q.state.data?.status === 'INSTALLING' ? 3000 : false) });
  const refresh = () => qc.invalidateQueries({ queryKey: key });
  const action = useMutation({
    mutationFn: (path: 'suspend' | 'unsuspend' | 'reinstall') => api.post(`/admin/servers/${id}/${path}`),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (force: boolean) => api.delete(`/admin/servers/${id}${force ? '?force=true' : ''}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin', 'servers'] });
      navigate('/admin/servers');
    },
  });

  const [build, setBuild] = useState<Record<string, string>>({});
  useEffect(() => {
    if (s) setBuild({ memory: String(s.memory), swap: String(s.swap), disk: String(s.disk), cpu: String(s.cpu), io: String(s.io), databaseLimit: String(s.databaseLimit), allocationLimit: String(s.allocationLimit), backupLimit: String(s.backupLimit), networkServerLimit: String(s.networkServerLimit), networkMemoryLimit: String(s.networkMemoryLimit), networkDiskLimit: String(s.networkDiskLimit), networkCpuLimit: String(s.networkCpuLimit) });
  }, [s]);
  const saveBuild = useMutation({
    mutationFn: () => api.patch(`/admin/servers/${id}/build`, Object.fromEntries(Object.entries(build).map(([k, val]) => [k, Number(val)]))),
    onSuccess: refresh,
  });

  if (isLoading || !s) return <PageLoader />;
  const error = action.error ?? remove.error ?? saveBuild.error;

  return (
    <>
      <PageHeader
        title={s.name}
        description={
          <span>
            <span className="font-mono">{s.uuid}</span> · created {formatDate(s.createdAt)}
          </span>
        }
        actions={
          <>
            <Link to={`/server/${s.shortId}`}>
              <Button variant="secondary">Open console</Button>
            </Link>
            {s.status === 'SUSPENDED' ? (
              <Button variant="secondary" loading={action.isPending} onClick={() => action.mutate('unsuspend')}>
                Unsuspend
              </Button>
            ) : (
              <Button variant="secondary" loading={action.isPending} onClick={() => action.mutate('suspend')}>
                Suspend
              </Button>
            )}
            <Button variant="secondary" disabled={s.status === 'INSTALLING'} onClick={() => confirm('Reinstall this server? The install script runs again over the existing files.') && action.mutate('reinstall')}>
              Reinstall
            </Button>
          </>
        }
      />
      {error && (
        <div className="mb-4">
          <Alert>{error.message}</Alert>
        </div>
      )}
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Details">
          <dl className="grid grid-cols-2 gap-y-2.5 text-sm">
            <dt className="text-muted">Status</dt>
            <dd>
              <ServerStatusBadge status={s.status} />
            </dd>
            <dt className="text-muted">Owner</dt>
            <dd>{s.owner.username}</dd>
            <dt className="text-muted">Node</dt>
            <dd>
              <Link to={`/admin/nodes/${s.node.id}`} className="hover:text-primary">
                {s.node.name}
              </Link>
            </dd>
            <dt className="text-muted">Address</dt>
            <dd className="font-mono text-xs">
              {s.allocation.ipAlias ?? s.allocation.ip}:{s.allocation.port}
            </dd>
            <dt className="text-muted">Egg</dt>
            <dd>
              <Link to={`/admin/eggs/${s.egg.id}`} className="hover:text-primary">
                {s.egg.name}
              </Link>
            </dd>
            <dt className="text-muted">Image</dt>
            <dd className="truncate font-mono text-xs" title={s.image}>
              {s.image}
            </dd>
            <dt className="text-muted">Installed</dt>
            <dd>{s.installedAt ? formatDate(s.installedAt) : '—'}</dd>
          </dl>
        </Card>
        <Card title="Limits">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              ['memory', 'Memory (MiB)'],
              ['swap', 'Swap (MiB)'],
              ['disk', 'Disk (MiB)'],
              ['cpu', 'CPU (%)'],
              ['io', 'IO weight'],
              ['databaseLimit', 'Databases'],
              ['allocationLimit', 'Allocations'],
              ['backupLimit', 'Backups'],
            ].map(([k, label]) => (
              <Field key={k} label={label!}>
                {(fid) => <Input id={fid} type="number" value={build[k!] ?? ''} onChange={(e) => setBuild((b) => ({ ...b, [k!]: e.target.value }))} />}
              </Field>
            ))}
          </div>
          <div className="mt-4 flex items-center gap-3">
            <Button loading={saveBuild.isPending} onClick={() => saveBuild.mutate()}>
              Save limits
            </Button>
            {saveBuild.isSuccess && <span className="text-sm text-success">Saved and synced to the node.</span>}
          </div>
        </Card>
        {proxyType(s.egg.name) && (
          <Card title="Proxy network" className="lg:col-span-2">
            <p className="mb-4 text-sm text-muted">
              What the owner may add to this proxy&apos;s network themselves from its Proxy tab. 0 servers means only admins can add servers; 0 memory, disk or CPU means no extra limit (the
              node&apos;s capacity still applies). Saved with <em>Save limits</em> above.
            </p>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                ['networkServerLimit', 'Servers'],
                ['networkMemoryLimit', 'Memory in total (MiB)'],
                ['networkDiskLimit', 'Disk in total (MiB)'],
                ['networkCpuLimit', 'CPU in total (%)'],
              ].map(([k, label]) => (
                <Field key={k} label={label!}>
                  {(fid) => <Input id={fid} type="number" min={0} value={build[k!] ?? ''} onChange={(e) => setBuild((b) => ({ ...b, [k!]: e.target.value }))} />}
                </Field>
              ))}
            </div>
          </Card>
        )}
        <Card title="Danger zone" className="border-danger/40 lg:col-span-2">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <p className="text-sm text-muted">Deleting removes the container and every file of this server from the node.</p>
            <div className="flex gap-2">
              {remove.error && (
                <Button variant="secondary" loading={remove.isPending} onClick={() => confirm('Delete from the panel even though the node could not be reached? Files may remain on the node.') && remove.mutate(true)}>
                  Force delete
                </Button>
              )}
              <Button variant="danger" loading={remove.isPending} onClick={() => confirm(`Permanently delete ${s.name} and all of its files?`) && remove.mutate(false)}>
                Delete server
              </Button>
            </div>
          </div>
        </Card>
      </div>
    </>
  );
}
