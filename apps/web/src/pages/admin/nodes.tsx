import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Boxes, Plus, Trash2 } from 'lucide-react';
import type { DaemonSystemInfo } from '@glacier/shared';
import { api } from '../../lib/api';
import { useForm } from '../../lib/forms';
import { formatBytes, formatMiB, timeAgo } from '../../lib/format';
import { Alert, Badge, Button, Card, CopyField, EmptyState, Field, Input, Modal, PageHeader, PageLoader, Select, Switch, Table, Td } from '../../components/ui';
import { useLocations } from './locations';

export interface AdminNode {
  id: number;
  uuid: string;
  name: string;
  description: string | null;
  locationId: number;
  fqdn: string;
  scheme: 'http' | 'https';
  behindProxy: boolean;
  public: boolean;
  maintenance: boolean;
  daemonPort: number;
  sftpPort: number;
  memory: number;
  memoryOverallocate: number;
  disk: number;
  diskOverallocate: number;
  uploadSize: number;
  dataDirectory: string;
  paired: boolean;
  pairedAt: string | null;
  lastSeenAt: string | null;
  location: { short: string };
  serverCount?: number;
  allocationCount?: number;
  allocatedMemory?: number;
  allocatedDisk?: number;
}

interface Pairing {
  token: string;
  expiresAt: string;
  command: string;
  installCommand: string;
}

export function useNodes() {
  return useQuery({ queryKey: ['admin', 'nodes'], queryFn: () => api.get<{ data: AdminNode[] }>('/admin/nodes').then((r) => r.data) });
}

