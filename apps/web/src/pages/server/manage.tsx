import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Star, Trash2 } from 'lucide-react';
import { api, errorMessage, type Paged } from '../../lib/api';
import type { ActivityEntry } from '../../lib/types';
import { useServer } from '../../features/server/context';
import { ActivityTable } from '../account';
import { Alert, Badge, Button, Card, CopyField, Field, Input, PageLoader, Select, Table, Td, Textarea } from '../../components/ui';
import { ConfirmDialog } from './files';
import { IconButton } from './backups';
import { SubdomainsCard, VersionCard } from './extras';
import { LogoCard } from '../../features/server/LogoCard';
import { isMinecraft } from '../../lib/minecraft';

const useRefreshServer = () => {
  const qc = useQueryClient();
  const { server } = useServer();
  return () => qc.invalidateQueries({ queryKey: ['server', server.id] });
};

// --- Network ---------------------------------------------------------------------------------------

export function NetworkTab() {
  const { server, can, base } = useServer();
  const refresh = useRefreshServer();
  const [notes, setNotes] = useState<Record<number, string>>({});
  const add = useMutation({ mutationFn: () => api.post(`${base}/network/allocations`), onSuccess: refresh });
  const primary = useMutation({ mutationFn: (id: number) => api.post(`${base}/network/allocations/${id}/primary`), onSuccess: refresh });
  const remove = useMutation({ mutationFn: (id: number) => api.delete(`${base}/network/allocations/${id}`), onSuccess: refresh });
  const saveNotes = useMutation({ mutationFn: ({ id, value }: { id: number; value: string }) => api.patch(`${base}/network/allocations/${id}`, { notes: value || null }), onSuccess: refresh });

  const extra = server.allocations.length - 1;
  const error = add.error ?? primary.error ?? remove.error ?? saveNotes.error;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted">
          {server.featureLimits.allocations === 0
            ? 'This server has one port.'
            : `${extra} of ${server.featureLimits.allocations} additional ports used. Changes apply on the next restart.`}
        </p>
        {can('allocation.create') && server.featureLimits.allocations > 0 && (
          <Button icon={<Plus className="size-4" />} loading={add.isPending} disabled={extra >= server.featureLimits.allocations} onClick={() => add.mutate()}>
            Add port
          </Button>
        )}
      </div>
      {error && <Alert>{error.message}</Alert>}
      <Card padded={false}>
        <Table head={['Address', 'Notes', '']}>
          {server.allocations.map((a) => (
            <tr key={a.id}>
              <Td>
                <span className="font-mono">
                  {a.alias ?? a.ip}:{a.port}
                </span>{' '}
                {a.primary && <Badge tone="primary">Primary</Badge>}
              </Td>
              <Td>
                {can('allocation.update') ? (
                  <Input
                    className="h-8"
                    placeholder="e.g. Dynmap, voice chat"
                    value={notes[a.id] ?? a.notes ?? ''}
                    onChange={(e) => setNotes((n) => ({ ...n, [a.id]: e.target.value }))}
                    onBlur={(e) => e.target.value !== (a.notes ?? '') && saveNotes.mutate({ id: a.id, value: e.target.value })}
                  />
                ) : (
                  <span className="text-muted">{a.notes ?? '—'}</span>
                )}
              </Td>
              <Td className="text-right">
                {!a.primary && (
                  <div className="flex justify-end gap-1">
                    {can('allocation.update') && (
                      <IconButton label="Make primary" onClick={() => primary.mutate(a.id)}>
                        <Star className="size-4" />
                      </IconButton>
                    )}
                    {can('allocation.delete') && (
                      <IconButton label="Remove" danger onClick={() => remove.mutate(a.id)}>
                        <Trash2 className="size-4" />
                      </IconButton>
                    )}
                  </div>
                )}
              </Td>
            </tr>
          ))}
        </Table>
      </Card>
      <SubdomainsCard />
    </div>
  );
}

