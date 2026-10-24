import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { Check } from 'lucide-react';
import { THEME_PRESETS, type Settings, type ThemeColors } from '@glacier/shared';
import { themeVars } from '../../theme/ThemeProvider';
import { Alert, Badge, Button, Card, Field, Input, PageHeader, PageLoader, Select, Switch, Textarea } from '../../components/ui';
import { useAdminSettings, useSaveSection } from './useSettings';

export function AppearancePage() {
  const { data, isLoading } = useAdminSettings();
  if (isLoading || !data) return <PageLoader />;
  return (
    <>
      <PageHeader title="Appearance" description="Brand the panel and design its theme. Changes apply to everyone as soon as you save." />
      <div className="flex flex-col gap-6">
        <ThemeEditor initial={data.theme} />
        <BrandingCard initial={data.branding} />
        <CustomCodeCard initial={data.customCode} />
      </div>
    </>
  );
}

function SaveBar({ onSave, saving, saved, error }: { onSave: () => void; saving: boolean; saved: boolean; error: Error | null }) {
  return (
    <div className="mt-5 flex flex-wrap items-center gap-3">
      <Button onClick={onSave} loading={saving}>
        Save changes
      </Button>
      {saved && !saving && (
        <span className="flex items-center gap-1 text-sm text-success">
          <Check className="size-4" /> Saved
        </span>
      )}
      {error && <span className="text-sm text-danger">{error.message}</span>}
    </div>
  );
}

const COLOR_LABELS: Record<keyof ThemeColors, string> = {
  primary: 'Primary',
  primaryForeground: 'Text on primary',
  background: 'Background',
  surface: 'Surface',
  surfaceAlt: 'Surface (raised)',
  border: 'Border',
  text: 'Text',
  muted: 'Muted text',
  success: 'Success',
  warning: 'Warning',
  danger: 'Danger',
};

function ColorInput({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <label className="flex items-center gap-3 rounded-ui border border-border bg-bg px-2.5 py-2">
      <input type="color" value={value.length === 4 ? `#${[...value.slice(1)].map((c) => c + c).join('')}` : value} onChange={(e) => onChange(e.target.value)} className="size-7 shrink-0 cursor-pointer rounded border-0 bg-transparent p-0" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs text-muted">{label}</span>
        <input
          className="w-full bg-transparent font-mono text-xs outline-none"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            if (/^#(?:[0-9a-fA-F]{3}){1,2}$/.test(e.target.value)) onChange(e.target.value);
          }}
          aria-label={`${label} hex value`}
        />
      </span>
    </label>
  );
}

