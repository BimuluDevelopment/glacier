import { useState } from 'react';
import { FEATURE_FLAGS, type FeatureFlag, type Settings } from '@glacier/shared';
import { Badge, Button, Card, Field, Input, PageHeader, PageLoader, Select, Switch, Textarea } from '../../components/ui';
import { useAdminSettings, useSaveSection } from './useSettings';
import { IntegrationsCard } from './integrations';

export function SettingsPage() {
  const { data, isLoading } = useAdminSettings();
  if (isLoading || !data) return <PageLoader />;
  return (
    <>
      <PageHeader title="Settings" description="Panel-wide behaviour and modules." />
      <div className="flex flex-col gap-6">
        <FeaturesCard initial={data.features} />
        <IntegrationsCard />
        <DashboardCard initial={data.dashboard} />
        <div className="grid gap-6 lg:grid-cols-2">
          <GeneralCard initial={data.general} />
          <AuthCard initial={data.auth} />
        </div>
      </div>
    </>
  );
}

function Saved({ show }: { show: boolean }) {
  return show ? <span className="text-sm text-success">Saved</span> : null;
}

function FeaturesCard({ initial }: { initial: Settings['features'] }) {
  const save = useSaveSection('features');
  const [features, setFeatures] = useState(initial);
  const toggle = (key: FeatureFlag, value: boolean) => {
    const next = { ...features, [key]: value };
    setFeatures(next);
    save.mutate(next);
  };
  return (
    <Card title="Modules" actions={<Saved show={save.isSuccess && !save.isPending} />}>
      <div className="grid gap-5 md:grid-cols-2">
        {(Object.keys(FEATURE_FLAGS) as FeatureFlag[]).map((key) => {
          const def = FEATURE_FLAGS[key];
          return (
            <Switch
              key={key}
              checked={def.ready ? features[key] : false}
              disabled={!def.ready}
              onChange={(v) => toggle(key, v)}
              label={def.label}
              description={
                <>
                  {def.description} {!def.ready && <Badge className="ml-1">Coming soon</Badge>}
                </>
              }
            />
          );
        })}
      </div>
      {save.error && <p className="mt-4 text-sm text-danger">{save.error.message}</p>}
    </Card>
  );
}

function GeneralCard({ initial }: { initial: Settings['general'] }) {
  const save = useSaveSection('general');
  const [g, setG] = useState(initial);
  return (
    <Card title="General">
      <div className="flex flex-col gap-4">
        <Switch
          checked={g.maintenanceMode}
          onChange={(v) => setG({ ...g, maintenanceMode: v })}
          label="Maintenance mode"
          description="Only administrators can sign in or use the panel. Game servers keep running."
        />
        <Field label="Timezone" hint="Schedules run in this timezone, e.g. Europe/Amsterdam or America/New_York.">
          {(id) => <Input id={id} value={g.timezone} onChange={(e) => setG({ ...g, timezone: e.target.value })} />}
        </Field>
        <Field label="Maintenance message">
          {(id) => <Textarea id={id} rows={3} value={g.maintenanceMessage} onChange={(e) => setG({ ...g, maintenanceMessage: e.target.value })} />}
        </Field>
        <div className="flex items-center gap-3">
          <Button onClick={() => save.mutate(g)} loading={save.isPending}>
            Save
          </Button>
          <Saved show={save.isSuccess} />
          {save.error && <span className="text-sm text-danger">{save.error.message}</span>}
        </div>
      </div>
    </Card>
  );
}

function AuthCard({ initial }: { initial: Settings['auth'] }) {
  const save = useSaveSection('auth');
  const [a, setA] = useState(initial);
  return (
    <Card title="Sign-in">
      <div className="flex flex-col gap-4">
        <Field label="Session length (days)" hint="Users stay signed in this long after their last visit.">
          {(id) => <Input id={id} type="number" min={1} max={365} value={a.sessionDays} onChange={(e) => setA({ ...a, sessionDays: Number(e.target.value) })} />}
        </Field>
        <Field label="Sign-in page message" hint="Shown above the sign-in form, e.g. a support link or notice.">
          {(id) => <Textarea id={id} rows={3} value={a.loginMessage} onChange={(e) => setA({ ...a, loginMessage: e.target.value })} />}
        </Field>
        <div className="flex items-center gap-3">
          <Button onClick={() => save.mutate(a)} loading={save.isPending}>
            Save
          </Button>
          <Saved show={save.isSuccess} />
          {save.error && <span className="text-sm text-danger">{save.error.message}</span>}
        </div>
      </div>
    </Card>
  );
}

function DashboardCard({ initial }: { initial: Settings['dashboard'] }) {
  const save = useSaveSection('dashboard');
  const [d, setD] = useState(initial);
  return (
    <Card title="Server list">
      <div className="grid gap-5 md:grid-cols-2">
        <Field label="Default layout">
          {(id) => (
            <Select id={id} value={d.layout} onChange={(e) => setD({ ...d, layout: e.target.value as Settings['dashboard']['layout'] })}>
              <option value="grid">Cards</option>
              <option value="list">Compact list</option>
            </Select>
          )}
        </Field>
        <div className="flex items-end pb-2">
          <Switch checked={d.allowUserLayout} onChange={(v) => setD({ ...d, allowUserLayout: v })} label="Users can switch layout" />
        </div>
        <Switch checked={d.showResources} onChange={(v) => setD({ ...d, showResources: v })} label="Show live CPU, memory and disk" />
        <Switch checked={d.showNode} onChange={(v) => setD({ ...d, showNode: v })} label="Show node name" />
        <Switch checked={d.showEgg} onChange={(v) => setD({ ...d, showEgg: v })} label="Show server type" />
        <div />
        <Field label="Banner (Markdown)" hint="Shown above everyone's server list, e.g. a maintenance notice or promo. Empty hides it." className="md:col-span-2">
          {(id) => <Textarea id={id} rows={3} value={d.banner} onChange={(e) => setD({ ...d, banner: e.target.value })} />}
        </Field>
        <Field label="Banner color">
          {(id) => (
            <Select id={id} value={d.bannerTone} onChange={(e) => setD({ ...d, bannerTone: e.target.value as Settings['dashboard']['bannerTone'] })}>
              <option value="primary">Brand</option>
              <option value="success">Green</option>
              <option value="warning">Amber</option>
              <option value="danger">Red</option>
            </Select>
          )}
        </Field>
      </div>
      <div className="mt-5 flex items-center gap-3">
        <Button onClick={() => save.mutate(d)} loading={save.isPending}>
          Save
        </Button>
        <Saved show={save.isSuccess} />
        {save.error && <span className="text-sm text-danger">{save.error.message}</span>}
      </div>
    </Card>
  );
}
