import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import type { OAuthProvider, Settings } from '@glacier/shared';
import { api, ApiError } from '../../lib/api';
import { Alert, Badge, Button, Card, CopyField, Field, Input, PageHeader, PageLoader, Select, Switch, Textarea } from '../../components/ui';
import { useAdminSettings, useSaveSection } from './useSettings';

interface ProviderState {
  label: string;
  enabled: boolean;
  clientId: string;
  secretSet: boolean;
  callbackUrl: string;
}

const PROVIDER_HELP: Record<OAuthProvider, { url: string; where: string }> = {
  discord: { url: 'https://discord.com/developers/applications', where: 'Discord Developer Portal → your app → OAuth2' },
  google: { url: 'https://console.cloud.google.com/apis/credentials', where: 'Google Cloud Console → Credentials → OAuth client ID (Web application)' },
  github: { url: 'https://github.com/settings/developers', where: 'GitHub → Settings → Developer settings → OAuth Apps' },
};

export function SecurityPage() {
  const { data, isLoading } = useAdminSettings();
  if (isLoading || !data) return <PageLoader />;
  return (
    <>
      <PageHeader title="Security" description="Two-factor rules, admin access and social login." />
      <div className="flex flex-col gap-6">
        <PolicyCard initial={data.auth} />
        <SocialLoginCard enabled={data.features.oauth} />
      </div>
    </>
  );
}

function PolicyCard({ initial }: { initial: Settings['auth'] }) {
  const save = useSaveSection('auth');
  const [require2fa, setRequire2fa] = useState(initial.require2fa);
  const [allowlist, setAllowlist] = useState(initial.adminIpAllowlist.join('\n'));
  const fieldError = save.error instanceof ApiError ? save.error.field('adminIpAllowlist') : undefined;
  return (
    <Card title="Policies">
      <div className="grid gap-5 md:grid-cols-2">
        <Field label="Require two-factor authentication" hint="Users without an authenticator app or passkey must set one up before they can do anything else.">
          {(id) => (
            <Select id={id} value={require2fa} onChange={(e) => setRequire2fa(e.target.value as Settings['auth']['require2fa'])}>
              <option value="none">Optional for everyone</option>
              <option value="admins">Required for administrators</option>
              <option value="everyone">Required for everyone</option>
            </Select>
          )}
        </Field>
        <Field
          label="Admin area allowed from"
          hint="One IP or range per line (e.g. 203.0.113.5 or 10.0.0.0/8). Empty allows any address. Your current IP must be included."
          error={fieldError}
        >
          {(id) => <Textarea id={id} rows={4} className="font-mono text-xs" value={allowlist} onChange={(e) => setAllowlist(e.target.value)} />}
        </Field>
      </div>
      {save.error && !fieldError && (
        <div className="mt-4">
          <Alert>{save.error.message}</Alert>
        </div>
      )}
      <div className="mt-5 flex items-center gap-3">
        <Button loading={save.isPending} onClick={() => save.mutate({ require2fa, adminIpAllowlist: allowlist.split(/\s+/).filter(Boolean) })}>
          Save
        </Button>
        {save.isSuccess && <span className="flex items-center gap-1 text-sm text-success"><Check className="size-4" /> Saved</span>}
      </div>
    </Card>
  );
}

function SocialLoginCard({ enabled }: { enabled: boolean }) {
  const features = useSaveSection('features');
  const { data } = useQuery({ queryKey: ['admin', 'oauth'], queryFn: () => api.get<{ providers: Record<OAuthProvider, ProviderState> }>('/admin/oauth') });
  return (
    <Card title="Social login">
      <Switch
        checked={enabled}
        onChange={(v) => features.mutate({ oauth: v })}
        label="Allow social login"
        description="New accounts are only created this way when public registration is on; otherwise people link a provider from their account page."
      />
      {data && (
        <div className="mt-5 grid gap-5 xl:grid-cols-3">
          {(Object.keys(data.providers) as OAuthProvider[]).map((p) => (
            <ProviderForm key={p} provider={p} state={data.providers[p]} />
          ))}
        </div>
      )}
    </Card>
  );
}

function ProviderForm({ provider, state }: { provider: OAuthProvider; state: ProviderState }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({ enabled: state.enabled, clientId: state.clientId, clientSecret: '' });
  const save = useMutation({
    mutationFn: () => api.put(`/admin/oauth/${provider}`, { enabled: form.enabled, clientId: form.clientId, ...(form.clientSecret ? { clientSecret: form.clientSecret } : {}) }),
    onSuccess: () => {
      setForm((f) => ({ ...f, clientSecret: '' }));
      void qc.invalidateQueries({ queryKey: ['admin', 'oauth'] });
      void qc.invalidateQueries({ queryKey: ['branding'] });
    },
  });
  const help = PROVIDER_HELP[provider];
  return (
    <div className="flex flex-col gap-3 rounded-ui border border-border p-4">
      <div className="flex items-center justify-between">
        <span className="font-semibold">{state.label}</span>
        {state.enabled ? <Badge tone="success">On</Badge> : <Badge>Off</Badge>}
      </div>
      <p className="text-xs text-muted">
        Create an app in{' '}
        <a href={help.url} target="_blank" rel="noreferrer" className="text-primary hover:underline">
          {help.where}
        </a>{' '}
        and add this redirect URL:
      </p>
      <CopyField value={state.callbackUrl} />
      <Field label="Client ID">{(id) => <Input id={id} value={form.clientId} onChange={(e) => setForm({ ...form, clientId: e.target.value })} />}</Field>
      <Field label="Client secret" hint={state.secretSet ? 'Leave empty to keep the saved secret.' : undefined}>
        {(id) => <Input id={id} type="password" autoComplete="new-password" placeholder={state.secretSet ? '••••••••' : ''} value={form.clientSecret} onChange={(e) => setForm({ ...form, clientSecret: e.target.value })} />}
      </Field>
      <Switch checked={form.enabled} onChange={(v) => setForm({ ...form, enabled: v })} label={`Enable ${state.label}`} />
      {save.error && <p className="text-sm text-danger">{save.error.message}</p>}
      <Button size="sm" className="self-start" loading={save.isPending} onClick={() => save.mutate()}>
        Save
      </Button>
    </div>
  );
}
