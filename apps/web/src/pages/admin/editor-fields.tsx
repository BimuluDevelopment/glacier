import type { ReactNode } from 'react';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { LANDING_ICONS } from '@glacier/shared';
import { Button, Field, Input, Select, Switch, Textarea } from '../../components/ui';
import { Icon } from '../../features/landing/icons';

/** Small controlled inputs shared by the landing page and navigation editors. */

export function TextField({ label, value, onChange, hint, multiline, placeholder }: { label: string; value: string; onChange: (v: string) => void; hint?: string; multiline?: boolean | number; placeholder?: string }) {
  return (
    <Field label={label} hint={hint}>
      {(id) =>
        multiline ? (
          <Textarea id={id} rows={typeof multiline === 'number' ? multiline : 3} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
        ) : (
          <Input id={id} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
        )
      }
    </Field>
  );
}

export function IconSelect({ label = 'Icon', value, onChange, allowNone }: { label?: string; value?: string; onChange: (v: string | undefined) => void; allowNone?: boolean }) {
  return (
    <Field label={label}>
      {(id) => (
        <div className="flex items-center gap-2">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-ui border border-border text-primary">
            <Icon name={value as never} className="size-4" />
          </span>
          <Select id={id} value={value ?? ''} onChange={(e) => onChange(e.target.value || undefined)}>
            {allowNone && <option value="">None</option>}
            {LANDING_ICONS.map((i) => (
              <option key={i} value={i}>
                {i}
              </option>
            ))}
          </Select>
        </div>
      )}
    </Field>
  );
}

type Link = { text: string; href: string } | undefined;

/** A button/link that can be switched off entirely. */
export function LinkField({ label, value, onChange }: { label: string; value: Link; onChange: (v: Link) => void }) {
  return (
    <div className="rounded-ui border border-border p-3">
      <Switch checked={Boolean(value)} onChange={(on) => onChange(on ? { text: 'Learn more', href: '/' } : undefined)} label={label} />
      {value && (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <TextField label="Text" value={value.text} onChange={(text) => onChange({ ...value, text })} />
          <TextField label="Link" value={value.href} onChange={(href) => onChange({ ...value, href })} hint="/register, #pricing or https://…" />
        </div>
      )}
    </div>
  );
}

export function ListField<T>({
  label,
  items,
  onChange,
  create,
  render,
  max,
  itemLabel,
}: {
  label: string;
  items: T[];
  onChange: (items: T[]) => void;
  create: () => T;
  render: (item: T, update: (patch: Partial<T>) => void) => ReactNode;
  max: number;
  itemLabel: (item: T, index: number) => string;
}) {
  const update = (i: number, patch: Partial<T>) => onChange(items.map((it, j) => (j === i ? { ...it, ...patch } : it)));
  const move = (i: number, dir: -1 | 1) => {
    const next = [...items];
    const [it] = next.splice(i, 1);
    next.splice(i + dir, 0, it!);
    onChange(next);
  };
  return (
    <div>
      <p className="mb-2 text-sm font-medium">{label}</p>
      <div className="flex flex-col gap-3">
        {items.map((item, i) => (
          <div key={i} className="rounded-ui border border-border bg-bg/40 p-3">
            <div className="mb-3 flex items-center gap-1">
              <span className="mr-auto truncate text-xs font-medium text-muted">{itemLabel(item, i)}</span>
              <button type="button" className="rounded p-1 text-muted hover:text-text disabled:opacity-30" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up">
                <ArrowUp className="size-3.5" />
              </button>
              <button type="button" className="rounded p-1 text-muted hover:text-text disabled:opacity-30" disabled={i === items.length - 1} onClick={() => move(i, 1)} aria-label="Move down">
                <ArrowDown className="size-3.5" />
              </button>
              <button type="button" className="rounded p-1 text-muted hover:text-danger" onClick={() => onChange(items.filter((_, j) => j !== i))} aria-label="Remove">
                <Trash2 className="size-3.5" />
              </button>
            </div>
            <div className="grid gap-3">{render(item, (patch) => update(i, patch))}</div>
          </div>
        ))}
      </div>
      {items.length < max && (
        <Button type="button" size="sm" variant="secondary" className="mt-3" icon={<Plus className="size-4" />} onClick={() => onChange([...items, create()])}>
          Add
        </Button>
      )}
    </div>
  );
}
