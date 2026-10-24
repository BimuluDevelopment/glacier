import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { useForm } from '../lib/forms';
import { useAuth, type CurrentUser } from '../auth/AuthProvider';
import { useTheme } from '../theme/ThemeProvider';
import { useT } from '../theme/i18n';
import { AuthLayout } from '../components/layout';
import { Alert, Button, Field, Input } from '../components/ui';
import { AlternativeSignIns, OAUTH_ERRORS, TwoFactorStep } from '../features/auth/SignInExtras';

function FormError({ error }: { error: Error | null }) {
  if (!error) return null;
  // Field-level errors are shown next to their inputs.
  if (error instanceof ApiError && error.status === 422 && error.details?.length) return null;
  return <Alert>{error.message}</Alert>;
}

export function LoginPage() {
  const { setUser } = useAuth();
  const { branding } = useTheme();
  const t = useT();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  // A social login for an account with 2FA comes back as /login?ticket=...
  const [ticket, setTicket] = useState<string | null>(params.get('ticket'));
  const [recoveryWarning, setRecoveryWarning] = useState<number | null>(null);
  const form = useForm({ login: '', password: '' });
  const oauthError = params.get('oauthError');

  const finish = (user: CurrentUser, recoveryLeft?: number) => {
    setUser(user);
    if (recoveryLeft !== undefined && recoveryLeft <= 3) setRecoveryWarning(recoveryLeft);
    else navigate('/');
  };

  const onSubmit = form.submit(async (values) => {
    const res = await api.post<{ user?: CurrentUser; twoFactor?: { ticket: string } }>('/auth/login', values);
    if (res.twoFactor) setTicket(res.twoFactor.ticket);
    else finish(res.user!);
  });

  if (recoveryWarning !== null) {
    return (
      <AuthLayout title="Running low on recovery codes">
        <Alert tone="warning">
          You have {recoveryWarning} recovery code{recoveryWarning === 1 ? '' : 's'} left. Generate new ones from your account's security settings.
        </Alert>
        <Button className="mt-5 w-full" onClick={() => navigate('/account#security')}>
          Go to security settings
        </Button>
      </AuthLayout>
    );
  }

  if (ticket) {
    return (
      <AuthLayout title="Two-factor authentication">
        <TwoFactorStep
          ticket={ticket}
          onDone={finish}
          onCancel={() => {
            setTicket(null);
            setParams({});
          }}
        />
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title={t('auth.signIn.title')} subtitle={branding.auth.loginMessage || undefined}>
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        {params.get('reset') && <Alert tone="success">Your password was changed. Sign in with the new one.</Alert>}
        {oauthError && <Alert>{OAUTH_ERRORS[oauthError] ?? 'Sign-in failed. Please try again.'}</Alert>}
        <FormError error={form.error} />
        <Field label={t('auth.login')} error={form.fieldError('login')}>
          {(id) => <Input id={id} autoComplete="username" autoFocus required {...form.bind('login')} />}
        </Field>
        <Field label={t('auth.password')} error={form.fieldError('password')}>
          {(id) => <Input id={id} type="password" autoComplete="current-password" required {...form.bind('password')} />}
        </Field>
        {branding.mailEnabled && (
          <Link to="/forgot-password" className="-mt-2 self-end text-xs text-muted hover:text-primary">
            {t('auth.forgot')}
          </Link>
        )}
        <Button type="submit" loading={form.submitting} className="mt-1 w-full">
          {t('auth.signIn.button')}
        </Button>
        {branding.features.registration && (
          <p className="text-center text-sm text-muted">
            {t('auth.newHere')}{' '}
            <Link to="/register" className="font-medium text-primary hover:underline">
              {t('auth.createAccount')}
            </Link>
          </p>
        )}
      </form>
      <AlternativeSignIns passkeys={branding.features.passkeys} providers={branding.oauthProviders} onPasskey={(user) => finish(user)} />
    </AuthLayout>
  );
}

export function RegisterPage() {
  const { setUser } = useAuth();
  const t = useT();
  const navigate = useNavigate();
  const form = useForm({ email: '', username: '', password: '' });

  const onSubmit = form.submit(async (values) => {
    const { user } = await api.post<{ user: CurrentUser }>('/auth/register', values);
    setUser(user);
    navigate('/');
  });

  return (
    <AuthLayout title={t('auth.register.title')}>
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <FormError error={form.error} />
        <Field label="Email" error={form.fieldError('email')}>
          {(id) => <Input id={id} type="email" autoComplete="email" required {...form.bind('email')} />}
        </Field>
        <Field label="Username" error={form.fieldError('username')}>
          {(id) => <Input id={id} autoComplete="username" required {...form.bind('username')} />}
        </Field>
        <Field label="Password" hint="At least 8 characters." error={form.fieldError('password')}>
          {(id) => <Input id={id} type="password" autoComplete="new-password" required {...form.bind('password')} />}
        </Field>
        <Button type="submit" loading={form.submitting} className="mt-1 w-full">
          {t('auth.register.button')}
        </Button>
        <p className="text-center text-sm text-muted">
          {t('auth.haveAccount')}{' '}
          <Link to="/login" className="font-medium text-primary hover:underline">
            {t('auth.signIn.title')}
          </Link>
        </p>
      </form>
    </AuthLayout>
  );
}

/** First-run wizard: shown until a root admin exists. */
export function SetupPage() {
  const { setUser } = useAuth();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const form = useForm({ panelName: 'Glacier Panel', email: '', username: 'admin', password: '' });

  const onSubmit = form.submit(async (values) => {
    const { user } = await api.post<{ user: CurrentUser }>('/public/setup', values);
    setUser(user);
    await qc.invalidateQueries({ queryKey: ['branding'] });
    navigate('/admin/nodes?welcome=1');
  });

  return (
    <AuthLayout title="Welcome to Glacier Panel" subtitle="Create the administrator account to finish setting up your panel.">
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <FormError error={form.error} />
        <Field label="Panel name" hint="Shown in the header and browser tab. You can change it later." error={form.fieldError('panelName')}>
          {(id) => <Input id={id} required {...form.bind('panelName')} />}
        </Field>
        <Field label="Admin email" error={form.fieldError('email')}>
          {(id) => <Input id={id} type="email" autoComplete="email" required autoFocus {...form.bind('email')} />}
        </Field>
        <Field label="Admin username" error={form.fieldError('username')}>
          {(id) => <Input id={id} autoComplete="username" required {...form.bind('username')} />}
        </Field>
        <Field label="Password" hint="At least 8 characters." error={form.fieldError('password')}>
          {(id) => <Input id={id} type="password" autoComplete="new-password" required {...form.bind('password')} />}
        </Field>
        <Button type="submit" loading={form.submitting} className="mt-1 w-full">
          Finish setup
        </Button>
      </form>
    </AuthLayout>
  );
}

export function MaintenancePage() {
  const { branding } = useTheme();
  const { logout } = useAuth();
  const t = useT();
  return (
    <AuthLayout title={t('maintenance.title')}>
      <p className="text-sm text-muted">{branding.general.maintenanceMessage}</p>
      <Button variant="secondary" className="mt-5 w-full" onClick={() => void logout()}>
        Sign out
      </Button>
    </AuthLayout>
  );
}
