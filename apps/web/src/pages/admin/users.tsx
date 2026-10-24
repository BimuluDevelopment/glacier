import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Search } from 'lucide-react';
import { api, type Paged } from '../../lib/api';
import { useForm } from '../../lib/forms';
import { formatDate } from '../../lib/format';
import { useAuth } from '../../auth/AuthProvider';
import { Alert, Badge, Button, Card, Field, Input, Modal, PageHeader, PageLoader, Switch, Table, Td } from '../../components/ui';

interface AdminUser {
  id: string;
  email: string;
  username: string;
  firstName: string | null;
  lastName: string | null;
  rootAdmin: boolean;
  createdAt: string;
  serverCount: number;
}

export function UsersPage() {
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<AdminUser | 'new' | null>(null);
  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'users', search, page],
    queryFn: () => api.get<Paged<AdminUser>>(`/admin/users?page=${page}&search=${encodeURIComponent(search)}`),
  });

  return (
    <>
      <PageHeader
        title="Users"
        actions={
          <>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
              <Input
                placeholder="Search email or username"
                className="w-64 pl-9"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(1);
                }}
              />
            </div>
            <Button icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>
              New user
            </Button>
          </>
        }
      />
      <Card padded={false}>
        {isLoading ? (
          <PageLoader />
        ) : (
          <Table head={['User', 'Email', 'Servers', 'Created', '']}>
            {data?.data.map((u) => (
              <tr key={u.id} className="hover:bg-surface-alt/50">
                <Td>
                  <span className="font-medium">{u.username}</span> {u.rootAdmin && <Badge tone="primary">admin</Badge>}
                </Td>
                <Td className="text-muted">{u.email}</Td>
                <Td>{u.serverCount}</Td>
                <Td className="text-muted">{formatDate(u.createdAt)}</Td>
                <Td className="text-right">
                  <Button variant="ghost" size="sm" onClick={() => setEditing(u)}>
                    Edit
                  </Button>
                </Td>
              </tr>
            ))}
          </Table>
        )}
        {data && data.meta.pages > 1 && (
          <div className="flex items-center justify-between border-t border-border px-5 py-3 text-sm text-muted">
            <span>
              Page {data.meta.page} of {data.meta.pages} · {data.meta.total} users
            </span>
            <div className="flex gap-2">
              <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                Previous
              </Button>
              <Button size="sm" variant="secondary" disabled={page >= data.meta.pages} onClick={() => setPage((p) => p + 1)}>
                Next
              </Button>
            </div>
          </div>
        )}
      </Card>
      {editing && <UserModal user={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function UserModal({ user, onClose }: { user: AdminUser | null; onClose: () => void }) {
  const qc = useQueryClient();
  const { user: me } = useAuth();
  const form = useForm({
    email: user?.email ?? '',
    username: user?.username ?? '',
    firstName: user?.firstName ?? '',
    lastName: user?.lastName ?? '',
    password: '',
    rootAdmin: user?.rootAdmin ?? false,
  });
  const done = () => {
    void qc.invalidateQueries({ queryKey: ['admin', 'users'] });
    onClose();
  };
  const onSubmit = form.submit(async (v) => {
    const body = { ...v, firstName: v.firstName || null, lastName: v.lastName || null, password: v.password || undefined };
    if (user) await api.patch(`/admin/users/${user.id}`, body);
    else await api.post('/admin/users', body);
    done();
  });
  const remove = useMutation({ mutationFn: () => api.delete(`/admin/users/${user!.id}`), onSuccess: done });

  return (
    <Modal open onClose={onClose} title={user ? `Edit ${user.username}` : 'New user'}>
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        {(form.error || remove.error) && !form.fieldError('email') && !form.fieldError('username') && !form.fieldError('password') && (
          <Alert>{(form.error ?? remove.error)!.message}</Alert>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label="First name">{(id) => <Input id={id} {...form.bind('firstName')} />}</Field>
          <Field label="Last name">{(id) => <Input id={id} {...form.bind('lastName')} />}</Field>
        </div>
        <Field label="Email" error={form.fieldError('email')}>{(id) => <Input id={id} type="email" required {...form.bind('email')} />}</Field>
        <Field label="Username" error={form.fieldError('username')}>{(id) => <Input id={id} required {...form.bind('username')} />}</Field>
        <Field label={user ? 'New password' : 'Password'} hint={user ? 'Leave empty to keep the current password. Changing it signs the user out everywhere.' : undefined} error={form.fieldError('password')}>
          {(id) => <Input id={id} type="password" autoComplete="new-password" required={!user} {...form.bind('password')} />}
        </Field>
        <Switch
          checked={form.values.rootAdmin}
          onChange={(v) => form.set('rootAdmin', v)}
          disabled={user?.id === me?.id}
          label="Administrator"
          description="Full access to the admin area and every server."
        />
        <div className="mt-2 flex items-center justify-between gap-2">
          {user && user.id !== me?.id ? (
            <Button
              type="button"
              variant="ghost"
              className="text-danger"
              loading={remove.isPending}
              onClick={() => confirm(`Delete ${user.username}? This cannot be undone.`) && remove.mutate()}
            >
              Delete user
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={form.submitting}>
              {user ? 'Save' : 'Create user'}
            </Button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
