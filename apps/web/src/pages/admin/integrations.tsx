import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { Alert, Badge, Button, Card, Field, Input, Spinner } from '../../components/ui';

interface IntegrationState {
  curseforgeSet: boolean;
  cloudflareSet: boolean;
  cloudflareZones: { id: string; name: string }[];
  subdomainsPerServer: number;
}

/** Settings → Integrations: CurseForge (plugin browser) and Cloudflare (subdomains). */
export function IntegrationsCard() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['admin', 'integrations'], queryFn: () => api.get<IntegrationState>('/admin/integrations') });
  const [curseforge, setCurseforge] = useState('');
  const [token, setToken] = useState('');
  const [perServer, setPerServer] = useState<number | null>(null);
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.put('/admin/integrations', body),
    onSuccess: () => {
      setCurseforge('');
      setToken('');
      void qc.invalidateQueries({ queryKey: ['admin', 'integrations'] });
    },
  });
  const zones = useQuery({
    queryKey: ['admin', 'cloudflare-zones'],
    queryFn: () => api.get<{ data: { id: string; name: string; status: string }[] }>('/admin/integrations/cloudflare/zones').then((r) => r.data),
    enabled: Boolean(data?.cloudflareSet),
    retry: false,
  });
  if (!data) return <Card title="Integrations"><Spinner /></Card>;
  const chosen = new Set(data.cloudflareZones.map((z) => z.id));
  const tokenError = save.error instanceof ApiError ? save.error.field('cloudflareToken') : undefined;

  return (
    <Card title="Integrations">
      <div className="grid gap-8 lg:grid-cols-2">
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2 font-medium">CurseForge {data.curseforgeSet ? <Badge tone="success">Connected</Badge> : <Badge>Off</Badge>}</div>
          <p className="text-sm text-muted">
            Adds CurseForge to the plugin & mod browser. Get a free API key at{' '}
            <a href="https://console.curseforge.com/" target="_blank" rel="noreferrer" className="text-primary hover:underline">
              console.curseforge.com
            </a>
            . Modrinth and Hangar work without a key.
          </p>
          <Field label="API key">{(id) => <Input id={id} type="password" autoComplete="off" placeholder={data.curseforgeSet ? '•••••••• (saved)' : ''} value={curseforge} onChange={(e) => setCurseforge(e.target.value)} />}</Field>
          <div className="flex gap-2">
            <Button size="sm" disabled={!curseforge} loading={save.isPending} onClick={() => save.mutate({ curseforgeKey: curseforge })}>
              Save key
            </Button>
            {data.curseforgeSet && (
              <Button size="sm" variant="ghost" onClick={() => save.mutate({ curseforgeKey: '' })}>
                Remove
              </Button>
            )}
          </div>
        </div>

        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2 font-medium">Cloudflare {data.cloudflareSet ? <Badge tone="success">Connected</Badge> : <Badge>Off</Badge>}</div>
          <p className="text-sm text-muted">
            Lets users give servers subdomains like <code className="font-mono">survival.play.example.com</code>. Create an API token with <em>Zone → DNS → Edit</em> for your domain, then turn on Subdomains under Modules.
          </p>
          <Field label="API token" error={tokenError}>
            {(id) => <Input id={id} type="password" autoComplete="off" placeholder={data.cloudflareSet ? '•••••••• (saved)' : ''} value={token} onChange={(e) => setToken(e.target.value)} />}
          </Field>
          <div className="flex gap-2">
            <Button size="sm" disabled={!token} loading={save.isPending} onClick={() => save.mutate({ cloudflareToken: token })}>
              Check & save
            </Button>
            {data.cloudflareSet && (
              <Button size="sm" variant="ghost" onClick={() => save.mutate({ cloudflareToken: '' })}>
                Disconnect
              </Button>
            )}
          </div>
          {data.cloudflareSet && (
            <div className="mt-2 flex flex-col gap-2">
              <p className="text-sm font-medium">Domains users may use</p>
              {zones.isLoading ? (
                <Spinner />
              ) : zones.error ? (
                <Alert>{zones.error.message}</Alert>
              ) : (
                zones.data?.map((z) => (
                  <label key={z.id} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="accent-[var(--sl-primary)]"
                      checked={chosen.has(z.id)}
                      onChange={(e) =>
                        save.mutate({
                          cloudflareZones: e.target.checked ? [...data.cloudflareZones, { id: z.id, name: z.name }] : data.cloudflareZones.filter((x) => x.id !== z.id),
                        })
                      }
                    />
                    {z.name} {z.status !== 'active' && <Badge tone="warning">{z.status}</Badge>}
                  </label>
                ))
              )}
              <Field label="Subdomains per server">
                {(id) => (
                  <div className="flex gap-2">
                    <Input id={id} type="number" min={0} max={10} className="w-24" value={perServer ?? data.subdomainsPerServer} onChange={(e) => setPerServer(Number(e.target.value))} />
                    <Button size="sm" variant="secondary" className="h-10" disabled={perServer === null} onClick={() => save.mutate({ subdomainsPerServer: perServer })}>
                      Save
                    </Button>
                  </div>
                )}
              </Field>
            </div>
          )}
        </div>
      </div>
      {save.error && !tokenError && (
        <div className="mt-4">
          <Alert>{save.error.message}</Alert>
        </div>
      )}
      {save.isSuccess && (
        <p className="mt-4 flex items-center gap-1 text-sm text-success">
          <Check className="size-4" /> Saved
        </p>
      )}
    </Card>
  );
}
