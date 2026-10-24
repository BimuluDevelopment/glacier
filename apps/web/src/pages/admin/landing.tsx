import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import clsx from 'clsx';
import { ArrowDown, ArrowUp, Check, Copy, ExternalLink, Plus, Trash2 } from 'lucide-react';
import type { LandingBlock, LandingBlockType, Settings } from '@glacier/shared';
import { ApiError } from '../../lib/api';
import { LandingPage } from '../../features/landing/Landing';
import { Alert, Badge, Button, Card, Field, PageHeader, PageLoader, Select, Switch } from '../../components/ui';
import { useAdminSettings, useSaveSection } from './useSettings';
import { IconSelect, LinkField, ListField, TextField } from './editor-fields';

const BLOCK_LABELS: Record<LandingBlockType, string> = {
  hero: 'Hero',
  features: 'Features',
  pricing: 'Tiers / cards',
  stats: 'Stats',
  faq: 'FAQ',
  cta: 'Call to action',
  text: 'Text',
  image: 'Image',
};

const newId = (type: string) => `${type}-${Math.random().toString(36).slice(2, 8)}`;

function createBlock(type: LandingBlockType): LandingBlock {
  const id = newId(type);
  switch (type) {
    case 'hero':
      return { id, type, eyebrow: '', title: 'Your headline here', subtitle: 'A sentence about your servers or community.', primary: { text: 'Sign in', href: '/login' }, imageUrl: '', align: 'center' };
    case 'features':
      return { id, type, title: 'What we run', subtitle: '', columns: 3, items: [{ icon: 'gamepad', title: 'Survival', text: 'Describe a server or feature.' }] };
    case 'pricing':
      return {
        id,
        type,
        title: 'Simple pricing',
        subtitle: '',
        plans: [{ name: 'Starter', price: '$5', period: '/ month', description: '', features: ['2 GB RAM', 'Daily backups'], cta: { text: 'Choose plan', href: '/register' }, highlighted: false }],
      };
    case 'stats':
      return { id, type, items: [{ value: '5', label: 'Servers' }, { value: '120+', label: 'Players' }] };
    case 'faq':
      return { id, type, title: 'Frequently asked questions', items: [{ question: 'How do I get an account?', answer: 'Ask an admin on our Discord.' }] };
    case 'cta':
      return { id, type, title: 'Ready to play?', text: '', button: { text: 'Sign in', href: '/login' } };
    case 'text':
      return { id, type, title: '', body: 'Write **Markdown** here.' };
    case 'image':
      return { id, type, url: '', alt: '', caption: '' };
  }
}

function blockSummary(block: LandingBlock) {
  if ('title' in block && block.title) return block.title;
  if (block.type === 'stats') return block.items.map((i) => i.value).join(' · ');
  if (block.type === 'image') return block.caption || block.url || 'No image yet';
  return '';
}

export function LandingBuilderPage() {
  const { data, isLoading } = useAdminSettings();
  if (isLoading || !data) return <PageLoader />;
  return <Builder initial={data.landing} enabled={data.features.landingPage} />;
}

