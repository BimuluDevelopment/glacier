import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Database, Eye, EyeOff, KeyRound, Plus, Trash2 } from 'lucide-react';
import { api } from '../../lib/api';
import { useForm } from '../../lib/forms';
import { useServer } from '../../features/server/context';
import { Alert, Button, Card, CopyField, EmptyState, Field, Input, Modal, PageLoader } from '../../components/ui';
import { ConfirmDialog } from './files';
import { IconButton } from './backups';

interface ServerDatabase {
  id: number;
  name: string;
  username: string;
  remote: string;
  host: { name: string; address: string; port: number };
  password: string | null;
  createdAt: string;
}

export function DatabasesTab() {
  const { server, can, base } = useServer();
  const qc = useQueryClient();
  const key = ['server', server.id, 'databases'];
  const { data, isLoading } = useQuery({ queryKey: key, queryFn: () => api.get<{ data: ServerDatabase[]; limit: number }>(`${base}/databases`) });
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<ServerDatabase | null>(null);
  const [revealed, setRevealed] = useState<Set<number>>(new Set());
  const refresh = () => qc.invalidateQueries({ queryKey: key });
  const rotate = useMutation({ mutationFn: (db: ServerDatabase) => api.post(`${base}/databases/${db.id}/rotate-password`), onSuccess: refresh });

  if (isLoading || !data) return <PageLoader />;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted">
          {data.limit === 0 ? 'This server does not allow databases.' : `${data.data.length} of ${data.limit} databases used.`}
        </p>
        {can('database.create') && data.limit > 0 && (
          <Button icon={<Plus className="size-4" />} disabled={data.data.length >= data.limit} onClick={() => setCreating(true)}>
            New database
          </Button>
        )}
      </div>
      {rotate.error && <Alert>{rotate.error.message}</Alert>}
      {data.data.length === 0 ? (
        <Card>
          <EmptyState icon={<Database className="size-8" />} title="No databases">
            MySQL databases for plugins like LuckPerms, CoreProtect or your bot.
          </EmptyState>
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {data.data.map((db) => (
            <Card
              key={db.id}
              title={<span className="font-mono">{db.name}</span>}
              actions={
                <>
                  {can('database.update') && (
                    <IconButton label="Rotate password" onClick={() => rotate.mutate(db)}>
                      <KeyRound className="size-4" />
                    </IconButton>
                  )}
                  {can('database.delete') && (
                    <IconButton label="Delete" danger onClick={() => setDeleting(db)}>
                      <Trash2 className="size-4" />
                    </IconButton>
                  )}
                </>
              }
            >
              <dl className="grid gap-3 text-sm">
                <div>
                  <dt className="mb-1 text-xs text-muted">Endpoint</dt>
                  <dd>
                    <CopyField value={`${db.host.address}:${db.host.port}`} />
                  </dd>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <dt className="mb-1 text-xs text-muted">Username</dt>
                    <dd className="font-mono text-xs">{db.username}</dd>
                  </div>
                  <div>
                    <dt className="mb-1 text-xs text-muted">Connections from</dt>
                    <dd className="font-mono text-xs">{db.remote === '%' ? 'anywhere' : db.remote}</dd>
                  </div>
                </div>
                {db.password !== null && (
                  <div>
                    <dt className="mb-1 flex items-center gap-2 text-xs text-muted">
                      Password
                      <button
                        className="text-muted hover:text-text"
                        aria-label={revealed.has(db.id) ? 'Hide password' : 'Show password'}
                        onClick={() => setRevealed((s) => (s.has(db.id) ? new Set([...s].filter((x) => x !== db.id)) : new Set([...s, db.id])))}
                      >
                        {revealed.has(db.id) ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                      </button>
                    </dt>
                    <dd>{revealed.has(db.id) ? <CopyField value={db.password} /> : <span className="font-mono text-xs text-muted">••••••••••••</span>}</dd>
                  </div>
                )}
                <div>
                  <dt className="mb-1 text-xs text-muted">JDBC URL</dt>
                  <dd>
                    <CopyField value={`jdbc:mysql://${db.host.address}:${db.host.port}/${db.name}`} />
                  </dd>
                </div>
              </dl>
            </Card>
          ))}
        </div>
      )}
      {creating && <CreateDatabaseModal onClose={() => setCreating(false)} onCreated={refresh} />}
      {deleting && (
        <ConfirmDialog
          title="Delete database"
          body={`Permanently delete ${deleting.name} and all of its data?`}
          confirm="Delete"
          onClose={() => setDeleting(null)}
          onConfirm={() => api.delete(`${base}/databases/${deleting.id}`).then(refresh)}
        />
      )}
    </div>
  );
}

function CreateDatabaseModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { base } = useServer();
  const form = useForm({ database: '', remote: '%' });
  const onSubmit = form.submit(async (v) => {
    await api.post(`${base}/databases`, v);
    onCreated();
    onClose();
  });
  return (
    <Modal open onClose={onClose} title="New database">
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        {form.error && !form.fieldError('database') && !form.fieldError('remote') && <Alert>{form.error.message}</Alert>}
        <Field label="Name" hint="Letters, numbers and underscores. A server prefix is added automatically." error={form.fieldError('database')}>
          {(id) => <Input id={id} required autoFocus placeholder="luckperms" {...form.bind('database')} />}
        </Field>
        <Field label="Allow connections from" hint="% for anywhere, or an IP like 203.0.113.5." error={form.fieldError('remote')}>
          {(id) => <Input id={id} required {...form.bind('remote')} />}
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={form.submitting}>
            Create
          </Button>
        </div>
      </form>
    </Modal>
  );
}