function UsageBar({ used, total }: { used: number; total: number }) {
  const pct = total ? Math.min(100, (used / total) * 100) : 0;
  return (
    <div className="w-32">
      <div className="text-xs text-muted">
        {formatMiB(used)} / {formatMiB(total)}
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-alt">
        <div className={`h-full rounded-full ${pct > 90 ? 'bg-danger' : pct > 70 ? 'bg-warning' : 'bg-primary'}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function NodesPage() {
  const { data, isLoading } = useNodes();
  const [creating, setCreating] = useState(false);
  const [params] = useSearchParams();
  const welcome = params.get('welcome') === '1';

  return (
    <>
      <PageHeader
        title="Nodes"
        description="Machines that run game servers. Each one runs the glacierd daemon."
        actions={
          <Button icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
            New node
          </Button>
        }
      />
      {welcome && (
        <div className="mb-6">
          <Alert tone="primary">Your panel is ready. Next step: add a node, then run the pairing command on that machine.</Alert>
        </div>
      )}
      <Card padded={false}>
        {isLoading ? (
          <PageLoader />
        ) : !data?.length ? (
          <EmptyState icon={<Boxes className="size-8" />} title="No nodes yet">
            A node is any Linux machine with Docker. Create one here, then paste the pairing command on it.
          </EmptyState>
        ) : (
          <Table head={['Node', 'Location', 'Memory', 'Disk', 'Servers', 'Status']}>
            {data.map((n) => (
              <tr key={n.id} className="hover:bg-surface-alt/50">
                <Td>
                  <Link to={`/admin/nodes/${n.id}`} className="font-medium hover:text-primary">
                    {n.name}
                  </Link>
                  <div className="font-mono text-xs text-muted">{n.fqdn}</div>
                </Td>
                <Td className="text-muted">{n.location.short}</Td>
                <Td>
                  <UsageBar used={n.allocatedMemory ?? 0} total={n.memory} />
                </Td>
                <Td>
                  <UsageBar used={n.allocatedDisk ?? 0} total={n.disk} />
                </Td>
                <Td>{n.serverCount}</Td>
                <Td>
                  {!n.paired ? <Badge tone="warning">Not paired</Badge> : n.maintenance ? <Badge tone="warning">Maintenance</Badge> : <Badge tone="success">Paired</Badge>}
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      {creating && <NodeModal onClose={() => setCreating(false)} />}
    </>
  );
}

function PairingInstructions({ pairing }: { pairing: Pairing }) {
  return (
    <div className="flex flex-col gap-4 text-sm">
      <p>On the node machine, run the installer. It sets up Docker, glacierd and TLS, and pairs automatically:</p>
      <CopyField value={pairing.installCommand} />
      <p className="text-muted">Already have glacierd installed? Pair it directly:</p>
      <CopyField value={pairing.command} />
      <p className="text-xs text-muted">This token works once and expires {timeAgo(pairing.expiresAt)}.</p>
    </div>
  );
}

function NodeModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { data: locations } = useLocations();
  const [created, setCreated] = useState<{ node: AdminNode; pairing: Pairing } | null>(null);
  const form = useForm({
    name: '',
    locationId: '',
    fqdn: '',
    scheme: 'https',
    daemonPort: '8080',
    sftpPort: '2022',
    memory: '16384',
    memoryOverallocate: '0',
    disk: '102400',
    diskOverallocate: '0',
    dataDirectory: '/var/lib/glacier/volumes',
    behindProxy: false,
  });

  const onSubmit = form.submit(async (v) => {
    const res = await api.post<{ node: AdminNode; pairing: Pairing }>('/admin/nodes', {
      ...v,
      locationId: Number(v.locationId || locations?.[0]?.id),
      daemonPort: Number(v.daemonPort),
      sftpPort: Number(v.sftpPort),
      memory: Number(v.memory),
      memoryOverallocate: Number(v.memoryOverallocate),
      disk: Number(v.disk),
      diskOverallocate: Number(v.diskOverallocate),
    });
    void qc.invalidateQueries({ queryKey: ['admin', 'nodes'] });
    setCreated(res);
  });

  if (created) {
    return (
      <Modal open onClose={onClose} title={`Pair ${created.node.name}`} wide>
        <PairingInstructions pairing={created.pairing} />
        <div className="mt-6 flex justify-end">
          <Button onClick={() => navigate(`/admin/nodes/${created.node.id}`)}>Go to node</Button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal open onClose={onClose} title="New node" wide>
      {locations && locations.length === 0 ? (
        <Alert tone="warning">
          Create a <Link to="/admin/locations" className="underline">location</Link> first.
        </Alert>
      ) : (
        <form onSubmit={onSubmit} className="grid gap-4 sm:grid-cols-2">
          {form.error && !form.fieldError('name') && !form.fieldError('fqdn') && (
            <div className="sm:col-span-2">
              <Alert>{form.error.message}</Alert>
            </div>
          )}
          <Field label="Name" error={form.fieldError('name')}>{(id) => <Input id={id} required placeholder="node-1" {...form.bind('name')} />}</Field>
          <Field label="Location">
            {(id) => (
              <Select id={id} {...form.bind('locationId')}>
                {locations?.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.short} {l.long ? `— ${l.long}` : ''}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Hostname (FQDN)" hint="Browsers connect here for the console, e.g. node1.example.com." error={form.fieldError('fqdn')} className="sm:col-span-2">
            {(id) => <Input id={id} required placeholder="node1.example.com" {...form.bind('fqdn')} />}
          </Field>
          <Field label="Connection" hint="Use HTTPS whenever the panel itself uses HTTPS.">
            {(id) => (
              <Select id={id} {...form.bind('scheme')}>
                <option value="https">HTTPS (recommended)</option>
                <option value="http">HTTP</option>
              </Select>
            )}
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Daemon port">{(id) => <Input id={id} type="number" {...form.bind('daemonPort')} />}</Field>
            <Field label="SFTP port">{(id) => <Input id={id} type="number" {...form.bind('sftpPort')} />}</Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Memory (MiB)">{(id) => <Input id={id} type="number" min={0} {...form.bind('memory')} />}</Field>
            <Field label="Overallocate %" hint="-1 disables the check.">{(id) => <Input id={id} type="number" min={-1} {...form.bind('memoryOverallocate')} />}</Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Disk (MiB)">{(id) => <Input id={id} type="number" min={0} {...form.bind('disk')} />}</Field>
            <Field label="Overallocate %">{(id) => <Input id={id} type="number" min={-1} {...form.bind('diskOverallocate')} />}</Field>
          </div>
          <Field label="Server data directory" className="sm:col-span-2">{(id) => <Input id={id} {...form.bind('dataDirectory')} />}</Field>
          <div className="sm:col-span-2">
            <Switch
              checked={form.values.behindProxy}
              onChange={(v) => form.set('behindProxy', v)}
              label="Behind a proxy"
              description="TLS is terminated by Cloudflare or another proxy in front of the daemon."
            />
          </div>
          <div className="flex justify-end gap-2 sm:col-span-2">
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={form.submitting}>
              Create node
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}

interface AllocationRow {
  id: number;
  ip: string;
  ipAlias: string | null;
  port: number;
  notes: string | null;
  server: { id: number; name: string; shortId: string } | null;
}

export function NodeDetailPage() {
  const { id } = useParams();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const { data: node, isLoading } = useQuery({ queryKey: ['admin', 'node', id], queryFn: () => api.get<AdminNode>(`/admin/nodes/${id}`) });
  const system = useQuery({
    queryKey: ['admin', 'node', id, 'system'],
    queryFn: () => api.get<DaemonSystemInfo>(`/admin/nodes/${id}/system`),
    enabled: Boolean(node?.paired),
    retry: false,
    refetchInterval: 30_000,
  });
  const regenerate = useMutation({ mutationFn: () => api.post<Pairing>(`/admin/nodes/${id}/pairing`), onSuccess: setPairing });
  const toggleMaintenance = useMutation({
    mutationFn: (maintenance: boolean) => api.patch(`/admin/nodes/${id}`, { maintenance }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'node', id] }),
  });
  const remove = useMutation({
    mutationFn: () => api.delete(`/admin/nodes/${id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin', 'nodes'] });
      navigate('/admin/nodes');
    },
  });

  if (isLoading || !node) return <PageLoader />;

  return (
    <>
      <PageHeader
        title={node.name}
        description={
          <span className="font-mono">
            {node.scheme}://{node.fqdn}:{node.daemonPort}
          </span>
        }
        actions={
          <>
            <Button variant="secondary" loading={regenerate.isPending} onClick={() => regenerate.mutate()}>
              {node.paired ? 'Re-pair daemon' : 'Show pairing command'}
            </Button>
            <Button variant="danger" loading={remove.isPending} onClick={() => confirm(`Delete node ${node.name}?`) && remove.mutate()}>
              Delete
            </Button>
          </>
        }
      />
      {remove.error && (
        <div className="mb-4">
          <Alert>{remove.error.message}</Alert>
        </div>
      )}
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Daemon">
          {!node.paired ? (
            <Alert tone="warning">No daemon has paired with this node yet. Use "Show pairing command" above.</Alert>
          ) : system.isLoading ? (
            <PageLoader />
          ) : system.error ? (
            <Alert>
              {system.error.message}
              {node.lastSeenAt && ` Last seen ${timeAgo(node.lastSeenAt)}.`}
            </Alert>
          ) : system.data ? (
            <dl className="grid grid-cols-2 gap-y-2 text-sm">
              <dt className="text-muted">Status</dt>
              <dd>
                <Badge tone="success">online</Badge>
              </dd>
              <dt className="text-muted">glacierd</dt>
              <dd>v{system.data.version}</dd>
              <dt className="text-muted">Docker</dt>
              <dd>{system.data.dockerVersion ? `v${system.data.dockerVersion}` : 'unavailable'}</dd>
              <dt className="text-muted">System</dt>
              <dd>
                {system.data.os} ({system.data.arch})
              </dd>
              <dt className="text-muted">Hardware</dt>
              <dd>
                {system.data.cpuCount} CPU · {formatBytes(system.data.memoryTotal, 0)}
              </dd>
              <dt className="text-muted">Servers</dt>
              <dd>{system.data.servers}</dd>
            </dl>
          ) : null}
        </Card>
        <Card title="Settings">
          <div className="flex flex-col gap-4">
            <Switch
              checked={node.maintenance}
              onChange={(v) => toggleMaintenance.mutate(v)}
              label="Maintenance mode"
              description="No new servers are placed on this node."
            />
            <dl className="grid grid-cols-2 gap-y-2 text-sm">
              <dt className="text-muted">Location</dt>
              <dd>{node.location.short}</dd>
              <dt className="text-muted">Memory</dt>
              <dd>{formatMiB(node.memory)}</dd>
              <dt className="text-muted">Disk</dt>
              <dd>{formatMiB(node.disk)}</dd>
              <dt className="text-muted">SFTP port</dt>
              <dd>{node.sftpPort}</dd>
              <dt className="text-muted">Data directory</dt>
              <dd className="font-mono text-xs">{node.dataDirectory}</dd>
            </dl>
          </div>
        </Card>
        <div className="lg:col-span-2">
          <AllocationsCard nodeId={node.id} />
        </div>
      </div>
      {pairing && (
        <Modal open onClose={() => setPairing(null)} title={`Pair ${node.name}`} wide>
          {node.paired && (
            <div className="mb-4">
              <Alert tone="warning">The currently paired daemon keeps working until a new daemon pairs with this token.</Alert>
            </div>
          )}
          <PairingInstructions pairing={pairing} />
        </Modal>
      )}
    </>
  );
}

