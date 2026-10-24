import { useState } from 'react';
import { Check } from 'lucide-react';
import type { NavItem, Settings } from '@glacier/shared';
import { ApiError } from '../../lib/api';
import { Alert, Button, Card, Field, PageHeader, PageLoader, Select, Switch } from '../../components/ui';
import { useAdminSettings, useSaveSection } from './useSettings';
import { IconSelect, ListField, TextField } from './editor-fields';

export function NavigationPage() {
  const { data, isLoading } = useAdminSettings();
  if (isLoading || !data) return <PageLoader />;
  return <Editor initial={data.navigation} />;
}

function Editor({ initial }: { initial: Settings['navigation'] }) {
  const [items, setItems] = useState<NavItem[]>(initial.items);
  const save = useSaveSection('navigation');
  const dirty = JSON.stringify(items) !== JSON.stringify(initial.items);
  const error = save.error instanceof ApiError ? save.error : null;

  return (
    <>
      <PageHeader
        title="Navigation"
        description="Extra links in the header and footer: status page, Discord, docs, store…"
        actions={
          <>
            {save.isSuccess && !dirty && (
              <span className="flex items-center gap-1 text-sm text-success">
                <Check className="size-4" /> Saved
              </span>
            )}
            <Button loading={save.isPending} disabled={!dirty} onClick={() => save.mutate({ items })}>
              Save
            </Button>
          </>
        }
      />
      {error && (
        <div className="mb-4">
          <Alert>
            {error.message}
            {error.details?.slice(0, 5).map((d, i) => (
              <div key={i} className="text-xs">
                {d.path}: {d.message}
              </div>
            ))}
          </Alert>
        </div>
      )}
      <Card>
        <ListField
          label="Links"
          items={items}
          onChange={setItems}
          max={40}
          itemLabel={(it) => `${it.label || 'Link'} · ${it.location} · ${it.visibility}`}
          create={(): NavItem => ({ id: `nav-${Math.random().toString(36).slice(2, 8)}`, label: 'Discord', href: 'https://discord.gg/', location: 'header', visibility: 'everyone', newTab: true, icon: 'message' })}
          render={(it, up) => (
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              <TextField label="Label" value={it.label} onChange={(label) => up({ label })} />
              <TextField label="Link" value={it.href} onChange={(href) => up({ href })} hint="/p/terms, https://status.example.com" />
              <IconSelect value={it.icon} onChange={(icon) => up({ icon: icon as NavItem['icon'] })} allowNone />
              <Field label="Where">
                {(id) => (
                  <Select id={id} value={it.location} onChange={(e) => up({ location: e.target.value as NavItem['location'] })}>
                    <option value="header">Header</option>
                    <option value="footer">Footer</option>
                  </Select>
                )}
              </Field>
              <Field label="Who sees it">
                {(id) => (
                  <Select id={id} value={it.visibility} onChange={(e) => up({ visibility: e.target.value as NavItem['visibility'] })}>
                    <option value="everyone">Everyone</option>
                    <option value="guests">Visitors who aren't signed in</option>
                    <option value="users">Signed-in users</option>
                    <option value="admins">Admins only</option>
                  </Select>
                )}
              </Field>
              <div className="flex items-end pb-2">
                <Switch checked={it.newTab} onChange={(newTab) => up({ newTab })} label="Open in a new tab" />
              </div>
            </div>
          )}
        />
      </Card>
    </>
  );
}
