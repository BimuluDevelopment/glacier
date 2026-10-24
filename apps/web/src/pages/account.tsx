import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { SecuritySection } from '../features/account/Security';
import { OAUTH_ERRORS, PROVIDER_LABELS } from '../features/auth/SignInExtras';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Monitor } from 'lucide-react';
import { api, type Paged } from '../lib/api';
import { useForm } from '../lib/forms';
import { formatDate, timeAgo } from '../lib/format';
import type { ActivityEntry } from '../lib/types';
import { useAuth, type CurrentUser } from '../auth/AuthProvider';
import { Alert, Badge, Button, Card, Field, Input, PageHeader, Spinner, Table, Td } from '../components/ui';

export function AccountPage() {
  const [params] = useSearchParams();
  const linked = params.get('linked') as keyof typeof PROVIDER_LABELS | null;
  const oauthError = params.get('oauthError');
  return (
    <>
      <PageHeader title="Account" description="Your profile, password, security and sign-in sessions." />
      {linked && PROVIDER_LABELS[linked] && (
        <div className="mb-6">
          <Alert tone="success">Your {PROVIDER_LABELS[linked]} login is now linked. You can use it to sign in.</Alert>
        </div>
      )}
      {oauthError && (
        <div className="mb-6">
          <Alert>{OAUTH_ERRORS[oauthError] ?? 'Linking failed. Please try again.'}</Alert>
        </div>
      )}
      <div className="grid gap-6 lg:grid-cols-2">
        <SecuritySection />
        <ProfileCard />
        <PasswordCard />
        <div className="lg:col-span-2">
          <SessionsCard />
        </div>
        <div className="lg:col-span-2">
          <ActivityCard />
        </div>
      </div>
    </>
  );
}

function ProfileCard() {
  const { user, setUser } = useAuth();
  const [saved, setSaved] = useState(false);
  const form = useForm({ email: user?.email ?? '', username: user?.username ?? '', firstName: user?.firstName ?? '', lastName: user?.lastName ?? '' });
  const onSubmit = form.submit(async (v) => {
    setSaved(false);
    const { user: updated } = await api.patch<{ user: CurrentUser }>('/client/account', {
      ...v,
      firstName: v.firstName || null,
      lastName: v.lastName || null,
    });
    setUser(updated);
    setSaved(true);
  });
  return (
    <Card title="Profile">
      <form onSubmit={onSubmit} className="grid gap-4 sm:grid-cols-2">
        {form.error && !form.fieldError('email') && !form.fieldError('username') && (
          <div className="sm:col-span-2">
            <Alert>{form.error.message}</Alert>
          </div>
        )}
        <Field label="First name">{(id) => <Input id={id} {...form.bind('firstName')} />}</Field>
        <Field label="Last name">{(id) => <Input id={id} {...form.bind('lastName')} />}</Field>
        <Field label="Email" error={form.fieldError('email')} className="sm:col-span-2">
          {(id) => <Input id={id} type="email" {...form.bind('email')} />}
        </Field>
        <Field label="Username" error={form.fieldError('username')} className="sm:col-span-2">
          {(id) => <Input id={id} {...form.bind('username')} />}
        </Field>
        <div className="flex items-center gap-3 sm:col-span-2">
          <Button type="submit" loading={form.submitting}>
            Save profile
          </Button>
          {saved && <span className="text-sm text-success">Saved.</span>}
        </div>
      </form>
    </Card>
  );
}

function PasswordCard() {
  const qc = useQueryClient();
  const [done, setDone] = useState(false);
  const form = useForm({ currentPassword: '', newPassword: '' });
  const onSubmit = form.submit(async (v) => {
    setDone(false);
    await api.put('/client/account/password', v);
    form.setValues({ currentPassword: '', newPassword: '' });
    setDone(true);
    void qc.invalidateQueries({ queryKey: ['account', 'sessions'] });
  });
  return (
    <Card title="Password">
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        {form.error && !form.fieldError('currentPassword') && !form.fieldError('newPassword') && <Alert>{form.error.message}</Alert>}
        <Field label="Current password" error={form.fieldError('currentPassword')}>
          {(id) => <Input id={id} type="password" autoComplete="current-password" {...form.bind('currentPassword')} />}
        </Field>
        <Field label="New password" hint="At least 8 characters. Other devices will be signed out." error={form.fieldError('newPassword')}>
          {(id) => <Input id={id} type="password" autoComplete="new-password" {...form.bind('newPassword')} />}
        </Field>
        <div className="flex items-center gap-3">
          <Button type="submit" loading={form.submitting}>
            Change password
          </Button>
          {done && <span className="text-sm text-success">Password changed.</span>}
        </div>
      </form>
    </Card>
  );
}

interface SessionRow {
  id: string;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
  lastSeenAt: string;
  current: boolean;
}

function describeAgent(ua: string | null) {
  if (!ua) return 'Unknown device';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'macOS' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}

function SessionsCard() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['account', 'sessions'], queryFn: () => api.get<{ data: SessionRow[] }>('/client/account/sessions') });
  const revoke = useMutation({
    mutationFn: (id: string) => api.delete(`/client/account/sessions/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['account', 'sessions'] }),
  });
  return (
    <Card title="Sessions" padded={false}>
      {isLoading ? (
        <div className="p-5">
          <Spinner />
        </div>
      ) : (
        <Table head={['Device', 'IP address', 'Last active', '']}>
          {data?.data.map((s) => (
            <tr key={s.id}>
              <Td>
                <span className="flex items-center gap-2">
                  <Monitor className="size-4 text-muted" />
                  {describeAgent(s.userAgent)}
                  {s.current && <Badge tone="primary">This device</Badge>}
                </span>
              </Td>
              <Td className="font-mono text-xs">{s.ip ?? '—'}</Td>
              <Td className="text-muted" >
                <span title={formatDate(s.lastSeenAt)}>{timeAgo(s.lastSeenAt)}</span>
              </Td>
              <Td className="text-right">
                {!s.current && (
                  <Button variant="ghost" size="sm" onClick={() => revoke.mutate(s.id)} loading={revoke.isPending && revoke.variables === s.id}>
                    Sign out
                  </Button>
                )}
              </Td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  );
}

export function ActivityTable({ rows, showServer }: { rows: ActivityEntry[]; showServer?: boolean }) {
  return (
    <Table head={['Event', 'By', ...(showServer ? ['Server'] : []), 'IP', 'When']}>
      {rows.map((r) => (
        <tr key={r.id}>
          <Td>
            <code className="font-mono text-xs">{r.event}</code>
          </Td>
          <Td>{r.actor?.username ?? <span className="text-muted">system</span>}</Td>
          {showServer && <Td>{r.server?.name ?? '—'}</Td>}
          <Td className="font-mono text-xs text-muted">{r.ip ?? '—'}</Td>
          <Td className="text-muted">
            <span title={formatDate(r.createdAt)}>{timeAgo(r.createdAt)}</span>
          </Td>
        </tr>
      ))}
    </Table>
  );
}

function ActivityCard() {
  const { data, isLoading } = useQuery({
    queryKey: ['account', 'activity'],
    queryFn: () => api.get<Paged<ActivityEntry>>('/client/account/activity?perPage=20'),
  });
  return (
    <Card title="Recent activity" padded={false}>
      {isLoading ? (
        <div className="p-5">
          <Spinner />
        </div>
      ) : (
        <ActivityTable rows={data?.data ?? []} />
      )}
    </Card>
  );
}