function AllocationsCard({ nodeId }: { nodeId: number }) {
  const qc = useQueryClient();
  const key = ['admin', 'node', String(nodeId), 'allocations'];
  const { data, isLoading } = useQuery({ queryKey: key, queryFn: () => api.get<{ data: AllocationRow[] }>(`/admin/nodes/${nodeId}/allocations`).then((r) => r.data) });
  const [result, setResult] = useState<string | null>(null);
  const form = useForm({ ip: '0.0.0.0', ipAlias: '', ports: '' });
  const onSubmit = form.submit(async (v) => {
    const res = await api.post<{ created: number; skipped: number }>(`/admin/nodes/${nodeId}/allocations`, { ...v, ipAlias: v.ipAlias || null });
    setResult(`Added ${res.created} port(s)${res.skipped ? `, ${res.skipped} already existed` : ''}.`);
    form.set('ports', '');
    await qc.invalidateQueries({ queryKey: key });
  });
  const remove = useMutation({
    mutationFn: (id: number) => api.delete(`/admin/nodes/${nodeId}/allocations/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
  });

  return (
    <Card title="Allocations" padded={false}>
      <form onSubmit={onSubmit} className="grid gap-3 border-b border-border p-5 sm:grid-cols-[1fr_1fr_1.5fr_auto] sm:items-end">
        <Field label="IP address" hint="0.0.0.0 binds all interfaces.">{(id) => <Input id={id} required {...form.bind('ip')} />}</Field>
        <Field label="Alias" hint="Shown to users instead of the IP.">{(id) => <Input id={id} placeholder="play.example.com" {...form.bind('ipAlias')} />}</Field>
        <Field label="Ports" hint="e.g. 25565, 25570-25580" error={form.fieldError('ports')}>{(id) => <Input id={id} required {...form.bind('ports')} />}</Field>
        <Button type="submit" loading={form.submitting} className="sm:mb-5">
          Add
        </Button>
      </form>
      {(result || (form.error && !form.fieldError('ports'))) && <div className="px-5 pt-4 text-sm">{form.error ? <Alert>{form.error.message}</Alert> : <span className="text-success">{result}</span>}</div>}
      {isLoading ? (
        <PageLoader />
      ) : !data?.length ? (
        <EmptyState title="No allocations">Add the IP and ports this node may hand out to servers.</EmptyState>
      ) : (
        <Table head={['Address', 'Alias', 'Assigned to', '']}>
          {data.map((a) => (
            <tr key={a.id}>
              <Td className="font-mono text-xs">
                {a.ip}:{a.port}
              </Td>
              <Td className="text-muted">{a.ipAlias ?? '—'}</Td>
              <Td>{a.server ? <Link to={`/admin/servers/${a.server.id}`} className="hover:text-primary">{a.server.name}</Link> : <span className="text-muted">Free</span>}</Td>
              <Td className="text-right">
                {!a.server && (
                  <button className="rounded p-1.5 text-muted hover:text-danger" onClick={() => remove.mutate(a.id)} aria-label={`Delete ${a.ip}:${a.port}`}>
                    <Trash2 className="size-4" />
                  </button>
                )}
              </Td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  );
}
