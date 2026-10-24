import { useMemo, useState } from 'react';
import { Check, RotateCcw, Search } from 'lucide-react';
import { DEFAULT_STRINGS, type Settings, type StringKey } from '@glacier/shared';
import { Badge, Button, Card, Input, PageHeader, PageLoader } from '../../components/ui';
import { useAdminSettings, useSaveSection } from './useSettings';

export function LocalizationPage() {
  const { data, isLoading } = useAdminSettings();
  if (isLoading || !data) return <PageLoader />;
  return <Editor initial={data.localization} />;
}

function Editor({ initial }: { initial: Settings['localization'] }) {
  const [overrides, setOverrides] = useState<Record<string, string>>(initial.overrides);
  const [search, setSearch] = useState('');
  const [onlyChanged, setOnlyChanged] = useState(false);
  const save = useSaveSection('localization');

  // Empty overrides mean "use the default", so drop them before saving.
  const cleaned = useMemo(() => Object.fromEntries(Object.entries(overrides).filter(([, v]) => v.trim() !== '')), [overrides]);
  const dirty = JSON.stringify(cleaned) !== JSON.stringify(initial.overrides);

  const keys = (Object.keys(DEFAULT_STRINGS) as StringKey[]).filter((key) => {
    if (onlyChanged && !cleaned[key]) return false;
    const q = search.toLowerCase();
    return !q || key.toLowerCase().includes(q) || DEFAULT_STRINGS[key].toLowerCase().includes(q) || (cleaned[key] ?? '').toLowerCase().includes(q);
  });

  return (
    <>
      <PageHeader
        title="Localization"
        description="Reword any of the panel's texts, or translate them. Leave a field empty to use the default."
        actions={
          <>
            {save.isSuccess && !dirty && <span className="flex items-center gap-1 text-sm text-success"><Check className="size-4" /> Saved</span>}
            <Button loading={save.isPending} disabled={!dirty} onClick={() => save.mutate({ overrides: cleaned })}>
              Save
            </Button>
          </>
        }
      />
      {save.error && <p className="mb-4 text-sm text-danger">{save.error.message}</p>}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
          <Input className="w-72 pl-9" placeholder="Search texts" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="accent-[var(--sl-primary)]" checked={onlyChanged} onChange={(e) => setOnlyChanged(e.target.checked)} />
          Only changed ({Object.keys(cleaned).length})
        </label>
      </div>
      <Card padded={false}>
        <div className="divide-y divide-border">
          {keys.map((key) => (
            <div key={key} className="grid gap-2 px-5 py-3 md:grid-cols-[14rem_1fr_1fr_auto] md:items-center">
              <code className="truncate font-mono text-xs text-muted" title={key}>
                {key}
              </code>
              <span className="text-sm">{DEFAULT_STRINGS[key]}</span>
              <Input className="h-9" placeholder="Default" value={overrides[key] ?? ''} onChange={(e) => setOverrides((o) => ({ ...o, [key]: e.target.value }))} aria-label={`Override for ${key}`} />
              <div className="flex w-16 justify-end">
                {cleaned[key] ? (
                  <button
                    className="rounded p-1.5 text-muted hover:text-text"
                    title="Reset to default"
                    onClick={() =>
                      setOverrides((o) => {
                        const next = { ...o };
                        delete next[key];
                        return next;
                      })
                    }
                  >
                    <RotateCcw className="size-4" />
                  </button>
                ) : (
                  /\{\w+\}/.test(DEFAULT_STRINGS[key]) && <Badge>vars</Badge>
                )}
              </div>
            </div>
          ))}
        </div>
      </Card>
      <p className="mt-3 text-xs text-muted">Keep placeholders like {'{name}'} in your text; they are filled in automatically.</p>
    </>
  );
}
