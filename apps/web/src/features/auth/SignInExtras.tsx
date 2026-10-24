import { useState } from 'react';
import { startAuthentication } from '@simplewebauthn/browser';
import { Fingerprint } from 'lucide-react';
import type { OAuthProvider } from '@glacier/shared';
import { api, errorMessage } from '../../lib/api';
import { useForm } from '../../lib/forms';
import type { CurrentUser } from '../../auth/AuthProvider';
import { Alert, Button, Field, Input } from '../../components/ui';

export const PROVIDER_LABELS: Record<OAuthProvider, string> = { discord: 'Discord', google: 'Google', github: 'GitHub' };

/** Why a social sign-in bounced back to /login (?oauthError=...). */
export const OAUTH_ERRORS: Record<string, string> = {
  expired: 'That sign-in took too long or was started in another browser. Please try again.',
  cancelled: 'Sign-in was cancelled.',
  provider_error: "The provider didn't confirm who you are. Please try again.",
  code_expired: 'The sign-in code from the provider expired or was already used. Please try again.',
  bad_credentials: 'The panel’s client ID or secret for this provider is wrong. An admin needs to re-enter them under Admin → Security.',
  redirect_mismatch: 'The redirect URL registered with the provider doesn’t match this panel. An admin needs to copy it from Admin → Security into the provider’s app settings.',
  no_account: 'No account is linked to that login. Sign in with your password, then link it from your account page.',
  link_required: 'An account with that email already exists. Sign in with your password, then link this login from your account page.',
  email_unverified: 'That account has no verified email address.',
  linked_elsewhere: 'That login is already linked to a different account.',
  signed_out: 'You were signed out. Sign in and try linking again.',
  maintenance: 'The panel is in maintenance mode.',
};

/** Second sign-in step: a code from the authenticator app, or a recovery code. */
export function TwoFactorStep({ ticket, onDone, onCancel }: { ticket: string; onDone: (user: CurrentUser, recoveryLeft?: number) => void; onCancel: () => void }) {
  const [recovery, setRecovery] = useState(false);
  const form = useForm({ code: '' });
  const onSubmit = form.submit(async (v) => {
    const res = await api.post<{ user: CurrentUser; recoveryCodesLeft?: number }>('/auth/login/2fa', { ticket, code: v.code });
    onDone(res.user, res.recoveryCodesLeft);
  });
  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <p className="text-sm text-muted">
        {recovery ? 'Enter one of the recovery codes you saved when you turned on two-factor authentication.' : 'Open your authenticator app and enter the 6-digit code.'}
      </p>
      {form.error && !form.fieldError('code') && <Alert>{form.error.message}</Alert>}
      <Field label={recovery ? 'Recovery code' : 'Code'} error={form.fieldError('code')}>
        {(id) => (
          <Input
            id={id}
            autoFocus
            required
            autoComplete="one-time-code"
            inputMode={recovery ? 'text' : 'numeric'}
            placeholder={recovery ? 'xxxx-xxxx-xxxx' : '123456'}
            className="font-mono tracking-widest"
            {...form.bind('code')}
          />
        )}
      </Field>
      <Button type="submit" loading={form.submitting} className="w-full">
        Verify
      </Button>
      <div className="flex justify-between text-xs">
        <button type="button" className="text-muted hover:text-primary" onClick={() => setRecovery((r) => !r)}>
          {recovery ? 'Use the authenticator app' : 'Use a recovery code'}
        </button>
        <button type="button" className="text-muted hover:text-primary" onClick={onCancel}>
          Start over
        </button>
      </div>
    </form>
  );
}

/** "Sign in with a passkey" and the social login buttons. */
export function AlternativeSignIns({ passkeys, providers, onPasskey }: { passkeys: boolean; providers: OAuthProvider[]; onPasskey: (user: CurrentUser) => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const passkeysSupported = typeof window !== 'undefined' && 'PublicKeyCredential' in window;
  if (!(passkeys && passkeysSupported) && providers.length === 0) return null;

  const signInWithPasskey = async () => {
    setBusy(true);
    setError(null);
    try {
      const { requestId, options } = await api.post<{ requestId: string; options: Parameters<typeof startAuthentication>[0]['optionsJSON'] }>('/auth/passkey/options');
      const response = await startAuthentication({ optionsJSON: options });
      const { user } = await api.post<{ user: CurrentUser }>('/auth/passkey/verify', { requestId, response });
      onPasskey(user);
    } catch (err) {
      // Closing the browser's passkey prompt isn't an error worth shouting about.
      if ((err as Error).name !== 'NotAllowedError') setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-5 flex flex-col gap-2">
      <div className="flex items-center gap-3 text-xs text-muted">
        <span className="h-px flex-1 bg-border" /> or <span className="h-px flex-1 bg-border" />
      </div>
      {error && <Alert>{error}</Alert>}
      {passkeys && passkeysSupported && (
        <Button variant="secondary" className="w-full" loading={busy} icon={<Fingerprint className="size-4" />} onClick={() => void signInWithPasskey()}>
          Sign in with a passkey
        </Button>
      )}
      {providers.map((p) => (
        // A full-page navigation: the provider redirects back to the API, which sets the session.
        <a key={p} href={`/api/auth/oauth/${p}/start`} className="w-full">
          <Button variant="secondary" className="w-full" type="button" tabIndex={-1}>
            Continue with {PROVIDER_LABELS[p]}
          </Button>
        </a>
      ))}
    </div>
  );
}