function ThemeEditor({ initial }: { initial: Settings['theme'] }) {
  const [theme, setTheme] = useState(initial);
  const [editing, setEditing] = useState<'dark' | 'light'>(initial.defaultMode === 'light' ? 'light' : 'dark');
  const save = useSaveSection('theme');
  const set = <K extends keyof Settings['theme']>(key: K, value: Settings['theme'][K]) => setTheme((t) => ({ ...t, [key]: value }));
  const setColor = (key: keyof ThemeColors, value: string) => setTheme((t) => ({ ...t, preset: 'custom', [editing]: { ...t[editing], [key]: value } }));
  const dirty = JSON.stringify(theme) !== JSON.stringify(initial);

  return (
    <Card title="Theme" actions={dirty && <Badge tone="warning">Unsaved changes</Badge>}>
      <div className="grid gap-8 xl:grid-cols-[1fr_24rem]">
        <div className="flex flex-col gap-6">
          <div>
            <p className="mb-2 text-sm font-medium">Presets</p>
            <div className="flex flex-wrap gap-2">
              {Object.entries(THEME_PRESETS).map(([name, preset]) => (
                <button
                  key={name}
                  onClick={() => setTheme((t) => ({ ...t, preset: name, dark: preset.dark, light: preset.light }))}
                  className={clsx(
                    'flex items-center gap-2 rounded-ui border px-3 py-2 text-sm capitalize transition',
                    theme.preset === name ? 'border-primary bg-primary/10' : 'border-border hover:border-muted/60',
                  )}
                >
                  <span className="flex -space-x-1">
                    {[preset.dark.primary, preset.dark.background, preset.light.primary].map((c, i) => (
                      <span key={i} className="size-4 rounded-full border border-black/20" style={{ background: c }} />
                    ))}
                  </span>
                  {name}
                </button>
              ))}
              {theme.preset === 'custom' && <Badge tone="primary" className="self-center">Custom</Badge>}
            </div>
          </div>

          <div>
            <div className="mb-3 flex items-center justify-between gap-3">
              <p className="text-sm font-medium">Colors</p>
              <div className="flex rounded-ui border border-border p-0.5 text-xs">
                {(['dark', 'light'] as const).map((m) => (
                  <button key={m} onClick={() => setEditing(m)} className={clsx('rounded px-3 py-1 capitalize', editing === m ? 'bg-surface-alt text-text' : 'text-muted')}>
                    {m} mode
                  </button>
                ))}
              </div>
            </div>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {(Object.keys(COLOR_LABELS) as (keyof ThemeColors)[]).map((key) => (
                <ColorInput key={key} label={COLOR_LABELS[key]} value={theme[editing][key]} onChange={(v) => setColor(key, v)} />
              ))}
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Default mode">
              {(id) => (
                <Select id={id} value={theme.defaultMode} onChange={(e) => set('defaultMode', e.target.value as Settings['theme']['defaultMode'])}>
                  <option value="dark">Dark</option>
                  <option value="light">Light</option>
                  <option value="system">Follow the visitor's system</option>
                </Select>
              )}
            </Field>
            <Field label="Density">
              {(id) => (
                <Select id={id} value={theme.density} onChange={(e) => set('density', e.target.value as Settings['theme']['density'])}>
                  <option value="comfortable">Comfortable</option>
                  <option value="compact">Compact</option>
                </Select>
              )}
            </Field>
            <Field label="Font" hint="Any Google Fonts family, e.g. Inter, Outfit, Space Grotesk.">
              {(id) => <Input id={id} value={theme.fontFamily} onChange={(e) => set('fontFamily', e.target.value)} />}
            </Field>
            <Field label="Monospace font" hint="Used by the console.">
              {(id) => <Input id={id} value={theme.monoFontFamily} onChange={(e) => set('monoFontFamily', e.target.value)} />}
            </Field>
            <Field label={`Corner radius: ${theme.radius}px`}>
              {(id) => <input id={id} type="range" min={0} max={24} value={theme.radius} onChange={(e) => set('radius', Number(e.target.value))} className="accent-[var(--sl-primary)]" />}
            </Field>
            <div className="flex items-end pb-2">
              <Switch checked={theme.allowUserToggle} onChange={(v) => set('allowUserToggle', v)} label="Let users switch light/dark" />
            </div>
          </div>
        </div>

        <ThemePreview colors={theme[editing]} theme={theme} />
      </div>
      <SaveBar onSave={() => save.mutate(theme)} saving={save.isPending} saved={save.isSuccess && !dirty} error={save.error} />
    </Card>
  );
}

/** Renders real UI pieces under the edited CSS variables, so the preview is exactly what users will see. */
function ThemePreview({ colors, theme }: { colors: ThemeColors; theme: Settings['theme'] }) {
  return (
    <div className="xl:sticky xl:top-24 xl:self-start">
      <p className="mb-2 text-sm font-medium">Live preview</p>
      <div style={{ ...themeVars(colors, theme), fontFamily: `'${theme.fontFamily}', ui-sans-serif, system-ui` }} className="rounded-ui border border-border bg-bg p-4 text-text">
        <div className="mb-4 flex items-center justify-between">
          <span className="font-semibold">My Server</span>
          <Badge tone="success">running</Badge>
        </div>
        <div className="rounded-ui border border-border bg-surface p-4">
          <p className="text-sm font-medium">Memory</p>
          <p className="text-xs text-muted">1.4 GiB of 4 GiB</p>
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-surface-alt">
            <div className="h-full w-[35%] rounded-full bg-primary" />
          </div>
          <Input className="mt-4" placeholder="Type a command…" readOnly />
          <div className="mt-4 flex flex-wrap gap-2">
            <Button size="sm">Start</Button>
            <Button size="sm" variant="secondary">
              Restart
            </Button>
            <Button size="sm" variant="danger">
              Kill
            </Button>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Badge tone="primary">primary</Badge>
          <Badge tone="warning">warning</Badge>
          <Badge tone="danger">danger</Badge>
          <Badge>neutral</Badge>
        </div>
      </div>
    </div>
  );
}

