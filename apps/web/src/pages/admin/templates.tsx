import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LayoutTemplate, Plus } from 'lucide-react';
import { api } from '../../lib/api';
import { useForm } from '../../lib/forms';
import { formatMiB } from '../../lib/format';
import { Alert, Button, Card, EmptyState, Field, Input, Modal, PageHeader, PageLoader, Select, Table, Td } from '../../components/ui';
import { useNests, type EggDetail } from './eggs';

export interface ServerTemplate {
  id: number;
  name: string;
  description: string;
  eggId: number;
  image: string | null;
  memory: number;
  swap: number;
  disk: number;
  cpu: number;
  io: number;
  databaseLimit: number;
  allocationLimit: number;
  backupLimit: number;
  environment: Record<string, string>;
  egg: { id: number; name: string };
}

export function useTemplates() {
  return useQuery({ queryKey: ['admin', 'templates'], queryFn: () => api.get<{ data: ServerTemplate[] }>('/admin/server-templates').then((r) => r.data) });
}

export function TemplatesPage() {
  const qc = useQueryClient();
  const { data, isLoading } = useTemplates();
  const [editing, setEditing] = useState<ServerTemplate | 'new' | null>(null);
  const remove = useMutation({ mutationFn: (id: number) => api.delete(`/admin/server-templates/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'templates'] }) });
  return (
    <>
      <PageHeader
        title="Server templates"
        description="Presets like “Survival – 4 GB” that fill in the New server form in one click."
        actions={
          <Button icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>
            New template
          </Button>
        }
      />
      <Card padded={false}>
        {isLoading ? (
          <PageLoader />
        ) : !data?.length ? (
          <EmptyState icon={<LayoutTemplate className="size-8" />} title="No templates yet" />
        ) : (
          <Table head={['Template', 'Type', 'Resources', '']}>
            {data.map((t) => (
              <tr key={t.id}>
                <Td>
                  <button className="text-left font-medium hover:text-primary" onClick={() => setEditing(t)}>
                    {t.name}
                  </button>
                  {t.description && <div className="text-xs text-muted">{t.description}</div>}
                </Td>
                <Td>{t.egg.name}</Td>
                <Td className="text-xs text-muted">
                  {formatMiB(t.memory)} RAM · {formatMiB(t.disk)} disk · {t.cpu ? `${t.cpu}%` : '∞'} CPU
                </Td>
                <Td className="text-right">
                  <Button size="sm" variant="ghost" onClick={() => confirm(`Delete ${t.name}?`) && remove.mutate(t.id)}>
                    Delete
                  </Button>
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      {editing && <TemplateModal template={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function TemplateModal({ template, onClose }: { template: ServerTemplate | null; onClose: () => void }) {
  const qc = useQueryClient();
  const { data: nests } = useNests();
  const form = useForm({
    name: template?.name ?? '',
    description: template?.description ?? '',
    eggId: String(template?.eggId ?? ''),
    memory: String(template?.memory ?? 4096),
    disk: String(template?.disk ?? 20480),
    cpu: String(template?.cpu ?? 200),
    swap: String(template?.swap ?? 0),
    io: String(template?.io ?? 500),
    databaseLimit: String(template?.databaseLimit ?? 1),
    allocationLimit: String(template?.allocationLimit ?? 1),
    backupLimit: String(template?.backupLimit ?? 3),
  });
  const [environment, setEnvironment] = useState<Record<string, string>>(template?.environment ?? {});
  const eggId = form.values.eggId || String(nests?.flatMap((n) => n.eggs)[0]?.id ?? '');
  const { data: egg } = useQuery({ queryKey: ['admin', 'egg', eggId], queryFn: () => api.get<EggDetail>(`/admin/eggs/${eggId}`), enabled: Boolean(eggId) });

  const onSubmit = form.submit(async (v) => {
    const num = (k: keyof typeof v) => Number(v[k]);
    const body = {
      name: v.name,
      description: v.description,
      eggId: Number(eggId),
      memory: num('memory'),
      disk: num('disk'),
      cpu: num('cpu'),
      swap: num('swap'),
      io: num('io'),
      databaseLimit: num('databaseLimit'),
      allocationLimit: num('allocationLimit'),
      backupLimit: num('backupLimit'),
      environment: Object.fromEntries(Object.entries(environment).filter(([, val]) => val !== '')),
    };
    if (template) await api.patch(`/admin/server-templates/${template.id}`, body);
    else await api.post('/admin/server-templates', body);
    void qc.invalidateQueries({ queryKey: ['admin', 'templates'] });
    onClose();
  });

  const numField = (k: 'memory' | 'disk' | 'cpu' | 'swap' | 'io' | 'databaseLimit' | 'allocationLimit' | 'backupLimit', label: string) => (
    <Field label={label}>{(id) => <Input id={id} type="number" {...form.bind(k)} />}</Field>
  );

  return (
    <Modal open onClose={onClose} title={template ? `Edit ${template.name}` : 'New template'} wide>
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        {form.error && <Alert>{form.error.message}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name">{(id) => <Input id={id} required placeholder="Survival – 4 GB" {...form.bind('name')} />}</Field>
          <Field label="Server type">
            {(id) => (
              <Select id={id} value={eggId} onChange={(e) => form.set('eggId', e.target.value)}>
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
          <Field label="Description" className="sm:col-span-2">{(id) => <Input id={id} {...form.bind('description')} />}</Field>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {numField('memory', 'Memory (MiB)')}
          {numField('disk', 'Disk (MiB)')}
          {numField('cpu', 'CPU (%)')}
          {numField('swap', 'Swap (MiB)')}
          {numField('databaseLimit', 'Databases')}
          {numField('allocationLimit', 'Extra ports')}
          {numField('backupLimit', 'Backups')}
          {numField('io', 'IO weight')}
        </div>
        {egg && egg.variables.length > 0 && (
          <div>
            <p className="mb-2 text-sm font-medium">Variables (empty = egg default)</p>
            <div className="grid gap-3 sm:grid-cols-2">
              {egg.variables.map((x) => (
                <Field key={x.id} label={x.name}>
                  {(id) => <Input id={id} placeholder={x.defaultValue} value={environment[x.envVariable] ?? ''} onChange={(e) => setEnvironment((env) => ({ ...env, [x.envVariable]: e.target.value }))} />}
                </Field>
              ))}
            </div>
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={form.submitting}>
            {template ? 'Save' : 'Create'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
