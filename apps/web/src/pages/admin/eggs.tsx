import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Egg as EggIcon, Plus, Upload } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { useForm } from '../../lib/forms';
import { Alert, Badge, Button, Card, EmptyState, Field, Input, Modal, PageHeader, PageLoader, Select, Switch, Table, Td, Textarea } from '../../components/ui';

export interface Nest {
  id: number;
  name: string;
  description: string | null;
  eggs: { id: number; uuid: string; name: string; description: string | null; _count: { servers: number } }[];
}

export interface EggDetail {
  id: number;
  uuid: string;
  name: string;
  author: string;
  description: string | null;
  dockerImages: Record<string, string>;
  startup: string;
  stopCommand: string;
  startupDone: string[];
  installContainer: string;
  installEntrypoint: string;
  installScript: string;
  features: string[];
  nest: { id: number; name: string };
  _count: { servers: number };
  variables: { id: number; name: string; description: string; envVariable: string; defaultValue: string; userViewable: boolean; userEditable: boolean; rules: string }[];
}

export function useNests() {
  return useQuery({ queryKey: ['admin', 'nests'], queryFn: () => api.get<{ data: Nest[] }>('/admin/nests').then((r) => r.data) });
}

export function EggsPage() {
  const qc = useQueryClient();
  const { data: nests, isLoading } = useNests();
  const [importing, setImporting] = useState(false);
  const [creatingNest, setCreatingNest] = useState(false);
  const seed = useMutation({ mutationFn: () => api.post('/admin/eggs/bundled'), onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'nests'] }) });

  return (
    <>
      <PageHeader
        title="Eggs"
        description="Server templates. Pterodactyl eggs (PTDL v1/v2) import as-is."
        actions={
          <>
            <Button variant="secondary" onClick={() => setCreatingNest(true)} icon={<Plus className="size-4" />}>
              New nest
            </Button>
            <Button onClick={() => setImporting(true)} icon={<Upload className="size-4" />}>
              Import egg
            </Button>
          </>
        }
      />
      {isLoading ? (
        <PageLoader />
      ) : !nests?.length ? (
        <Card>
          <EmptyState icon={<EggIcon className="size-8" />} title="No eggs installed">
            <p className="mb-4">Install the bundled Paper, Vanilla, Node.js and Python eggs, or import your own.</p>
            <Button loading={seed.isPending} onClick={() => seed.mutate()}>
              Install bundled eggs
            </Button>
          </EmptyState>
        </Card>
      ) : (
        <div className="flex flex-col gap-6">
          {nests.map((nest) => (
            <Card key={nest.id} title={nest.name} padded={false} actions={nest.description && <span className="text-xs text-muted">{nest.description}</span>}>
              {nest.eggs.length === 0 ? (
                <EmptyState title="This nest is empty" />
              ) : (
                <Table head={['Egg', 'Description', 'Servers']}>
                  {nest.eggs.map((egg) => (
                    <tr key={egg.id} className="hover:bg-surface-alt/50">
                      <Td>
                        <Link to={`/admin/eggs/${egg.id}`} className="font-medium hover:text-primary">
                          {egg.name}
                        </Link>
                      </Td>
                      <Td className="max-w-md truncate text-muted">{egg.description}</Td>
                      <Td>{egg._count.servers}</Td>
                    </tr>
                  ))}
                </Table>
              )}
            </Card>
          ))}
        </div>
      )}
      {importing && <ImportModal nests={nests ?? []} onClose={() => setImporting(false)} />}
      {creatingNest && <NestModal onClose={() => setCreatingNest(false)} />}
    </>
  );
}

function NestModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const form = useForm({ name: '', description: '' });
  const onSubmit = form.submit(async (v) => {
    await api.post('/admin/nests', { name: v.name, description: v.description || null });
    await qc.invalidateQueries({ queryKey: ['admin', 'nests'] });
    onClose();
  });
  return (
    <Modal open onClose={onClose} title="New nest">
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        {form.error && <Alert>{form.error.message}</Alert>}
        <Field label="Name">{(id) => <Input id={id} required placeholder="Rust, Valheim, Bots…" {...form.bind('name')} />}</Field>
        <Field label="Description">{(id) => <Input id={id} {...form.bind('description')} />}</Field>
        <div className="flex justify-end">
          <Button type="submit" loading={form.submitting}>
            Create
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function ImportModal({ nests, onClose }: { nests: Nest[]; onClose: () => void }) {
  const qc = useQueryClient();
  const [nestId, setNestId] = useState(String(nests[0]?.id ?? ''));
  const [json, setJson] = useState('');
  const [updateExisting, setUpdateExisting] = useState(false);
  const importEgg = useMutation({
    mutationFn: () => {
      let egg: unknown;
      try {
        egg = JSON.parse(json);
      } catch {
        throw new Error('That is not valid JSON.');
      }
      return api.post('/admin/eggs/import', { nestId: Number(nestId), egg, updateExisting });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin', 'nests'] });
      onClose();
    },
  });

  const onFile = async (file?: File) => {
    if (file) setJson(await file.text());
  };

  return (
    <Modal open onClose={onClose} title="Import egg" wide>
      <div className="flex flex-col gap-4">
        {nests.length === 0 && <Alert tone="warning">Create a nest first.</Alert>}
        {importEgg.error && (
          <Alert>
            {importEgg.error.message}
            {importEgg.error instanceof ApiError && importEgg.error.details && (
              <ul className="mt-2 list-disc pl-5 text-xs">
                {importEgg.error.details.slice(0, 8).map((d, i) => (
                  <li key={i}>{d.message}</li>
                ))}
              </ul>
            )}
          </Alert>
        )}
        <Field label="Nest">
          {(id) => (
            <Select id={id} value={nestId} onChange={(e) => setNestId(e.target.value)}>
              {nests.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Egg file">{(id) => <input id={id} type="file" accept=".json,application/json" onChange={(e) => void onFile(e.target.files?.[0])} className="text-sm text-muted file:mr-3 file:rounded-ui file:border-0 file:bg-surface-alt file:px-3 file:py-2 file:text-text" />}</Field>
        <Field label="…or paste the JSON">{(id) => <Textarea id={id} rows={8} className="font-mono text-xs" value={json} onChange={(e) => setJson(e.target.value)} spellCheck={false} />}</Field>
        <Switch checked={updateExisting} onChange={setUpdateExisting} label="Update the egg if it already exists" description="Matches by UUID. Servers keep their variable values." />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={importEgg.isPending} disabled={!json || !nestId} onClick={() => importEgg.mutate()}>
            Import
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export function EggDetailPage() {
  const { id } = useParams();
  const { data: egg, isLoading } = useQuery({ queryKey: ['admin', 'egg', id], queryFn: () => api.get<EggDetail>(`/admin/eggs/${id}`) });
  if (isLoading || !egg) return <PageLoader />;
  return (
    <>
      <PageHeader
        title={egg.name}
        description={`${egg.nest.name} · by ${egg.author} · used by ${egg._count.servers} server(s)`}
        actions={
          <a href={`/api/admin/eggs/${egg.id}/export`} download>
            <Button variant="secondary" icon={<Download className="size-4" />}>
              Export (PTDL_v2)
            </Button>
          </a>
        }
      />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Startup">
          <dl className="flex flex-col gap-3 text-sm">
            <div>
              <dt className="mb-1 text-muted">Command</dt>
              <dd className="rounded-ui bg-bg p-3 font-mono text-xs">{egg.startup}</dd>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <dt className="text-muted">Stop command</dt>
                <dd className="font-mono text-xs">{egg.stopCommand}</dd>
              </div>
              <div>
                <dt className="text-muted">Started when output contains</dt>
                <dd className="font-mono text-xs">{egg.startupDone.join(', ') || '— (immediately)'}</dd>
              </div>
            </div>
            <div>
              <dt className="mb-1 text-muted">Docker images</dt>
              <dd className="flex flex-col gap-1">
                {Object.entries(egg.dockerImages).map(([label, image]) => (
                  <span key={label} className="flex items-center gap-2 text-xs">
                    <Badge>{label}</Badge>
                    <code className="font-mono">{image}</code>
                  </span>
                ))}
              </dd>
            </div>
          </dl>
        </Card>
        <Card title="Install script" actions={<code className="font-mono text-xs text-muted">{egg.installContainer}</code>}>
          <pre className="max-h-80 overflow-auto rounded-ui bg-bg p-3 font-mono text-xs leading-relaxed">{egg.installScript || '# No install script'}</pre>
        </Card>
        <div className="lg:col-span-2">
          <Card title="Variables" padded={false}>
            <Table head={['Name', 'Variable', 'Default', 'Rules', 'Users']}>
              {egg.variables.map((v) => (
                <tr key={v.id}>
                  <Td>
                    <div className="font-medium">{v.name}</div>
                    <div className="max-w-sm text-xs text-muted">{v.description}</div>
                  </Td>
                  <Td className="font-mono text-xs">{v.envVariable}</Td>
                  <Td className="font-mono text-xs">{v.defaultValue || '—'}</Td>
                  <Td className="font-mono text-xs text-muted">{v.rules}</Td>
                  <Td>{v.userEditable ? <Badge tone="success">editable</Badge> : v.userViewable ? <Badge>view only</Badge> : <Badge tone="warning">hidden</Badge>}</Td>
                </tr>
              ))}
            </Table>
          </Card>
        </div>
      </div>
    </>
  );
}