function BrandingCard({ initial }: { initial: Settings['branding'] }) {
  const [b, setB] = useState(initial);
  const save = useSaveSection('branding');
  const bind = (key: keyof Settings['branding']) => ({ value: b[key], onChange: (e: { target: { value: string } }) => setB((v) => ({ ...v, [key]: e.target.value })) });
  const fieldError = (path: string) => (save.error as { field?: (p: string) => string | undefined } | null)?.field?.(path);
  return (
    <Card title="Branding">
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Panel name" error={fieldError('name')}>{(id) => <Input id={id} {...bind('name')} />}</Field>
        <Field label="Tagline" hint="Shown on the sign-in page.">{(id) => <Input id={id} {...bind('tagline')} />}</Field>
        <Field label="Logo URL" hint="PNG or SVG; roughly 32px tall works best." error={fieldError('logoUrl')}>
          {(id) => <Input id={id} placeholder="https://…/logo.svg" {...bind('logoUrl')} />}
        </Field>
        <Field label="Favicon URL" error={fieldError('faviconUrl')}>{(id) => <Input id={id} placeholder="https://…/favicon.png" {...bind('faviconUrl')} />}</Field>
        <Field label="Sign-in background image URL" error={fieldError('loginBackgroundUrl')}>
          {(id) => <Input id={id} placeholder="https://…/background.jpg" {...bind('loginBackgroundUrl')} />}
        </Field>
        <Field label="Support URL" error={fieldError('supportUrl')}>{(id) => <Input id={id} placeholder="https://discord.gg/…" {...bind('supportUrl')} />}</Field>
        <Field label="Footer text" className="md:col-span-2">{(id) => <Input id={id} placeholder="© 2026 Acme Hosting" {...bind('footerText')} />}</Field>
        <Field label="Sign-in layout">
          {(id) => (
            <Select id={id} value={b.loginLayout} onChange={(e) => setB((v) => ({ ...v, loginLayout: e.target.value as Settings['branding']['loginLayout'] }))}>
              <option value="centered">Centered card</option>
              <option value="split">Split: brand panel + form</option>
            </Select>
          )}
        </Field>
        <Field label="Sign-in headline" hint="Large text on the brand panel (split layout).">{(id) => <Input id={id} placeholder="Your worlds, always online." {...bind('loginHeadline')} />}</Field>
      </div>
      <SaveBar onSave={() => save.mutate(b)} saving={save.isPending} saved={save.isSuccess} error={save.error} />
    </Card>
  );
}

function CustomCodeCard({ initial }: { initial: Settings['customCode'] }) {
  const [code, setCode] = useState(initial);
  const save = useSaveSection('customCode');
  return (
    <Card title="Custom code">
      <div className="flex flex-col gap-4">
        <Field label="Custom CSS" hint="Loaded on every page after the theme. Target any element, e.g. .xterm or header.">
          {(id) => <Textarea id={id} rows={8} className="font-mono text-xs" spellCheck={false} value={code.css} onChange={(e) => setCode((c) => ({ ...c, css: e.target.value }))} />}
        </Field>
        <Field label="Extra <head> HTML" hint="Analytics, chat widgets, meta tags. Scripts run for every visitor.">
          {(id) => (
            <Textarea id={id} rows={5} className="font-mono text-xs" spellCheck={false} value={code.headHtml} onChange={(e) => setCode((c) => ({ ...c, headHtml: e.target.value }))} />
          )}
        </Field>
        <Alert tone="warning">Code here runs with full access to every signed-in user's session. Only paste code you trust.</Alert>
      </div>
      <SaveBar onSave={() => save.mutate(code)} saving={save.isPending} saved={save.isSuccess} error={save.error} />
    </Card>
  );
}
