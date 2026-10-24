import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Send, Trash2, Webhook as WebhookIcon } from 'lucide-react';
import { WEBHOOK_EVENT_PRESETS } from '@glacier/shared';
import { api } from '../../lib/api';
import { useForm } from '../../lib/forms';
import { timeAgo } from '../../lib/format';
import { Alert, Badge, Button, Card, CopyField, EmptyState, Field, Input, Modal, PageHeader, PageLoader, Select, Switch, Table, Td } from '../../components/ui';

interface WebhookRow {
  id: number;
  name: string;
  url: string;
  format: 'json' | 'discord';
  events: string[];
  enabled: boolean;
  lastStatus: number | null;
  lastError: string | null;
  lastTriggeredAt: string | null;
}

export function WebhooksPage() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['admin', 'webhooks'], queryFn: () => api.get<{ data: WebhookRow[] }>('/admin/webhooks').then((r) => r.data) });
  const [editing, setEditing] = useState<WebhookRow | 'new' | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['admin', 'webhooks'] });
  const test = useMutation({ mutationFn: (id: number) => api.post<{ status: number }>(`/admin/webhooks/${id}/test`), onSettled: refresh });
  const remove = useMutation({ mutationFn: (id: number) => api.delete(`/admin/webhooks/${id}`), onSuccess: refresh });

  return (
    <>
      <PageHeader
        title="Webhooks"
        description="Send panel activity to Discord or your own services."
        actions={
          <Button icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>
            New webhook
          </Button>
        }
      />
      {secret && (
        <div className="mb-4 flex flex-col gap-2 rounded-ui border border-border bg-surface p-4">
          <Alert tone="success">Signing secret (shown once). Verify the X-Glacier-Signature header with HMAC-SHA256 of "&lt;timestamp&gt;.&lt;body&gt;".</Alert>
          <CopyField value={secret} />
        </div>
      )}
      {test.isSuccess && (
        <div className="mb-4">
          <Alert tone="success">Test delivered (HTTP {test.data.status}).</Alert>
        </div>
      )}
      {test.error && (
        <div className="mb-4">
          <Alert>{test.error.message}</Alert>
        </div>
      )}
      <Card padded={false}>
        {isLoading ? (
          <PageLoader />
        ) : !data?.length ? (
          <EmptyState icon={<WebhookIcon className="size-8" />} title="No webhooks">
            Post server crashes, backups or failed sign-ins straight into a Discord channel.
          </EmptyState>
        ) : (
          <Table head={['Webhook', 'Events', 'Last delivery', '']}>
            {data.map((w) => (
              <tr key={w.id}>
                <Td>
                  <button className="text-left font-medium hover:text-primary" onClick={() => setEditing(w)}>
                    {w.name}
                  </button>{' '}
                  <Badge>{w.format === 'discord' ? 'Discord' : 'JSON'}</Badge> {!w.enabled && <Badge tone="warning">Paused</Badge>}
                  <div className="max-w-xs truncate font-mono text-xs text-muted">{w.url}</div>
                </Td>
                <Td className="font-mono text-xs text-muted">{w.events.join(', ')}</Td>
                <Td>
                  {!w.lastTriggeredAt ? (
                    <span className="text-muted">never</span>
                  ) : w.lastError ? (
                    <span className="text-danger" title={w.lastError}>
                      failed {timeAgo(w.lastTriggeredAt)}
                    </span>
                  ) : (
                    <span className="text-success">
                      {w.lastStatus} · {timeAgo(w.lastTriggeredAt)}
                    </span>
                  )}
                </Td>
                <Td className="text-right">
                  <div className="flex justify-end gap-1">
                    <button className="rounded p-1.5 text-muted hover:text-text" title="Send a test" onClick={() => test.mutate(w.id)}>
                      <Send className="size-4" />
                    </button>
                    <button className="rounded p-1.5 text-muted hover:text-danger" title="Delete" onClick={() => confirm(`Delete ${w.name}?`) && remove.mutate(w.id)}>
                      <Trash2 className="size-4" />
                    </button>
                  </div>
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      {editing && (
        <WebhookModal
          webhook={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(s) => {
            if (s) setSecret(s);
            void refresh();
          }}
        />
      )}
    </>
  );
}

function WebhookModal({ webhook, onClose, onSaved }: { webhook: WebhookRow | null; onClose: () => void; onSaved: (secret?: string) => void }) {
  const [events, setEvents] = useState<string[]>(webhook?.events ?? ['server:install.*', 'server:backup.*']);
  const [custom, setCustom] = useState('');
  const form = useForm({ name: webhook?.name ?? '', url: webhook?.url ?? '', format: webhook?.format ?? 'discord', enabled: webhook?.enabled ?? true });
  const onSubmit = form.submit(async (v) => {
    const body = { ...v, events };
    if (webhook) {
      await api.patch(`/admin/webhooks/${webhook.id}`, body);
      onSaved();
    } else {
      const res = await api.post<{ secret: string }>('/admin/webhooks', body);
      onSaved(v.format === 'json' ? res.secret : undefined);
    }
    onClose();
  });
  const toggle = (p: string, on: boolean) => setEvents((e) => (on ? [...e, p] : e.filter((x) => x !== p)));
  return (
    <Modal open onClose={onClose} title={webhook ? `Edit ${webhook.name}` : 'New webhook'} wide>
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        {form.error && !form.fieldError('url') && <Alert>{form.error.message}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name">{(id) => <Input id={id} required placeholder="#server-alerts" {...form.bind('name')} />}</Field>
          <Field label="Format">
            {(id) => (
              <Select id={id} value={form.values.format} onChange={(e) => form.set('format', e.target.value as 'json' | 'discord')}>
                <option value="discord">Discord message</option>
                <option value="json">Signed JSON</option>
              </Select>
            )}
          </Field>
        </div>
        <Field label="URL" error={form.fieldError('url')} hint={form.values.format === 'discord' ? 'Discord: Server Settings → Integrations → Webhooks → Copy Webhook URL' : 'Receives a POST for every matching event.'}>
          {(id) => <Input id={id} required className="font-mono text-xs" {...form.bind('url')} />}
        </Field>
        <div>
          <p className="mb-2 text-sm font-medium">Events</p>
          <div className="grid gap-1.5 sm:grid-cols-2">
            {WEBHOOK_EVENT_PRESETS.map((p) => (
              <label key={p.pattern} className="flex items-center gap-2 text-sm">
                <input type="checkbox" className="accent-[var(--sl-primary)]" checked={events.includes(p.pattern)} onChange={(e) => toggle(p.pattern, e.target.checked)} />
                {p.label} <code className="font-mono text-xs text-muted">{p.pattern}</code>
              </label>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {events
              .filter((e) => !WEBHOOK_EVENT_PRESETS.some((p) => p.pattern === e))
              .map((e) => (
                <Badge key={e}>
                  {e}
                  <button type="button" className="ml-1" onClick={() => toggle(e, false)} aria-label={`Remove ${e}`}>
                    ×
                  </button>
                </Badge>
              ))}
            <Input className="h-8 w-56 font-mono text-xs" placeholder="custom, e.g. admin:server.*" value={custom} onChange={(e) => setCustom(e.target.value)} />
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={!custom.trim()}
              onClick={() => {
                toggle(custom.trim(), true);
                setCustom('');
              }}
            >
              Add
            </Button>
          </div>
        </div>
        <Switch checked={form.values.enabled} onChange={(v) => form.set('enabled', v)} label="Enabled" />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={form.submitting} disabled={!events.length}>
            {webhook ? 'Save' : 'Create'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
