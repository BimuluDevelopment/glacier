import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { startRegistration } from '@simplewebauthn/browser';
import QRCode from 'qrcode';
import { Fingerprint, KeyRound, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { API_KEY_SCOPES, type ApiKeyScope, type OAuthProvider } from '@glacier/shared';
import { api, errorMessage } from '../../lib/api';
import { useForm } from '../../lib/forms';
import { formatDate, timeAgo } from '../../lib/format';
import { useAuth } from '../../auth/AuthProvider';
import { useTheme } from '../../theme/ThemeProvider';
import { Alert, Badge, Button, Card, CopyField, EmptyState, Field, Input, Modal, Spinner, Table, Td } from '../../components/ui';
import { PROVIDER_LABELS } from '../auth/SignInExtras';

function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const text = codes.join('\n');
  return (
    <div className="flex flex-col gap-4">
      <Alert tone="warning">Save these recovery codes somewhere safe. Each works once if you lose your phone. They won't be shown again.</Alert>
      <pre className="grid grid-cols-2 gap-x-6 gap-y-1 rounded-ui border border-border bg-bg p-4 font-mono text-sm">
        {codes.map((c) => (
          <span key={c}>{c}</span>
        ))}
      </pre>
      <div className="flex gap-2">
        <Button variant="secondary" onClick={() => void navigator.clipboard?.writeText(text)}>
          Copy
        </Button>
        <a href={`data:text/plain;charset=utf-8,${encodeURIComponent(text)}`} download="glacier-recovery-codes.txt">
          <Button variant="secondary" type="button">
            Download
          </Button>
        </a>
        <Button className="ml-auto" onClick={onDone}>
          I've saved them
        </Button>
      </div>
    </div>
  );
}

