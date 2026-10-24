import { useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Link2, Pencil, Plus, Server, Trash2, Unlink } from 'lucide-react';
import { PROXY_LABELS, type NetworkInfo, type NetworkServer } from '@glacier/shared';
import { api, errorMessage } from '../../lib/api';
import { useForm } from '../../lib/forms';
import { formatMiB } from '../../lib/format';
import { useServer } from '../../features/server/context';
import { Alert, Badge, Button, Card, CopyField, EmptyState, Field, Input, Modal, PageLoader, Select, Switch, Textarea } from '../../components/ui';
import { ServerLogo } from '../../components/ServerLogo';
import { ConfirmDialog } from './files';
import { IconButton } from './backups';

const STATE: Record<NetworkServer['state'], { label: string; tone: 'success' | 'warning' | 'neutral' }> = {
  running: { label: 'Online', tone: 'success' },
  starting: { label: 'Starting', tone: 'warning' },
  stopping: { label: 'Stopping', tone: 'warning' },
  offline: { label: 'Offline', tone: 'neutral' },
  unknown: { label: 'Unknown', tone: 'neutral' },
};

function StateBadge({ server }: { server: Pick<NetworkServer, 'state' | 'status'> }) {
  if (server.status === 'INSTALLING') return <Badge tone="warning">Installing</Badge>;
  if (server.status !== 'ACTIVE') return <Badge tone="danger">{server.status === 'SUSPENDED' ? 'Suspended' : 'Install failed'}</Badge>;
  const s = STATE[server.state];
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

/** The Proxy tab: the servers behind this Velocity/BungeeCord/Waterfall proxy. */
export function ProxyTab() {
  const { server, can, base } = useServer();
  const qc = useQueryClient();
  const key = ['proxy', server.id];
  const { data, isLoading, error } = useQuery({ queryKey: key, queryFn: () => api.get<NetworkInfo>(`${base}/proxy`), refetchInterval: 10_000 });
  const [adding, setAdding] = useState(false);
  const [linking, setLinking] = useState(false);
  const [editing, setEditing] = useState<NetworkServer | null>(null);
  const [confirm, setConfirm] = useState<{ kind: 'detach' | 'delete'; server: NetworkServer } | null>(null);
  const invalidate = () => Promise.all([qc.invalidateQueries({ queryKey: key }), qc.invalidateQueries({ queryKey: ['servers'] })]);

  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) => api.patch(`${base}/proxy/servers/${id}`, body),
    onSuccess: invalidate,
  });
  const reorder = useMutation({ mutationFn: (ids: string[]) => api.post(`${base}/proxy/order`, { ids }), onSuccess: invalidate });

  if (isLoading) return <PageLoader />;
  if (error || !data) return <Alert>{errorMessage(error)}</Alert>;

  const manage = can('network.manage');
  const label = PROXY_LABELS[data.proxy.type];
  const move = (index: number, by: number) => {
    const ids = data.servers.map((s) => s.id);
    [ids[index], ids[index + by]] = [ids[index + by]!, ids[index]!];
    reorder.mutate(ids);
  };
  const canCreate = manage && (data.unlimited || data.limits.servers > 0);

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-semibold">{label} network</h2>
              <StateBadge server={{ state: data.proxy.state, status: server.status }} />
              {data.proxy.forwarding === 'modern' ? <Badge tone="success">Secure forwarding</Badge> : <Badge tone="warning">Legacy IP forwarding</Badge>}
            </div>
            <p className="max-w-2xl text-sm text-muted">
              Players connect to the proxy and move between these servers with <code className="font-mono">/server &lt;name&gt;</code>. Servers you add here run on the same machine and can only be
              reached through the proxy.
            </p>
          </div>
          <div className="w-full max-w-xs">
            <p className="mb-1 text-xs text-muted">Players join at</p>
            <CopyField value={data.proxy.address} />
          </div>
        </div>
        {data.proxy.forwarding === 'legacy' && (
          <div className="mt-4">
            <Alert tone="warning">
              {label} passes player details without signing them. Servers created here can only be reached through the proxy, but anything else on this machine could still connect to them
              directly. Velocity&apos;s secure forwarding doesn&apos;t have this problem; for {label}, install BungeeGuard on the proxy and its servers.
            </Alert>
          </div>
        )}
      </Card>

      <Card
        title={`Servers (${data.servers.length})`}
        padded={false}
        actions={
          manage && (
            <div className="flex gap-2">
              {data.attachable.length > 0 && (
                <Button size="sm" variant="secondary" icon={<Link2 className="size-4" />} onClick={() => setLinking(true)}>
                  Link existing
                </Button>
              )}
              {canCreate && (
                <Button size="sm" icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>
                  Add server
                </Button>
              )}
            </div>
          )
        }
      >
        {data.servers.length === 0 ? (
          <EmptyState icon={<Server className="size-8" />} title="No servers in this network yet">
            {canCreate
              ? 'Add a lobby first; players land on it when they join. Then add more servers like survival or minigames.'
              : manage
                ? 'Link one of your servers on this machine, or ask an administrator to allow new servers in this network.'
                : 'The owner of this proxy can add servers here.'}
          </EmptyState>
        ) : (
          <ul className="divide-y divide-border">
            {data.servers.map((s, i) => (
              <li key={s.id} className="flex flex-wrap items-center gap-x-4 gap-y-3 px-5 py-4">
                <ServerLogo server={s} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono font-medium">{s.networkName}</span>
                    <StateBadge server={s} />
                    {s.fallback && <Badge tone="primary">Join first</Badge>}
                  </div>
                  <div className="mt-0.5 truncate text-xs text-muted">
                    <Link to={`/server/${s.id}`} className="hover:text-primary hover:underline">
                      {s.name}
                    </Link>{' '}
                    · {s.egg} · {formatMiB(s.memory)} RAM · {formatMiB(s.disk)} disk
                    {s.forcedHosts.length > 0 && <> · {s.forcedHosts.join(', ')}</>}
                  </div>
                </div>
                {manage && (
                  <div className="flex items-center gap-1">
                    <Switch checked={s.fallback} onChange={(fallback) => update.mutate({ id: s.id, body: { fallback } })} label="Join first" disabled={update.isPending} />
                    <span className="mx-2 h-6 w-px bg-border" />
                    <IconButton label="Move up" disabled={i === 0 || reorder.isPending} onClick={() => move(i, -1)}>
                      <ArrowUp className="size-4" />
                    </IconButton>
                    <IconButton label="Move down" disabled={i === data.servers.length - 1 || reorder.isPending} onClick={() => move(i, 1)}>
                      <ArrowDown className="size-4" />
                    </IconButton>
                    <IconButton label="Edit" onClick={() => setEditing(s)}>
                      <Pencil className="size-4" />
                    </IconButton>
                    <IconButton label="Remove from network" onClick={() => setConfirm({ kind: 'detach', server: s })}>
                      <Unlink className="size-4" />
                    </IconButton>
                    {(s.managed || data.unlimited) && (
                      <IconButton label="Delete server" danger onClick={() => setConfirm({ kind: 'delete', server: s })}>
                        <Trash2 className="size-4" />
                      </IconButton>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        {(update.error || reorder.error) && (
          <div className="px-5 pb-4">
            <Alert>{errorMessage(update.error ?? reorder.error)}</Alert>
          </div>
        )}
      </Card>

      {!data.unlimited && data.limits.servers > 0 && <LimitsCard data={data} />}

      <p className="text-xs text-muted">
        Changes are written to the proxy&apos;s config right away and it reloads if it is running. &quot;Join first&quot; servers are tried in list order when players connect or get kicked from
        another server.
      </p>

      {adding && <AddServerModal data={data} onClose={() => setAdding(false)} onDone={invalidate} />}
      {linking && <LinkServerModal data={data} onClose={() => setLinking(false)} onDone={invalidate} />}
      {editing && <EditServerModal server={editing} onClose={() => setEditing(null)} onDone={invalidate} />}
      {confirm && (
        <ConfirmDialog
          title={confirm.kind === 'delete' ? `Delete ${confirm.server.networkName}` : `Remove ${confirm.server.networkName} from the network`}
          body={
            confirm.kind === 'delete'
              ? `This permanently deletes the server "${confirm.server.name}" with all its files and backups.`
              : confirm.server.managed
                ? 'The server keeps its files, but it was made for this network and only listens on this machine, so players won’t be able to reach it until an administrator gives it a public port.'
                : 'The server keeps running on its own, and its player forwarding settings are turned off again. Restart it afterwards.'
          }
          confirm={confirm.kind === 'delete' ? 'Delete server' : 'Remove'}
          onClose={() => setConfirm(null)}
          onConfirm={() =>
            (confirm.kind === 'delete' ? api.delete(`${base}/proxy/servers/${confirm.server.id}`) : api.post(`${base}/proxy/servers/${confirm.server.id}/detach`)).then(invalidate, (err) =>
              Promise.reject(new Error(errorMessage(err))),
            )
          }
        />
      )}
    </div>
  );
}

function LimitsCard({ data }: { data: NetworkInfo }) {
  const rows = [
    { label: 'Servers', used: data.used.servers, limit: data.limits.servers, fmt: (n: number) => String(n) },
    { label: 'Memory', used: data.used.memory, limit: data.limits.memory, fmt: formatMiB },
    { label: 'Disk', used: data.used.disk, limit: data.limits.disk, fmt: formatMiB },
    { label: 'CPU', used: data.used.cpu, limit: data.limits.cpu, fmt: (n: number) => `${n}%` },
  ].filter((r) => r.limit > 0);
  return (
    <Card title="Network limits">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {rows.map((r) => (
          <div key={r.label}>
            <div className="mb-1 flex justify-between text-xs">
              <span className="text-muted">{r.label}</span>
              <span className="tabular-nums">
                {r.fmt(r.used)} / {r.fmt(r.limit)}
              </span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-surface-alt">
              <div className="h-full rounded-full bg-primary" style={{ width: `${Math.min(100, (r.used / r.limit) * 100)}%` }} />
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

const NAME_HINT = 'Lowercase, e.g. lobby or survival. Players use it with /server.';

function AddServerModal({ data, onClose, onDone }: { data: NetworkInfo; onClose: () => void; onDone: () => Promise<unknown> }) {
  const { base } = useServer();
  const first = data.servers.length === 0;
  const left = (limit: number, used: number) => (data.unlimited || limit === 0 ? null : Math.max(0, limit - used));
  const memoryLeft = left(data.limits.memory, data.used.memory);
  const diskLeft = left(data.limits.disk, data.used.disk);
  const cpuLeft = left(data.limits.cpu, data.used.cpu);
  const form = useForm({
    networkName: first ? 'lobby' : '',
    name: '',
    eggId: String(data.eggs[0]?.id ?? ''),
    version: 'latest',
    memory: String(Math.min(2048, memoryLeft ?? 2048)),
    disk: String(Math.min(10240, diskLeft ?? 10240)),
    cpu: String(cpuLeft === null ? 0 : Math.min(100, cpuLeft)),
  });
  const [fallback, setFallback] = useState(first);
  const [eula, setEula] = useState(false);

  const onSubmit = form.submit(async (v) => {
    await api.post(`${base}/proxy/servers`, {
      networkName: v.networkName,
      name: v.name || undefined,
      eggId: Number(v.eggId),
      version: v.version || 'latest',
      memory: Number(v.memory),
      disk: Number(v.disk),
      cpu: Number(v.cpu),
      fallback,
      acceptEula: eula,
    });
    await onDone();
    onClose();
  });

  return (
    <Modal open onClose={onClose} title="Add a server to the network" wide>
      {data.eggs.length === 0 ? (
        <Alert tone="warning">No server types can join this network yet. An administrator can add the bundled Paper egg under Admin → Eggs.</Alert>
      ) : (
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          {form.error && !form.fieldError('networkName') && <Alert>{form.error.message}</Alert>}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name in the network" hint={NAME_HINT} error={form.fieldError('networkName')}>
              {(id) => <Input id={id} required autoFocus className="font-mono" placeholder="survival" {...form.bind('networkName')} />}
            </Field>
            <Field label="Display name" hint="Shown in the panel. Optional.">
              {(id) => <Input id={id} placeholder="Survival" {...form.bind('name')} />}
            </Field>
            <Field label="Server type" error={form.fieldError('eggId')}>
              {(id) => (
                <Select id={id} {...form.bind('eggId')}>
                  {data.eggs.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Minecraft version" hint='"latest" or e.g. 1.21.4' error={form.fieldError('version')}>
              {(id) => <Input id={id} {...form.bind('version')} />}
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Memory (MiB)" hint={memoryLeft !== null ? `${formatMiB(memoryLeft)} left` : undefined} error={form.fieldError('memory')}>
              {(id) => <Input id={id} type="number" min={256} step={256} {...form.bind('memory')} />}
            </Field>
            <Field label="Disk (MiB)" hint={diskLeft !== null ? `${formatMiB(diskLeft)} left` : undefined} error={form.fieldError('disk')}>
              {(id) => <Input id={id} type="number" min={1024} step={1024} {...form.bind('disk')} />}
            </Field>
            <Field label="CPU (%)" hint={cpuLeft !== null ? `${cpuLeft}% left` : '0 = no limit; 100 = one core'} error={form.fieldError('cpu')}>
              {(id) => <Input id={id} type="number" min={0} step={50} {...form.bind('cpu')} />}
            </Field>
          </div>
          <Switch checked={fallback} onChange={setFallback} label="Players join this server first" description="Use it for your lobby. It is also where players go when another server kicks them." />
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-0.5 accent-primary" checked={eula} onChange={(e) => setEula(e.target.checked)} />
            <span>
              I accept the{' '}
              <a href="https://aka.ms/MinecraftEULA" target="_blank" rel="noreferrer" className="text-primary hover:underline">
                Minecraft EULA
              </a>
              .
            </span>
          </label>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!eula} loading={form.submitting}>
              Create server
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}

function LinkServerModal({ data, onClose, onDone }: { data: NetworkInfo; onClose: () => void; onDone: () => Promise<unknown> }) {
  const { base } = useServer();
  const form = useForm({ server: data.attachable[0]?.id ?? '', networkName: data.servers.length === 0 ? 'lobby' : '' });
  const [fallback, setFallback] = useState(data.servers.length === 0);
  const [linked, setLinked] = useState(false);
  const onSubmit = form.submit(async (v) => {
    await api.post(`${base}/proxy/servers/attach`, { ...v, fallback });
    await onDone();
    setLinked(true);
  });
  return (
    <Modal open onClose={onClose} title="Link an existing server">
      {linked ? (
        <div className="flex flex-col gap-4">
          <Alert tone="success">Linked. Restart that server so it starts accepting players from the proxy.</Alert>
          <div className="flex justify-end">
            <Button onClick={onClose}>Done</Button>
          </div>
        </div>
      ) : (
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          {form.error && !form.fieldError('networkName') && <Alert>{form.error.message}</Alert>}
          <Field label="Server">
            {(id) => (
              <Select id={id} {...form.bind('server')}>
                {data.attachable.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.egg})
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Name in the network" hint={NAME_HINT} error={form.fieldError('networkName')}>
            {(id) => <Input id={id} required className="font-mono" {...form.bind('networkName')} />}
          </Field>
          <Switch checked={fallback} onChange={setFallback} label="Players join this server first" />
          <p className="text-xs text-muted">
            The server turns on player forwarding and stops checking accounts itself (the proxy does that). Its own address keeps working only for players coming through the proxy.
          </p>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={form.submitting}>
              Link server
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}

function EditServerModal({ server, onClose, onDone }: { server: NetworkServer; onClose: () => void; onDone: () => Promise<unknown> }) {
  const { base } = useServer();
  const form = useForm({ networkName: server.networkName, forcedHosts: server.forcedHosts.join('\n') });
  const onSubmit = form.submit(async (v) => {
    await api.patch(`${base}/proxy/servers/${server.id}`, {
      networkName: v.networkName,
      forcedHosts: v.forcedHosts
        .split(/[\s,]+/)
        .map((h) => h.trim())
        .filter(Boolean),
    });
    await onDone();
    onClose();
  });
  return (
    <Modal open onClose={onClose} title={`Edit ${server.networkName}`}>
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        {form.error && !form.fieldError('networkName') && <Alert>{form.error.message}</Alert>}
        <Field label="Name in the network" hint={NAME_HINT} error={form.fieldError('networkName')}>
          {(id) => <Input id={id} required className="font-mono" {...form.bind('networkName')} />}
        </Field>
        <Field label="Forced hosts" hint="Players who connect with one of these addresses go straight to this server. One per line; point each at the proxy in DNS.">
          {(id) => <Textarea id={id} rows={3} className="font-mono" placeholder="survival.example.com" {...form.bind('forcedHosts')} />}
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={form.submitting}>
            Save
          </Button>
        </div>
      </form>
    </Modal>
  );
}
