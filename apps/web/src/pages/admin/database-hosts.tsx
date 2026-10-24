import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Database, Plus } from 'lucide-react';
import { api } from '../../lib/api';
import { useForm } from '../../lib/forms';
import { Alert, Badge, Button, Card, EmptyState, Field, Input, Modal, PageHeader, PageLoader, Select, Table, Td } from '../../components/ui';
import { useNodes } from './nodes';

interface DatabaseHost {
  id: number;
  name: string;
  host: string;
  port: number;
  username: string;
  maxDatabases: number | null;
  node: { id: number; name: string } | null;
  _count: { databases: number };
}

export function DatabaseHostsPage() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['admin', 'database-hosts'], queryFn: () => api.get<{ data: DatabaseHost[] }>('/admin/database-hosts').then((r) => r.data) });
  const [creating, setCreating] = useState(false);
  const [result, setResult] = useState<{ id: number; ok: boolean; text: string } | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['admin', 'database-hosts'] });
  const test = useMutation({
    mutationFn: (h: DatabaseHost) => api.post<{ version: string }>(`/admin/database-hosts/${h.id}/test`),
    onSuccess: (r, h) => setResult({ id: h.id, ok: true, text: `Connected (${r.version})` }),
    onError: (err, h) => setResult({ id: h.id, ok: false, text: err.message }),
  });
  const remove = useMutation({ mutationFn: (h: DatabaseHost) => api.delete(`/admin/database-hosts/${h.id}`), onSuccess: refresh });

  return (
    <>
      <PageHeader
        title="Database hosts"
        description="MySQL or MariaDB servers where Glacier Panel creates databases for game servers."
        actions={
          <Button icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
            Add host
          </Button>
        }
      />
      {remove.error && (
        <div className="mb-4">
          <Alert>{remove.error.message}</Alert>
        </div>
      )}
      <Card padded={false}>
        {isLoading ? (
          <PageLoader />
        ) : !data?.length ? (
          <EmptyState icon={<Database className="size-8" />} title="No database hosts">
            Add a MySQL/MariaDB server with a user that can create databases and users (e.g. a dedicated <code>glacier</code> user with GRANT OPTION).
          </EmptyState>
        ) : (
          <Table head={['Host', 'Linked node', 'Databases', '']}>
            {data.map((h) => (
              <tr key={h.id}>
                <Td>
                  <div className="font-medium">{h.name}</div>
                  <div className="font-mono text-xs text-muted">
                    {h.username}@{h.host}:{h.port}
                  </div>
                  {result?.id === h.id && <div className={`mt-1 text-xs ${result.ok ? 'text-success' : 'text-danger'}`}>{result.text}</div>}
                </Td>
                <Td className="text-muted">{h.node?.name ?? 'Any'}</Td>
                <Td>
                  {h._count.databases}
                  {h.maxDatabases ? <span className="text-muted"> / {h.maxDatabases}</span> : null}
                </Td>
                <Td className="text-right">
                  <div className="flex justify-end gap-2">
                    <Button size="sm" variant="secondary" loading={test.isPending && test.variables?.id === h.id} onClick={() => test.mutate(h)}>
                      Test
                    </Button>
                    <Button size="sm" variant="ghost" disabled={h._count.databases > 0} onClick={() => confirm(`Remove ${h.name}?`) && remove.mutate(h)}>
                      Remove
                    </Button>
                  </div>
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      {creating && <HostModal onClose={() => setCreating(false)} onCreated={refresh} />}
    </>
  );
}

function HostModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { data: nodes } = useNodes();
  const form = useForm({ name: '', host: '127.0.0.1', port: '3306', username: 'glacier', password: '', maxDatabases: '', nodeId: '' });
  const onSubmit = form.submit(async (v) => {
    await api.post('/admin/database-hosts', {
      ...v,
      port: Number(v.port),
      maxDatabases: v.maxDatabases ? Number(v.maxDatabases) : null,
      nodeId: v.nodeId ? Number(v.nodeId) : null,
    });
    onCreated();
    onClose();
  });
  return (
    <Modal open onClose={onClose} title="Add database host" wide>
      <form onSubmit={onSubmit} className="grid gap-4 sm:grid-cols-2">
        {form.error && (
          <div className="sm:col-span-2">
            <Alert>{form.error.message}</Alert>
          </div>
        )}
        <Field label="Name">{(id) => <Input id={id} required placeholder="EU MariaDB" {...form.bind('name')} />}</Field>
        <Field label="Linked node" hint="Servers on this node use this host first.">
          {(id) => (
            <Select id={id} {...form.bind('nodeId')}>
              <option value="">Any node</option>
              {nodes?.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Host" hint="Address game servers use to connect, too.">{(id) => <Input id={id} required {...form.bind('host')} />}</Field>
        <Field label="Port">{(id) => <Input id={id} type="number" required {...form.bind('port')} />}</Field>
        <Field label="Username">{(id) => <Input id={id} required {...form.bind('username')} />}</Field>
        <Field label="Password">{(id) => <Input id={id} type="password" required autoComplete="new-password" {...form.bind('password')} />}</Field>
        <Field label="Max databases" hint="Empty for no limit.">{(id) => <Input id={id} type="number" min={1} {...form.bind('maxDatabases')} />}</Field>
        <div className="sm:col-span-2">
          <Badge>The panel connects with these credentials to check them before saving.</Badge>
        </div>
        <div className="flex justify-end gap-2 sm:col-span-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={form.submitting}>
            Add host
          </Button>
        </div>
      </form>
    </Modal>
  );
}
