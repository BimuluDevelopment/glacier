import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { Check, Send } from 'lucide-react';
import { EMAIL_TEMPLATE_KEYS, type EmailTemplateKey, type Settings } from '@glacier/shared';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../auth/AuthProvider';
import { Alert, Badge, Button, Card, Field, Input, PageHeader, PageLoader, Select, Switch, Textarea } from '../../components/ui';
import { useAdminSettings, useSaveSection } from './useSettings';

interface MailState {
  enabled: boolean;
  host: string;
  port: number;
  security: 'tls' | 'starttls' | 'none';
  username: string;
  fromName: string;
  fromAddress: string;
  passwordSet: boolean;
  ready: boolean;
  templates: Record<EmailTemplateKey, { label: string; description: string; variables: readonly string[] }>;
}

export function EmailPage() {
  const { data: mail, isLoading } = useQuery({ queryKey: ['admin', 'mail'], queryFn: () => api.get<MailState>('/admin/mail') });
  const { data: settings } = useAdminSettings();
  if (isLoading || !mail || !settings) return <PageLoader />;
  return (
    <>
      <PageHeader title="Email" description="Outgoing mail for password resets, welcome messages and notifications." />
      <div className="flex flex-col gap-6">
        <SmtpCard initial={mail} />
        <TemplatesCard initial={settings.emailTemplates} meta={mail.templates} />
      </div>
    </>
  );
}

const PORT_FOR = { tls: 465, starttls: 587, none: 25 } as const;

function SmtpCard({ initial }: { initial: MailState }) {
  const qc = useQueryClient();
  const { user } = useAuth();
  const [form, setForm] = useState({ ...initial, password: '' });
  const [testTo, setTestTo] = useState(user?.email ?? '');
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));

  const save = useMutation({
    mutationFn: () =>
      api.put('/admin/mail', {
        enabled: form.enabled,
        host: form.host,
        port: Number(form.port),
        security: form.security,
        username: form.username,
        fromName: form.fromName,
        fromAddress: form.fromAddress,
        // Only send a password when one was typed, so the stored one is kept otherwise.
        ...(form.password ? { password: form.password } : {}),
      }),
    onSuccess: () => {
      set('password', '');
      void qc.invalidateQueries({ queryKey: ['admin', 'mail'] });
      void qc.invalidateQueries({ queryKey: ['branding'] });
    },
  });
  const test = useMutation({ mutationFn: () => api.post('/admin/mail/test', { to: testTo }) });
  const fieldError = (k: string) => (save.error instanceof ApiError ? save.error.field(k) : undefined);

  return (
    <Card title="SMTP server" actions={initial.ready ? <Badge tone="success">Sending enabled</Badge> : <Badge>Off</Badge>}>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <div className="md:col-span-2 xl:col-span-3">
          <Switch checked={form.enabled} onChange={(v) => set('enabled', v)} label="Send email" description='Also shows "Forgot password?" on the sign-in page.' />
        </div>
        <Field label="Host" error={fieldError('host')}>{(id) => <Input id={id} placeholder="smtp.mailgun.org" value={form.host} onChange={(e) => set('host', e.target.value)} />}</Field>
        <Field label="Security">
          {(id) => (
            <Select
              id={id}
              value={form.security}
              onChange={(e) => {
                const security = e.target.value as MailState['security'];
                setForm((f) => ({ ...f, security, port: PORT_FOR[security] }));
              }}
            >
              <option value="starttls">STARTTLS (port 587)</option>
              <option value="tls">TLS (port 465)</option>
              <option value="none">None (local relay only)</option>
            </Select>
          )}
        </Field>
        <Field label="Port">{(id) => <Input id={id} type="number" value={form.port} onChange={(e) => set('port', Number(e.target.value))} />}</Field>
        <Field label="Username">{(id) => <Input id={id} autoComplete="off" value={form.username} onChange={(e) => set('username', e.target.value)} />}</Field>
        <Field label="Password" hint={initial.passwordSet ? 'Leave empty to keep the saved password.' : undefined}>
          {(id) => <Input id={id} type="password" autoComplete="new-password" placeholder={initial.passwordSet ? '••••••••' : ''} value={form.password} onChange={(e) => set('password', e.target.value)} />}
        </Field>
        <div />
        <Field label="From name">{(id) => <Input id={id} placeholder="Acme Hosting" value={form.fromName} onChange={(e) => set('fromName', e.target.value)} />}</Field>
        <Field label="From address" error={fieldError('fromAddress')}>
          {(id) => <Input id={id} type="email" placeholder="no-reply@example.com" value={form.fromAddress} onChange={(e) => set('fromAddress', e.target.value)} />}
        </Field>
      </div>
      {save.error && !fieldError('host') && !fieldError('fromAddress') && (
        <div className="mt-4">
          <Alert>{save.error.message}</Alert>
        </div>
      )}
      <div className="mt-5 flex flex-wrap items-center gap-3">
        <Button loading={save.isPending} onClick={() => save.mutate()}>
          Save
        </Button>
        {save.isSuccess && <span className="flex items-center gap-1 text-sm text-success"><Check className="size-4" /> Saved</span>}
        <div className="ml-auto flex items-center gap-2">
          <Input className="w-60" type="email" value={testTo} onChange={(e) => setTestTo(e.target.value)} aria-label="Send test to" />
          <Button variant="secondary" icon={<Send className="size-4" />} loading={test.isPending} disabled={!initial.ready} onClick={() => test.mutate()}>
            Send test
          </Button>
        </div>
      </div>
      {test.isSuccess && <p className="mt-3 text-sm text-success">Test email sent to {testTo}. Check the inbox (and spam folder).</p>}
      {test.error && (
        <div className="mt-3">
          <Alert>{test.error.message}</Alert>
        </div>
      )}
    </Card>
  );
}

