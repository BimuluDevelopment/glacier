import { useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Globe, Trash2 } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { useForm } from '../../lib/forms';
import { useServer } from '../../features/server/context';
import { useTheme } from '../../theme/ThemeProvider';
import { Alert, Button, Card, CopyField, Field, Input, Select, Spinner } from '../../components/ui';
import { ConfirmDialog } from './files';

/** Settings → Minecraft version. Hidden for server types that can't switch. */
export function VersionCard() {
  const { server, base, can } = useServer();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['server', server.id, 'version'],
    queryFn: () => api.get<{ supported: boolean; source?: string; current: string | null; versions: string[] }>(`${base}/version`),
    staleTime: 5 * 60_000,
  });
  const [target, setTarget] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState(false);
  if (!can('startup.read')) return null;
  if (isLoading) return <Card title="Minecraft version"><Spinner /></Card>;
  if (!data?.supported) return null;
  const allowed = can('startup.update') && can('settings.reinstall');

  return (
    <Card title="Minecraft version">
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted">
          Currently <strong className="text-text">{data.current}</strong>. Switching reinstalls the server software; worlds, plugins and configs are kept, but{' '}
          <Link to="../backups" className="text-primary hover:underline">
            take a backup
          </Link>{' '}
          first. Older worlds upgrade when opened in a newer version and can't go back.
        </p>
        {done && <Alert tone="success">Switching. Follow the install in the console.</Alert>}
        {allowed && (
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Switch to" className="min-w-48 flex-1">
              {(id) => (
                <Select id={id} value={target} onChange={(e) => setTarget(e.target.value)}>
                  <option value="">Choose a version…</option>
                  <option value="latest">Latest release</option>
                  {data.versions.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Button disabled={!target || target === data.current || server.status !== 'ACTIVE'} onClick={() => setConfirming(true)}>
              Switch
            </Button>
          </div>
        )}
      </div>
      {confirming && (
        <ConfirmDialog
          title={`Switch to ${target}`}
          body="The server stops and the new version is installed. Continue?"
          confirm="Switch version"
          onClose={() => setConfirming(false)}
          onConfirm={() =>
            api.post(`${base}/version`, { version: target }).then(() => {
              setDone(true);
              void qc.invalidateQueries({ queryKey: ['server', server.id] });
            })
          }
        />
      )}
    </Card>
  );
}

interface SubdomainsData {
  data: { id: number; hostname: string; srvRecordId: string | null; createdAt: string }[];
  zones: { id: string; name: string }[];
  limit: number;
}

/** Network → Subdomains (Cloudflare). */
export function SubdomainsCard() {
  const { server, base, can } = useServer();
  const { branding } = useTheme();
  const qc = useQueryClient();
  const key = ['server', server.id, 'subdomains'];
  const { data, error } = useQuery({ queryKey: key, queryFn: () => api.get<SubdomainsData>(`${base}/subdomains`), enabled: branding.features.subdomains, retry: false });
  const [removing, setRemoving] = useState<SubdomainsData['data'][number] | null>(null);
  const form = useForm({ name: '', zoneId: '' });
  const refresh = () => qc.invalidateQueries({ queryKey: key });
  const create = useMutation({
    mutationFn: () => api.post(`${base}/subdomains`, { name: form.values.name, zoneId: form.values.zoneId || data!.zones[0]!.id }),
    onSuccess: () => {
      form.set('name', '');
      void refresh();
    },
  });
  if (!branding.features.subdomains || !data || data.zones.length === 0) {
    return error ? <Alert>{errorMessage(error)}</Alert> : null;
  }
  const manage = can('subdomain.manage');

  return (
    <Card title={<span className="flex items-center gap-2"><Globe className="size-4" /> Subdomains</span>}>
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted">A friendly address for your server. For Minecraft, players can leave the port off.</p>
        {data.data.map((s) => (
          <div key={s.id} className="flex items-center gap-2">
            <div className="flex-1">
              <CopyField value={s.hostname} />
            </div>
            {manage && (
              <button className="rounded p-2 text-muted hover:text-danger" aria-label={`Remove ${s.hostname}`} onClick={() => setRemoving(s)}>
                <Trash2 className="size-4" />
              </button>
            )}
          </div>
        ))}
        {create.error && <Alert>{create.error.message}</Alert>}
        {manage && data.data.length < data.limit && (
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate();
            }}
          >
            <Field label="Name" className="min-w-40 flex-1">
              {(id) => <Input id={id} required placeholder="survival" {...form.bind('name')} />}
            </Field>
            <Field label="Domain" className="min-w-48 flex-1">
              {(id) => (
                <Select id={id} value={form.values.zoneId || data.zones[0]!.id} onChange={(e) => form.set('zoneId', e.target.value)}>
                  {data.zones.map((z) => (
                    <option key={z.id} value={z.id}>
                      .{z.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Button type="submit" loading={create.isPending}>
              Add
            </Button>
          </form>
        )}
        <p className="text-xs text-muted">New DNS names can take a few minutes to work everywhere.</p>
      </div>
      {removing && (
        <ConfirmDialog
          title="Remove subdomain"
          body={`Remove ${removing.hostname}? Players using it won't be able to connect with it any more.`}
          confirm="Remove"
          onClose={() => setRemoving(null)}
          onConfirm={() => api.delete(`${base}/subdomains/${removing.id}`).then(refresh)}
        />
      )}
    </Card>
  );
}
