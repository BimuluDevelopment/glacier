import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, Download, Lock, LockOpen, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { useForm } from '../../lib/forms';
import { formatBytes, formatDate, timeAgo } from '../../lib/format';
import { useServer } from '../../features/server/context';
import { Alert, Badge, Button, Card, EmptyState, Field, Input, Modal, PageLoader, Spinner, Switch, Table, Td, Textarea } from '../../components/ui';
import { ConfirmDialog } from './files';

interface Backup {
  uuid: string;
  name: string;
  ignoredFiles: string;
  isSuccessful: boolean;
  isLocked: boolean;
  checksum: string | null;
  bytes: number;
  status: 'running' | 'completed' | 'failed';
  createdAt: string;
  completedAt: string | null;
}

export function BackupsTab() {
  const { server, can, base } = useServer();
  const qc = useQueryClient();
  const key = ['server', server.id, 'backups'];
  const { data, isLoading } = useQuery({
    queryKey: key,
    queryFn: () => api.get<{ data: Backup[]; limit: number }>(`${base}/backups`),
    refetchInterval: (q) => (q.state.data?.data.some((b) => b.status === 'running') ? 3_000 : false),
  });
  const [creating, setCreating] = useState(false);
  const [restoring, setRestoring] = useState<Backup | null>(null);
  const [deleting, setDeleting] = useState<Backup | null>(null);
  const [notice, setNotice] = useState<{ tone: 'danger' | 'success'; text: string } | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: key });

  const lock = useMutation({ mutationFn: (b: Backup) => api.post(`${base}/backups/${b.uuid}/lock`), onSuccess: refresh });
  const download = async (b: Backup) => {
    try {
      const { url } = await api.get<{ url: string }>(`${base}/backups/${b.uuid}/download`);
      window.location.href = url;
    } catch (err) {
      setNotice({ tone: 'danger', text: errorMessage(err) });
    }
  };

  if (isLoading || !data) return <PageLoader />;
  const atLimit = data.data.length >= data.limit;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted">
          {data.limit === 0 ? 'This server does not allow backups.' : `${data.data.length} of ${data.limit} backups used. Locked backups are never rotated out by schedules.`}
        </p>
        {can('backup.create') && data.limit > 0 && (
          <Button icon={<Plus className="size-4" />} disabled={atLimit || data.data.some((b) => b.status === 'running')} onClick={() => setCreating(true)}>
            Create backup
          </Button>
        )}
      </div>
      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
      {lock.error && <Alert>{lock.error.message}</Alert>}

      <Card padded={false}>
        {data.data.length === 0 ? (
          <EmptyState icon={<Archive className="size-8" />} title="No backups yet">
            Backups are stored on the node as compressed archives you can restore or download.
          </EmptyState>
        ) : (
          <Table head={['Backup', 'Size', 'Created', 'Status', '']}>
            {data.data.map((b) => (
              <tr key={b.uuid}>
                <Td>
                  <span className="flex items-center gap-2 font-medium">
                    {b.isLocked && <Lock className="size-3.5 text-warning" aria-label="Locked" />}
                    {b.name}
                  </span>
                  {b.checksum && <div className="font-mono text-xs text-muted" title={`sha256 ${b.checksum}`}>sha256 {b.checksum.slice(0, 12)}…</div>}
                </Td>
                <Td className="tabular-nums">{b.status === 'completed' ? formatBytes(b.bytes) : '—'}</Td>
                <Td className="text-muted">
                  <span title={formatDate(b.createdAt)}>{timeAgo(b.createdAt)}</span>
                </Td>
                <Td>
                  {b.status === 'running' ? (
                    <Badge tone="warning">
                      <Spinner className="size-3" /> Running
                    </Badge>
                  ) : b.status === 'completed' ? (
                    <Badge tone="success">Completed</Badge>
                  ) : (
                    <Badge tone="danger">Failed</Badge>
                  )}
                </Td>
                <Td className="text-right">
                  <div className="flex justify-end gap-1">
                    {b.status === 'completed' && can('backup.download') && (
                      <IconButton label="Download" onClick={() => void download(b)}>
                        <Download className="size-4" />
                      </IconButton>
                    )}
                    {b.status === 'completed' && can('backup.restore') && (
                      <IconButton label="Restore" onClick={() => setRestoring(b)}>
                        <RotateCcw className="size-4" />
                      </IconButton>
                    )}
                    {b.status !== 'running' && can('backup.delete') && (
                      <>
                        <IconButton label={b.isLocked ? 'Unlock' : 'Lock'} onClick={() => lock.mutate(b)}>
                          {b.isLocked ? <LockOpen className="size-4" /> : <Lock className="size-4" />}
                        </IconButton>
                        <IconButton label="Delete" danger disabled={b.isLocked} onClick={() => setDeleting(b)}>
                          <Trash2 className="size-4" />
                        </IconButton>
                      </>
                    )}
                  </div>
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      {creating && <CreateBackupModal onClose={() => setCreating(false)} onCreated={refresh} />}
      {restoring && <RestoreDialog backup={restoring} onClose={() => setRestoring(null)} onDone={() => setNotice({ tone: 'success', text: `Restoring "${restoring.name}". Follow progress in the console.` })} />}
      {deleting && (
        <ConfirmDialog
          title="Delete backup"
          body={`Permanently delete "${deleting.name}"?`}
          confirm="Delete"
          onClose={() => setDeleting(null)}
          onConfirm={() => api.delete(`${base}/backups/${deleting.uuid}`).then(refresh)}
        />
      )}
    </div>
  );
}

export function IconButton({ label, onClick, children, danger, disabled }: { label: string; onClick: () => void; children: React.ReactNode; danger?: boolean; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={`rounded p-1.5 text-muted transition hover:bg-surface-alt disabled:opacity-40 ${danger ? 'hover:text-danger' : 'hover:text-text'}`}
    >
      {children}
    </button>
  );
}

function CreateBackupModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { base } = useServer();
  const form = useForm({ name: '', ignored: '' });
  const onSubmit = form.submit(async (v) => {
    await api.post(`${base}/backups`, { name: v.name || undefined, ignored: v.ignored });
    onCreated();
    onClose();
  });
  return (
    <Modal open onClose={onClose} title="Create backup">
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        {form.error && <Alert>{form.error.message}</Alert>}
        <Field label="Name" hint="Optional. Defaults to the date and time.">{(id) => <Input id={id} {...form.bind('name')} />}</Field>
        <Field label="Ignored files" hint="One pattern per line, like .gitignore: logs/, *.log, cache/">
          {(id) => <Textarea id={id} rows={4} className="font-mono text-xs" {...form.bind('ignored')} />}
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={form.submitting}>
            Start backup
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function RestoreDialog({ backup, onClose, onDone }: { backup: Backup; onClose: () => void; onDone: () => void }) {
  const { base } = useServer();
  const [truncate, setTruncate] = useState(false);
  return (
    <ConfirmDialog
      title="Restore backup"
      body={
        <>
          Restore <strong>{backup.name}</strong>? The server will be stopped while files are restored.
        </>
      }
      confirm="Restore"
      onClose={onClose}
      onConfirm={() => api.post(`${base}/backups/${backup.uuid}/restore`, { truncate }).then(onDone)}
    >
      <Switch checked={truncate} onChange={setTruncate} label="Delete all current files first" description="Otherwise files that are not in the backup are kept." />
    </ConfirmDialog>
  );
}