// --- Startup ---------------------------------------------------------------------------------------

interface StartupData {
  startup: string;
  rendered: string;
  image: string;
  dockerImages: Record<string, string>;
  canChangeImage: boolean;
  canEdit: boolean;
  variables: { name: string; description: string; envVariable: string; defaultValue: string; value: string; editable: boolean; rules: string }[];
}

export function StartupTab() {
  const { server, base } = useServer();
  const qc = useQueryClient();
  const key = ['server', server.id, 'startup'];
  const { data, isLoading } = useQuery({ queryKey: key, queryFn: () => api.get<StartupData>(`${base}/startup`) });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: key });
    void qc.invalidateQueries({ queryKey: ['server', server.id] });
  };
  const image = useMutation({ mutationFn: (value: string) => api.put(`${base}/startup/image`, { image: value }), onSuccess: refresh });

  if (isLoading || !data) return <PageLoader />;
  const images = Object.entries(data.dockerImages);
  return (
    <div className="flex flex-col gap-6">
      <Card title="Startup command">
        <code className="block whitespace-pre-wrap break-all rounded-ui bg-bg p-3 font-mono text-xs">{data.rendered}</code>
        <p className="mt-2 text-xs text-muted">Variables below are filled into this command. Changes apply on the next start.</p>
      </Card>
      {data.canChangeImage && images.length > 1 && (
        <Card title="Docker image">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Select className="sm:max-w-md" value={data.image} onChange={(e) => image.mutate(e.target.value)} disabled={image.isPending}>
              {!images.some(([, img]) => img === data.image) && <option value={data.image}>Custom: {data.image}</option>}
              {images.map(([label, img]) => (
                <option key={img} value={img}>
                  {label}
                </option>
              ))}
            </Select>
            <span className="font-mono text-xs text-muted">{data.image}</span>
          </div>
          {image.error && <p className="mt-2 text-sm text-danger">{image.error.message}</p>}
          <p className="mt-2 text-xs text-muted">e.g. switch Java versions for newer or older Minecraft versions.</p>
        </Card>
      )}
      <div className="grid gap-4 md:grid-cols-2">
        {data.variables.map((v) => (
          <VariableCard key={v.envVariable} variable={v} canEdit={data.canEdit && v.editable} onSaved={refresh} />
        ))}
      </div>
    </div>
  );
}

