import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { api, errorMessage } from '../lib/api';
import { useForm } from '../lib/forms';
import { formatDate } from '../lib/format';
import { useT } from '../theme/i18n';
import { PublicShell } from '../features/landing/Landing';
import { AuthLayout } from '../components/layout';
import { Alert, Badge, Button, Field, Input, PageLoader } from '../components/ui';

/** Custom pages (/p/terms, ...). The HTML comes from the server's safe Markdown renderer. */
export function CustomPage() {
  const { slug = '' } = useParams();
  const { data, isLoading, error } = useQuery({
    queryKey: ['page', slug],
    queryFn: () => api.get<{ title: string; html: string; published: boolean; updatedAt: string }>(`/public/pages/${encodeURIComponent(slug)}`),
    retry: false,
  });
  return (
    <PublicShell>
      <article className="mx-auto w-full max-w-3xl px-4 py-14 sm:px-6">
        {isLoading ? (
          <PageLoader />
        ) : error || !data ? (
          <div className="py-20 text-center">
            <h1 className="text-2xl font-semibold">Page not found</h1>
            <Link to="/" className="mt-4 inline-block text-primary hover:underline">
              Go home
            </Link>
          </div>
        ) : (
          <>
            {!data.published && (
              <div className="mb-6">
                <Badge tone="warning">Draft: only admins can see this</Badge>
              </div>
            )}
            <div className="sl-prose" dangerouslySetInnerHTML={{ __html: data.html }} />
            <p className="mt-12 text-xs text-muted">Last updated {formatDate(data.updatedAt)}</p>
          </>
        )}
      </article>
    </PublicShell>
  );
}

export function ForgotPasswordPage() {
  const t = useT();
  const [sent, setSent] = useState(false);
  const form = useForm({ email: '' });
  const onSubmit = form.submit(async (v) => {
    await api.post('/auth/forgot-password', v);
    setSent(true);
  });
  return (
    <AuthLayout title={t('auth.forgot.title')} subtitle={sent ? undefined : t('auth.forgot.description')}>
      {sent ? (
        <Alert tone="success">{t('auth.forgot.sent')}</Alert>
      ) : (
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          {form.error && !form.fieldError('email') && <Alert>{form.error.message}</Alert>}
          <Field label="Email" error={form.fieldError('email')}>
            {(id) => <Input id={id} type="email" autoComplete="email" required autoFocus {...form.bind('email')} />}
          </Field>
          <Button type="submit" loading={form.submitting} className="w-full">
            {t('auth.forgot.button')}
          </Button>
        </form>
      )}
      <p className="mt-5 text-center text-sm">
        <Link to="/login" className="text-primary hover:underline">
          {t('auth.signIn.title')}
        </Link>
      </p>
    </AuthLayout>
  );
}

export function ResetPasswordPage() {
  const t = useT();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [confirm, setConfirm] = useState('');
  const form = useForm({ password: '' });
  const onSubmit = form.submit(async (v) => {
    if (v.password !== confirm) throw new Error('The passwords do not match.');
    await api.post('/auth/reset-password', { token, password: v.password });
    navigate('/login?reset=1', { replace: true });
  });
  return (
    <AuthLayout title={t('auth.reset.title')}>
      {!token ? (
        <Alert>This link is incomplete. Open the link from your email again.</Alert>
      ) : (
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          {form.error && !form.fieldError('password') && (
            <Alert>
              {errorMessage(form.error)}{' '}
              {form.fieldError('token') && (
                <Link to="/forgot-password" className="underline">
                  Request a new link
                </Link>
              )}
            </Alert>
          )}
          <Field label="New password" hint="At least 8 characters." error={form.fieldError('password')}>
            {(id) => <Input id={id} type="password" autoComplete="new-password" required autoFocus {...form.bind('password')} />}
          </Field>
          <Field label="Repeat password">
            {(id) => <Input id={id} type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} />}
          </Field>
          <Button type="submit" loading={form.submitting} className="w-full">
            {t('auth.reset.button')}
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}