function TwoFactorCard() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['account', '2fa'], queryFn: () => api.get<{ enabled: boolean; recoveryCodesLeft: number }>('/client/account/two-factor') });
  const [setup, setSetup] = useState<{ secret: string; qr: string } | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [mode, setMode] = useState<'disable' | 'regenerate' | null>(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['account', '2fa'] });
    void qc.invalidateQueries({ queryKey: ['me'] });
  };

  const start = useMutation({
    mutationFn: () => api.post<{ secret: string; otpauthUrl: string }>('/client/account/two-factor/setup'),
    onSuccess: async (r) => setSetup({ secret: r.secret, qr: await QRCode.toDataURL(r.otpauthUrl, { margin: 1, width: 200 }) }),
  });
  const enable = useForm({ code: '' });
  const onEnable = enable.submit(async (v) => {
    const r = await api.post<{ recoveryCodes: string[] }>('/client/account/two-factor/enable', v);
    setSetup(null);
    setCodes(r.recoveryCodes);
    refresh();
  });

  return (
    <Card title="Authenticator app" actions={data?.enabled ? <Badge tone="success">On</Badge> : <Badge>Off</Badge>}>
      {isLoading ? (
        <Spinner />
      ) : codes ? (
        <RecoveryCodes codes={codes} onDone={() => setCodes(null)} />
      ) : setup ? (
        <form onSubmit={onEnable} className="flex flex-col gap-4">
          <p className="text-sm text-muted">Scan this with Google Authenticator, Aegis, 1Password or any authenticator app, then enter the code it shows.</p>
          <div className="flex flex-wrap items-center gap-5">
            <img src={setup.qr} alt="QR code for your authenticator app" className="size-44 rounded-ui bg-white p-1" />
            <div className="min-w-0 flex-1 text-xs text-muted">
              Can't scan? Enter this key manually:
              <code className="mt-1 block break-all font-mono text-sm text-text">{setup.secret}</code>
            </div>
          </div>
          <Field label="Code from the app" error={enable.fieldError('code')}>
            {(id) => <Input id={id} autoFocus inputMode="numeric" autoComplete="one-time-code" className="font-mono tracking-widest" required {...enable.bind('code')} />}
          </Field>
          {enable.error && !enable.fieldError('code') && <Alert>{enable.error.message}</Alert>}
          <div className="flex gap-2">
            <Button type="submit" loading={enable.submitting}>
              Turn on
            </Button>
            <Button type="button" variant="ghost" onClick={() => setSetup(null)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : data?.enabled ? (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-muted">
            Signing in needs a code from your app. {data.recoveryCodesLeft} recovery code{data.recoveryCodesLeft === 1 ? '' : 's'} left.
          </p>
          {data.recoveryCodesLeft <= 3 && <Alert tone="warning">You're running low on recovery codes. Generate new ones.</Alert>}
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => setMode('regenerate')}>
              New recovery codes
            </Button>
            <Button variant="ghost" className="text-danger" onClick={() => setMode('disable')}>
              Turn off
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-muted">Protect your account with a 6-digit code from your phone when you sign in.</p>
          {start.error && <Alert>{start.error.message}</Alert>}
          <Button className="self-start" icon={<ShieldCheck className="size-4" />} loading={start.isPending} onClick={() => start.mutate()}>
            Set up
          </Button>
        </div>
      )}
      {mode && (
        <ConfirmWithPassword
          mode={mode}
          onClose={() => setMode(null)}
          onCodes={(c) => {
            setCodes(c);
            refresh();
          }}
          onDisabled={refresh}
        />
      )}
    </Card>
  );
}

function ConfirmWithPassword({ mode, onClose, onCodes, onDisabled }: { mode: 'disable' | 'regenerate'; onClose: () => void; onCodes: (c: string[]) => void; onDisabled: () => void }) {
  const form = useForm({ password: '', code: '' });
  const onSubmit = form.submit(async (v) => {
    if (mode === 'disable') {
      await api.post('/client/account/two-factor/disable', v);
      onDisabled();
    } else {
      onCodes((await api.post<{ recoveryCodes: string[] }>('/client/account/two-factor/recovery-codes', { password: v.password })).recoveryCodes);
    }
    onClose();
  });
  return (
    <Modal open onClose={onClose} title={mode === 'disable' ? 'Turn off two-factor authentication' : 'Generate new recovery codes'}>
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        {mode === 'regenerate' && <p className="text-sm text-muted">Your old recovery codes stop working.</p>}
        {form.error && !form.fieldError('password') && !form.fieldError('code') && <Alert>{form.error.message}</Alert>}
        <Field label="Password" error={form.fieldError('password')}>{(id) => <Input id={id} type="password" autoComplete="current-password" required autoFocus {...form.bind('password')} />}</Field>
        {mode === 'disable' && (
          <Field label="Code from your app (or a recovery code)" error={form.fieldError('code')}>
            {(id) => <Input id={id} autoComplete="one-time-code" className="font-mono" required {...form.bind('code')} />}
          </Field>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant={mode === 'disable' ? 'danger' : 'primary'} loading={form.submitting}>
            {mode === 'disable' ? 'Turn off' : 'Generate'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

interface PasskeyRow {
  id: string;
  name: string;
  deviceType: string;
  backedUp: boolean;
  lastUsedAt: string | null;
  createdAt: string;
}

function PasskeysCard() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['account', 'passkeys'], queryFn: () => api.get<{ data: PasskeyRow[] }>('/client/account/passkeys').then((r) => r.data) });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['account', 'passkeys'] });
    void qc.invalidateQueries({ queryKey: ['me'] });
  };
  const remove = useMutation({ mutationFn: (id: string) => api.delete(`/client/account/passkeys/${encodeURIComponent(id)}`), onSuccess: refresh });

  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      const options = await api.post<Parameters<typeof startRegistration>[0]['optionsJSON']>('/client/account/passkeys/options');
      const response = await startRegistration({ optionsJSON: options });
      const name = window.prompt('Name this passkey (e.g. "MacBook" or "YubiKey")', 'Passkey') || 'Passkey';
      await api.post('/client/account/passkeys', { name, response });
      refresh();
    } catch (err) {
      if ((err as Error).name !== 'NotAllowedError') setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="Passkeys"
      actions={
        <Button size="sm" variant="secondary" icon={<Plus className="size-4" />} loading={busy} onClick={() => void add()}>
          Add passkey
        </Button>
      }
      padded={false}
    >
      {error && (
        <div className="p-5 pb-0">
          <Alert>{error}</Alert>
        </div>
      )}
      {isLoading ? (
        <div className="p-5">
          <Spinner />
        </div>
      ) : !data?.length ? (
        <EmptyState icon={<Fingerprint className="size-7" />} title="No passkeys yet">
          Sign in with Face ID, Windows Hello, your phone or a security key, without a password.
        </EmptyState>
      ) : (
        <Table head={['Passkey', 'Added', 'Last used', '']}>
          {data.map((p) => (
            <tr key={p.id}>
              <Td>
                <span className="font-medium">{p.name}</span> {p.backedUp && <Badge>synced</Badge>}
              </Td>
              <Td className="text-muted">{formatDate(p.createdAt)}</Td>
              <Td className="text-muted">{p.lastUsedAt ? timeAgo(p.lastUsedAt) : 'never'}</Td>
              <Td className="text-right">
                <button className="rounded p-1.5 text-muted hover:text-danger" aria-label={`Remove ${p.name}`} onClick={() => confirm(`Remove "${p.name}"?`) && remove.mutate(p.id)}>
                  <Trash2 className="size-4" />
                </button>
              </Td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  );
}

function LinkedAccountsCard() {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['account', 'oauth'],
    queryFn: () => api.get<{ providers: OAuthProvider[]; linked: { provider: OAuthProvider; email: string | null; displayName: string | null }[] }>('/client/account/oauth'),
  });
  const unlink = useMutation({ mutationFn: (p: OAuthProvider) => api.delete(`/client/account/oauth/${p}`), onSuccess: () => qc.invalidateQueries({ queryKey: ['account', 'oauth'] }) });
  if (!data || (data.providers.length === 0 && data.linked.length === 0)) return null;
  const providers = [...new Set([...data.providers, ...data.linked.map((l) => l.provider)])];
  return (
    <Card title="Linked logins">
      <div className="flex flex-col gap-3">
        {providers.map((p) => {
          const link = data.linked.find((l) => l.provider === p);
          return (
            <div key={p} className="flex items-center justify-between gap-3">
              <div>
                <div className="font-medium">{PROVIDER_LABELS[p]}</div>
                <div className="text-xs text-muted">{link ? (link.displayName ?? link.email ?? 'Linked') : 'Not linked'}</div>
              </div>
              {link ? (
                <Button size="sm" variant="ghost" loading={unlink.isPending && unlink.variables === p} onClick={() => unlink.mutate(p)}>
                  Unlink
                </Button>
              ) : (
                data.providers.includes(p) && (
                  <a href={`/api/auth/oauth/${p}/start?intent=link`}>
                    <Button size="sm" variant="secondary" type="button" tabIndex={-1}>
                      Link
                    </Button>
                  </a>
                )
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

interface ApiKeyRow {
  id: number;
  identifier: string;
  name: string;
  scopes: ApiKeyScope[];
  allowedIps: string[];
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

function ApiKeysCard() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const { data, isLoading } = useQuery({ queryKey: ['account', 'api-keys'], queryFn: () => api.get<{ data: ApiKeyRow[] }>('/client/account/api-keys').then((r) => r.data) });
  const [creating, setCreating] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const remove = useMutation({ mutationFn: (id: number) => api.delete(`/client/account/api-keys/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ['account', 'api-keys'] }) });

  return (
    <Card
      title="API keys"
      padded={false}
      actions={
        <Button size="sm" variant="secondary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
          New key
        </Button>
      }
    >
      {token && (
        <div className="flex flex-col gap-2 border-b border-border p-5">
          <Alert tone="success">Copy this key now. It won't be shown again.</Alert>
          <CopyField value={token} />
          <p className="text-xs text-muted">
            Send it as <code className="font-mono">Authorization: Bearer &lt;key&gt;</code>.
          </p>
        </div>
      )}
      {isLoading ? (
        <div className="p-5">
          <Spinner />
        </div>
      ) : !data?.length ? (
        <EmptyState icon={<KeyRound className="size-7" />} title="No API keys">
          Use the API from scripts, bots or automation tools.
        </EmptyState>
      ) : (
        <Table head={['Key', 'Scopes', 'Last used', '']}>
          {data.map((k) => (
            <tr key={k.id}>
              <Td>
                <div className="font-medium">{k.name}</div>
                <div className="font-mono text-xs text-muted">
                  glacier_{k.identifier}_…{k.expiresAt && <span className="font-sans"> · expires {formatDate(k.expiresAt)}</span>}
                </div>
              </Td>
              <Td>
                <div className="flex flex-wrap gap-1">
                  {k.scopes.map((s) => (
                    <Badge key={s}>{s}</Badge>
                  ))}
                </div>
              </Td>
              <Td className="text-muted">{k.lastUsedAt ? timeAgo(k.lastUsedAt) : 'never'}</Td>
              <Td className="text-right">
                <button className="rounded p-1.5 text-muted hover:text-danger" aria-label={`Revoke ${k.name}`} onClick={() => confirm(`Revoke "${k.name}"? Anything using it stops working.`) && remove.mutate(k.id)}>
                  <Trash2 className="size-4" />
                </button>
              </Td>
            </tr>
          ))}
        </Table>
      )}
      {creating && (
        <CreateKeyModal
          isAdmin={Boolean(user?.rootAdmin)}
          onClose={() => setCreating(false)}
          onCreated={(t) => {
            setToken(t);
            void qc.invalidateQueries({ queryKey: ['account', 'api-keys'] });
          }}
        />
      )}
    </Card>
  );
}

function CreateKeyModal({ isAdmin, onClose, onCreated }: { isAdmin: boolean; onClose: () => void; onCreated: (token: string) => void }) {
  const [scopes, setScopes] = useState<ApiKeyScope[]>(['client:read']);
  const form = useForm({ name: '', allowedIps: '', expiresInDays: '' });
  const onSubmit = form.submit(async (v) => {
    const res = await api.post<{ token: string }>('/client/account/api-keys', {
      name: v.name,
      scopes,
      allowedIps: v.allowedIps.split(/[\s,]+/).filter(Boolean),
      expiresInDays: v.expiresInDays ? Number(v.expiresInDays) : null,
    });
    onCreated(res.token);
    onClose();
  });
  return (
    <Modal open onClose={onClose} title="New API key">
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        {form.error && <Alert>{form.error.message}</Alert>}
        <Field label="Name">{(id) => <Input id={id} required autoFocus placeholder="Discord bot" {...form.bind('name')} />}</Field>
        <div>
          <p className="mb-2 text-sm font-medium">What it can do</p>
          <div className="flex flex-col gap-2">
            {(Object.entries(API_KEY_SCOPES) as [ApiKeyScope, string][])
              .filter(([s]) => isAdmin || !s.startsWith('admin:'))
              .map(([s, label]) => (
                <label key={s} className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="mt-0.5 accent-[var(--sl-primary)]"
                    checked={scopes.includes(s)}
                    onChange={(e) => setScopes((cur) => (e.target.checked ? [...cur, s] : cur.filter((x) => x !== s)))}
                  />
                  <span>
                    <code className="font-mono text-xs">{s}</code> <span className="text-muted">— {label}</span>
                  </span>
                </label>
              ))}
          </div>
        </div>
        <Field label="Only from these IPs (optional)" hint="Space or comma separated IPs or ranges, e.g. 203.0.113.5 10.0.0.0/8">
          {(id) => <Input id={id} {...form.bind('allowedIps')} />}
        </Field>
        <Field label="Expires after (days, optional)">{(id) => <Input id={id} type="number" min={1} max={3650} {...form.bind('expiresInDays')} />}</Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={form.submitting} disabled={!scopes.length}>
            Create key
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** Account → Security. Shown first (and highlighted) when the admin requires 2FA. */
export function SecuritySection() {
  const { mustSetupTwoFactor } = useAuth();
  const { branding } = useTheme();
  useEffect(() => {
    if (window.location.hash === '#security') document.getElementById('security')?.scrollIntoView();
  }, []);
  return (
    <section id="security" className="flex flex-col gap-6 lg:col-span-2">
      <h2 className="text-lg font-semibold">Security</h2>
      {mustSetupTwoFactor && (
        <Alert tone="warning">
          Your administrator requires two-factor authentication. Set up an authenticator app{branding.features.passkeys ? ' or add a passkey' : ''} to keep using the panel.
        </Alert>
      )}
      <div className="grid gap-6 lg:grid-cols-2">
        <TwoFactorCard />
        {branding.features.passkeys && <PasskeysCard />}
        <LinkedAccountsCard />
      </div>
      <ApiKeysCard />
    </section>
  );
}