function VariableCard({ variable, canEdit, onSaved }: { variable: StartupData['variables'][number]; canEdit: boolean; onSaved: () => void }) {
  const { base } = useServer();
  const [value, setValue] = useState(variable.value);
  useEffect(() => setValue(variable.value), [variable.value]);
  const save = useMutation({ mutationFn: () => api.put(`${base}/startup/variable`, { key: variable.envVariable, value }), onSuccess: onSaved });
  const options = /(?:^|\|)in:([^|]+)/.exec(variable.rules)?.[1]?.split(',');
  const dirty = value !== variable.value;

  return (
    <div className="rounded-ui border border-border bg-surface p-4">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{variable.name}</span>
        {!canEdit && <Badge>read only</Badge>}
      </div>
      <p className="mb-3 text-xs text-muted">{variable.description}</p>
      <div className="flex gap-2">
        {options ? (
          <Select value={value} disabled={!canEdit} onChange={(e) => setValue(e.target.value)}>
            {options.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </Select>
        ) : (
          <Input value={value} disabled={!canEdit} onChange={(e) => setValue(e.target.value)} placeholder={variable.defaultValue} onKeyDown={(e) => e.key === 'Enter' && dirty && save.mutate()} />
        )}
        {canEdit && dirty && (
          <Button size="sm" className="h-10" loading={save.isPending} onClick={() => save.mutate()}>
            Save
          </Button>
        )}
      </div>
      <div className="mt-1.5 flex justify-between gap-2 text-xs">
        <code className="font-mono text-muted">{variable.envVariable}</code>
        {save.error ? <span className="text-danger">{save.error.message}</span> : save.isSuccess && !dirty ? <span className="text-success">Saved</span> : null}
      </div>
    </div>
  );
}

// --- Settings --------------------------------------------------------------------------------------

export function SettingsTab() {
  const { server, can, base } = useServer();
  const refresh = useRefreshServer();
  const [name, setName] = useState(server.name);
  const [description, setDescription] = useState(server.description ?? '');
  const [reinstalling, setReinstalling] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const rename = useMutation({
    mutationFn: () => api.post(`${base}/settings/rename`, { name, description: description || null }),
    onSuccess: () => {
      setDone('Saved.');
      void refresh();
    },
  });

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      {can('file.sftp') && (
        <Card title="SFTP">
          <dl className="flex flex-col gap-3 text-sm">
            <div>
              <dt className="mb-1 text-xs text-muted">Address</dt>
              <dd>
                <CopyField value={`sftp://${server.sftp.host}:${server.sftp.port}`} />
              </dd>
            </div>
            <div>
              <dt className="mb-1 text-xs text-muted">Username</dt>
              <dd>
                <CopyField value={server.sftp.username} />
              </dd>
            </div>
            <p className="text-xs text-muted">The password is your panel password. Works with FileZilla, WinSCP or any SFTP client.</p>
          </dl>
        </Card>
      )}
      {can('settings.rename') && (
        <Card title="Details">
          <div className="flex flex-col gap-4">
            <Field label="Server name">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
            <Field label="Description">{(id) => <Textarea id={id} rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
            <div className="flex items-center gap-3">
              <Button loading={rename.isPending} onClick={() => rename.mutate()}>
                Save
              </Button>
              {rename.error ? <span className="text-sm text-danger">{rename.error.message}</span> : done && <span className="text-sm text-success">{done}</span>}
            </div>
          </div>
        </Card>
      )}
      <LogoCard minecraft={isMinecraft(server.egg.name)} />
      <VersionCard />
      {can('settings.reinstall') && (
        <Card title="Reinstall" className="border-danger/40">
          <p className="mb-4 text-sm text-muted">
            Stops the server and runs the install script again. Most install scripts keep your files, but some overwrite them; take a backup first.
          </p>
          <Button variant="danger" disabled={server.status === 'INSTALLING'} onClick={() => setReinstalling(true)}>
            Reinstall server
          </Button>
        </Card>
      )}
      {reinstalling && (
        <ConfirmDialog
          title="Reinstall server"
          body="Reinstall this server now? It will be stopped first."
          confirm="Reinstall"
          onClose={() => setReinstalling(false)}
          onConfirm={() =>
            api.post(`${base}/settings/reinstall`).then(() => {
              setDone('Reinstalling. Follow progress in the console.');
              return refresh();
            }, (err) => Promise.reject(new Error(errorMessage(err))))
          }
        />
      )}
    </div>
  );
}

// --- Activity --------------------------------------------------------------------------------------

export function ActivityTab() {
  const { server, base } = useServer();
  const [page, setPage] = useState(1);
  const { data, isLoading } = useQuery({
    queryKey: ['server', server.id, 'activity', page],
    queryFn: () => api.get<Paged<ActivityEntry>>(`${base}/activity?page=${page}&perPage=25`),
  });
  if (isLoading || !data) return <PageLoader />;
  return (
    <Card padded={false}>
      <ActivityTable rows={data.data} />
      {data.meta.pages > 1 && (
        <div className="flex items-center justify-between border-t border-border px-5 py-3 text-sm text-muted">
          <span>
            Page {data.meta.page} of {data.meta.pages}
          </span>
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              Newer
            </Button>
            <Button size="sm" variant="secondary" disabled={page >= data.meta.pages} onClick={() => setPage((p) => p + 1)}>
              Older
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
