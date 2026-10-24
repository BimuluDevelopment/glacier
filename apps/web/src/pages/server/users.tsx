import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Trash2, Users } from 'lucide-react';
import { ALL_SERVER_PERMISSIONS, PERMISSION_ALL, SERVER_PERMISSIONS, type ServerPermission } from '@glacier/shared';
import { api } from '../../lib/api';
import { useForm } from '../../lib/forms';
import { useAuth } from '../../auth/AuthProvider';
import { useServer } from '../../features/server/context';
import { Alert, Badge, Button, Card, EmptyState, Field, Input, Modal, PageLoader, Table, Td } from '../../components/ui';
import { ConfirmDialog } from './files';
import { IconButton } from './backups';

interface Subuser {
  id: number;
  permissions: string[];
  createdAt: string;
  user: { id: string; username: string; email: string };
}

export function UsersTab() {
  const { server, can, base } = useServer();
  const { user: me } = useAuth();
  const qc = useQueryClient();
  const key = ['server', server.id, 'users'];
  const { data, isLoading } = useQuery({ queryKey: key, queryFn: () => api.get<{ data: Subuser[] }>(`${base}/users`).then((r) => r.data) });
  const [editing, setEditing] = useState<Subuser | 'new' | null>(null);
  const [removing, setRemoving] = useState<Subuser | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: key });

  if (isLoading || !data) return <PageLoader />;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted">Give friends or staff access to this server without sharing your account.</p>
        {can('user.create') && (
          <Button icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>
            Add user
          </Button>
        )}
      </div>
      <Card padded={false}>
        {data.length === 0 ? (
          <EmptyState icon={<Users className="size-8" />} title="Only you have access" />
        ) : (
          <Table head={['User', 'Permissions', '']}>
            {data.map((s) => (
              <tr key={s.id}>
                <Td>
                  <div className="font-medium">{s.user.username}</div>
                  <div className="text-xs text-muted">{s.user.email}</div>
                </Td>
                <Td>
                  <Badge>{s.permissions.length} of {ALL_SERVER_PERMISSIONS.length}</Badge>
                </Td>
                <Td className="text-right">
                  {s.user.id !== me?.id && (
                    <div className="flex justify-end gap-1">
                      {can('user.update') && (
                        <IconButton label="Edit permissions" onClick={() => setEditing(s)}>
                          <Pencil className="size-4" />
                        </IconButton>
                      )}
                      {can('user.delete') && (
                        <IconButton label="Remove" danger onClick={() => setRemoving(s)}>
                          <Trash2 className="size-4" />
                        </IconButton>
                      )}
                    </div>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      {editing && <SubuserModal subuser={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={refresh} />}
      {removing && (
        <ConfirmDialog
          title="Remove user"
          body={`Remove ${removing.user.username}'s access? Their open consoles are disconnected immediately.`}
          confirm="Remove"
          onClose={() => setRemoving(null)}
          onConfirm={() => api.delete(`${base}/users/${removing.id}`).then(refresh)}
        />
      )}
    </div>
  );
}

function SubuserModal({ subuser, onClose, onSaved }: { subuser: Subuser | null; onClose: () => void; onSaved: () => void }) {
  const { server, base } = useServer();
  const form = useForm({ email: subuser?.user.email ?? '' });
  const [perms, setPerms] = useState<Set<string>>(new Set(subuser?.permissions ?? ['control.console', 'control.command', 'control.start', 'control.stop', 'control.restart']));
  // You can only hand out what you have yourself.
  const grantable = (p: string) => server.permissions.includes(PERMISSION_ALL) || server.permissions.includes(p);

  const toggle = (p: string, on: boolean) =>
    setPerms((s) => {
      const next = new Set(s);
      if (on) next.add(p);
      else next.delete(p);
      return next;
    });

  const onSubmit = form.submit(async (v) => {
    const permissions = [...perms];
    if (subuser) await api.patch(`${base}/users/${subuser.id}`, { permissions });
    else await api.post(`${base}/users`, { email: v.email, permissions });
    onSaved();
    onClose();
  });

  return (
    <Modal open onClose={onClose} title={subuser ? `Permissions for ${subuser.user.username}` : 'Add user'} wide>
      <form onSubmit={onSubmit} className="flex flex-col gap-5">
        {form.error && !form.fieldError('email') && <Alert>{form.error.message}</Alert>}
        {!subuser && (
          <Field label="Email" hint="They need an account on this panel already." error={form.fieldError('email')}>
            {(id) => <Input id={id} type="email" required autoFocus {...form.bind('email')} />}
          </Field>
        )}
        <div className="flex gap-2 text-xs">
          <button type="button" className="text-primary hover:underline" onClick={() => setPerms(new Set(ALL_SERVER_PERMISSIONS.filter(grantable)))}>
            Select all
          </button>
          <span className="text-muted">·</span>
          <button type="button" className="text-primary hover:underline" onClick={() => setPerms(new Set())}>
            Clear
          </button>
        </div>
        <div className="grid max-h-[50vh] gap-4 overflow-y-auto pr-1 sm:grid-cols-2">
          {Object.entries(SERVER_PERMISSIONS).map(([group, def]) => (
            <fieldset key={group} className="rounded-ui border border-border p-3">
              <legend className="px-1 text-sm font-medium capitalize">{group}</legend>
              <p className="mb-2 text-xs text-muted">{def.description}</p>
              <div className="flex flex-col gap-1.5">
                {Object.entries(def.keys).map(([key, label]) => {
                  const p = `${group}.${key}` as ServerPermission;
                  return (
                    <label key={p} className={`flex items-start gap-2 text-sm ${grantable(p) ? '' : 'opacity-40'}`}>
                      <input
                        type="checkbox"
                        className="mt-0.5 accent-[var(--sl-primary)]"
                        checked={perms.has(p)}
                        disabled={!grantable(p)}
                        onChange={(e) => toggle(p, e.target.checked)}
                      />
                      <span>{label as string}</span>
                    </label>
                  );
                })}
              </div>
            </fieldset>
          ))}
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={form.submitting}>
            {subuser ? 'Save' : 'Add user'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