function TemplatesCard({ initial, meta }: { initial: Settings['emailTemplates']; meta: MailState['templates'] }) {
  const [templates, setTemplates] = useState(initial);
  const [active, setActive] = useState<EmailTemplateKey>('welcome');
  const [preview, setPreview] = useState<{ subject: string; html: string } | null>(null);
  const save = useSaveSection('emailTemplates');
  const current = templates[active];
  const dirty = JSON.stringify(templates) !== JSON.stringify(initial);

  // Debounced live preview of the template being edited.
  useEffect(() => {
    const timer = setTimeout(() => {
      api
        .post<{ subject: string; html: string }>('/admin/mail/preview', { template: active, subject: current.subject, body: current.body })
        .then(setPreview, () => setPreview(null));
    }, 400);
    return () => clearTimeout(timer);
  }, [active, current.subject, current.body]);

  const update = (patch: Partial<(typeof templates)[EmailTemplateKey]>) => setTemplates((t) => ({ ...t, [active]: { ...t[active], ...patch } }));

  return (
    <Card
      title="Templates"
      actions={
        <>
          {save.isSuccess && !dirty && <span className="flex items-center gap-1 text-sm text-success"><Check className="size-4" /> Saved</span>}
          <Button size="sm" loading={save.isPending} disabled={!dirty} onClick={() => save.mutate(templates)}>
            Save templates
          </Button>
        </>
      }
    >
      <div className="mb-5 flex flex-wrap gap-2">
        {EMAIL_TEMPLATE_KEYS.map((key) => (
          <button
            key={key}
            onClick={() => setActive(key)}
            className={clsx('rounded-full border px-3 py-1.5 text-sm', active === key ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted hover:text-text')}
          >
            {meta[key].label}
            {!templates[key].enabled && ' (off)'}
          </button>
        ))}
      </div>
      {save.error && (
        <div className="mb-4">
          <Alert>{save.error.message}</Alert>
        </div>
      )}
      <div className="grid gap-6 xl:grid-cols-2">
        <div className="flex flex-col gap-4">
          <p className="text-sm text-muted">{meta[active].description}</p>
          {active !== 'passwordReset' && <Switch checked={current.enabled} onChange={(enabled) => update({ enabled })} label="Send this email" />}
          <Field label="Subject">{(id) => <Input id={id} value={current.subject} onChange={(e) => update({ subject: e.target.value })} />}</Field>
          <Field label="Body (Markdown)">
            {(id) => <Textarea id={id} rows={12} className="font-mono text-xs" value={current.body} onChange={(e) => update({ body: e.target.value })} />}
          </Field>
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
            Variables:
            {meta[active].variables.map((v) => (
              <button key={v} type="button" className="rounded bg-surface-alt px-1.5 py-0.5 font-mono hover:text-text" onClick={() => update({ body: `${current.body}{{${v}}}` })}>
                {`{{${v}}}`}
              </button>
            ))}
          </div>
        </div>
        <div>
          <p className="mb-2 text-sm font-medium">Preview {preview && <span className="font-normal text-muted">· {preview.subject}</span>}</p>
          {/* Sandboxed: the preview is our own rendered HTML, but it never needs scripts or same-origin access. */}
          <iframe title="Email preview" sandbox="" srcDoc={preview?.html ?? ''} className="h-[28rem] w-full rounded-ui border border-border bg-white" />
        </div>
      </div>
    </Card>
  );
}