function Builder({ initial, enabled }: { initial: Settings['landing']; enabled: boolean }) {
  const [blocks, setBlocks] = useState<LandingBlock[]>(initial.blocks);
  const [showAuthButtons, setShowAuthButtons] = useState(initial.showAuthButtons);
  const [selected, setSelected] = useState<string | null>(initial.blocks[0]?.id ?? null);
  const [adding, setAdding] = useState<LandingBlockType>('features');
  const save = useSaveSection('landing');
  const features = useSaveSection('features');
  const dirty = JSON.stringify({ blocks, showAuthButtons }) !== JSON.stringify(initial);

  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  const current = blocks.find((b) => b.id === selected) ?? null;
  const update = (patch: Partial<LandingBlock>) => setBlocks((bs) => bs.map((b) => (b.id === selected ? ({ ...b, ...patch } as LandingBlock) : b)));
  const move = (i: number, dir: -1 | 1) =>
    setBlocks((bs) => {
      const next = [...bs];
      const [b] = next.splice(i, 1);
      next.splice(i + dir, 0, b!);
      return next;
    });

  const error = save.error instanceof ApiError ? save.error : null;

  return (
    <>
      <PageHeader
        title="Landing page"
        description="The public page visitors see at / before signing in."
        actions={
          <>
            <a href="/welcome" target="_blank" rel="noreferrer">
              <Button variant="secondary" icon={<ExternalLink className="size-4" />}>
                Open live page
              </Button>
            </a>
            <Button loading={save.isPending} disabled={!dirty} onClick={() => save.mutate({ blocks, showAuthButtons })}>
              Publish changes
            </Button>
          </>
        }
      />
      <div className="mb-6 flex flex-wrap items-center gap-x-8 gap-y-3 rounded-ui border border-border bg-surface px-5 py-4">
        <Switch
          checked={enabled}
          onChange={(v) => features.mutate({ landingPage: v })}
          label="Show to visitors"
          description="Off: visitors go straight to the sign-in page."
        />
        <Switch checked={showAuthButtons} onChange={setShowAuthButtons} label='"Sign in" button in the header' />
        {dirty && <Badge tone="warning">Unpublished changes</Badge>}
        {save.isSuccess && !dirty && (
          <span className="flex items-center gap-1 text-sm text-success">
            <Check className="size-4" /> Published
          </span>
        )}
      </div>
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

      <div className="grid gap-6 2xl:grid-cols-[22rem_1fr]">
        <div className="flex flex-col gap-4">
          <Card title="Blocks" padded={false}>
            <ul className="divide-y divide-border">
              {blocks.map((b, i) => (
                <li key={b.id} className={clsx('flex items-center gap-2 px-3 py-2.5', selected === b.id && 'bg-primary/10')}>
                  <button className="min-w-0 flex-1 text-left" onClick={() => setSelected(b.id)}>
                    <div className="text-sm font-medium">{BLOCK_LABELS[b.type]}</div>
                    <div className="truncate text-xs text-muted">{blockSummary(b) || '—'}</div>
                  </button>
                  <button className="rounded p-1 text-muted hover:text-text disabled:opacity-30" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up">
                    <ArrowUp className="size-4" />
                  </button>
                  <button className="rounded p-1 text-muted hover:text-text disabled:opacity-30" disabled={i === blocks.length - 1} onClick={() => move(i, 1)} aria-label="Move down">
                    <ArrowDown className="size-4" />
                  </button>
                  <button
                    className="rounded p-1 text-muted hover:text-text"
                    onClick={() => {
                      const copy = { ...structuredClone(b), id: newId(b.type) };
                      setBlocks((bs) => [...bs.slice(0, i + 1), copy, ...bs.slice(i + 1)]);
                      setSelected(copy.id);
                    }}
                    aria-label="Duplicate"
                  >
                    <Copy className="size-4" />
                  </button>
                  <button className="rounded p-1 text-muted hover:text-danger" onClick={() => setBlocks((bs) => bs.filter((x) => x.id !== b.id))} aria-label="Delete">
                    <Trash2 className="size-4" />
                  </button>
                </li>
              ))}
            </ul>
            <div className="flex gap-2 border-t border-border p-3">
              <Select value={adding} onChange={(e) => setAdding(e.target.value as LandingBlockType)} aria-label="Block type">
                {Object.entries(BLOCK_LABELS).map(([type, label]) => (
                  <option key={type} value={type}>
                    {label}
                  </option>
                ))}
              </Select>
              <Button
                variant="secondary"
                icon={<Plus className="size-4" />}
                disabled={blocks.length >= 40}
                onClick={() => {
                  const block = createBlock(adding);
                  setBlocks((bs) => [...bs, block]);
                  setSelected(block.id);
                }}
              >
                Add
              </Button>
            </div>
          </Card>
          {current && (
            <Card title={`Edit: ${BLOCK_LABELS[current.type]}`}>
              <BlockEditor block={current} onChange={update} />
            </Card>
          )}
        </div>

        <div className="min-w-0">
          <p className="mb-2 text-sm font-medium">Preview</p>
          <div className="h-[75vh] overflow-auto rounded-ui border border-border bg-bg">
            <LandingPage blocks={blocks} />
          </div>
          <p className="mt-2 text-xs text-muted">
            Header and footer links come from <Link to="/admin/navigation" className="text-primary hover:underline">Navigation</Link> and <Link to="/admin/pages" className="text-primary hover:underline">Pages</Link>.
          </p>
        </div>
      </div>
    </>
  );
}

function BlockEditor({ block, onChange }: { block: LandingBlock; onChange: (patch: Partial<LandingBlock>) => void }) {
  const set = <K extends string>(key: K) => (value: unknown) => onChange({ [key]: value } as Partial<LandingBlock>);
  switch (block.type) {
    case 'hero':
      return (
        <div className="grid gap-4">
          <TextField label="Small label above the title" value={block.eyebrow} onChange={set('eyebrow')} />
          <TextField label="Title" value={block.title} onChange={set('title')} multiline={2} />
          <TextField label="Subtitle" value={block.subtitle} onChange={set('subtitle')} multiline />
          <LinkField label="Main button" value={block.primary} onChange={set('primary')} />
          <LinkField label="Second button" value={block.secondary} onChange={set('secondary')} />
          <TextField label="Image URL" value={block.imageUrl} onChange={set('imageUrl')} placeholder="https://…/screenshot.png" />
          <Field label="Alignment">
            {(id) => (
              <Select id={id} value={block.align} onChange={(e) => set('align')(e.target.value)}>
                <option value="center">Centered</option>
                <option value="left">Left (image on the right)</option>
              </Select>
            )}
          </Field>
        </div>
      );
    case 'features':
      return (
        <div className="grid gap-4">
          <TextField label="Title" value={block.title} onChange={set('title')} />
          <TextField label="Subtitle" value={block.subtitle} onChange={set('subtitle')} />
          <Field label="Columns">
            {(id) => (
              <Select id={id} value={block.columns} onChange={(e) => set('columns')(Number(e.target.value))}>
                <option value={2}>2</option>
                <option value={3}>3</option>
                <option value={4}>4</option>
              </Select>
            )}
          </Field>
          <ListField
            label="Features"
            items={block.items}
            onChange={set('items')}
            max={12}
            itemLabel={(it) => it.title || 'Feature'}
            create={() => ({ icon: 'sparkles' as const, title: 'New feature', text: '' })}
            render={(it, up) => (
              <>
                <IconSelect value={it.icon} onChange={(icon) => up({ icon: (icon ?? 'zap') as typeof it.icon })} />
                <TextField label="Title" value={it.title} onChange={(title) => up({ title })} />
                <TextField label="Text" value={it.text} onChange={(text) => up({ text })} multiline={2} />
              </>
            )}
          />
        </div>
      );
    case 'pricing':
      return (
        <div className="grid gap-4">
          <TextField label="Title" value={block.title} onChange={set('title')} />
          <TextField label="Subtitle" value={block.subtitle} onChange={set('subtitle')} />
          <ListField
            label="Plans"
            items={block.plans}
            onChange={set('plans')}
            max={6}
            itemLabel={(p) => p.name || 'Plan'}
            create={() => ({ name: 'New plan', price: '$10', period: '/ month', description: '', features: [], cta: { text: 'Choose plan', href: '/register' }, highlighted: false })}
            render={(p, up) => (
              <>
                <div className="grid grid-cols-3 gap-2">
                  <TextField label="Name" value={p.name} onChange={(name) => up({ name })} />
                  <TextField label="Price" value={p.price} onChange={(price) => up({ price })} />
                  <TextField label="Period" value={p.period} onChange={(period) => up({ period })} />
                </div>
                <TextField label="Description" value={p.description} onChange={(description) => up({ description })} />
                <TextField
                  label="Features (one per line)"
                  value={p.features.join('\n')}
                  onChange={(v) => up({ features: v.split('\n').slice(0, 15) })}
                  multiline={4}
                />
                <LinkField label="Button" value={p.cta} onChange={(cta) => up({ cta })} />
                <Switch checked={p.highlighted} onChange={(highlighted) => up({ highlighted })} label="Highlight as popular" />
              </>
            )}
          />
        </div>
      );
    case 'stats':
      return (
        <ListField
          label="Numbers"
          items={block.items}
          onChange={set('items')}
          max={6}
          itemLabel={(s) => s.value || 'Stat'}
          create={() => ({ value: '100+', label: 'Happy players' })}
          render={(s, up) => (
            <div className="grid grid-cols-2 gap-2">
              <TextField label="Value" value={s.value} onChange={(value) => up({ value })} />
              <TextField label="Label" value={s.label} onChange={(label) => up({ label })} />
            </div>
          )}
        />
      );
    case 'faq':
      return (
        <div className="grid gap-4">
          <TextField label="Title" value={block.title} onChange={set('title')} />
          <ListField
            label="Questions"
            items={block.items}
            onChange={set('items')}
            max={30}
            itemLabel={(q) => q.question || 'Question'}
            create={() => ({ question: 'New question?', answer: '' })}
            render={(q, up) => (
              <>
                <TextField label="Question" value={q.question} onChange={(question) => up({ question })} />
                <TextField label="Answer (Markdown)" value={q.answer} onChange={(answer) => up({ answer })} multiline={3} />
              </>
            )}
          />
        </div>
      );
    case 'cta':
      return (
        <div className="grid gap-4">
          <TextField label="Title" value={block.title} onChange={set('title')} />
          <TextField label="Text" value={block.text} onChange={set('text')} multiline />
          <LinkField label="Button" value={block.button} onChange={set('button')} />
        </div>
      );
    case 'text':
      return (
        <div className="grid gap-4">
          <TextField label="Title" value={block.title} onChange={set('title')} />
          <TextField label="Content (Markdown)" value={block.body} onChange={set('body')} multiline={10} hint="**bold**, *italic*, [links](https://…), lists, headings and more." />
        </div>
      );
    case 'image':
      return (
        <div className="grid gap-4">
          <TextField label="Image URL" value={block.url} onChange={set('url')} placeholder="https://…" />
          <TextField label="Alt text" value={block.alt} onChange={set('alt')} hint="Describe the image for screen readers." />
          <TextField label="Caption" value={block.caption} onChange={set('caption')} />
        </div>
      );
  }
}
