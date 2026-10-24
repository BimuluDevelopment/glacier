import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, FileText, Plus } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { timeAgo } from '../../lib/format';
import { Markdown } from '../../theme/i18n';
import { Alert, Badge, Button, Card, EmptyState, Field, Input, PageHeader, PageLoader, Switch, Table, Td, Textarea } from '../../components/ui';

interface PageRow {
  id: number;
  slug: string;
  title: string;
  published: boolean;
  showInFooter: boolean;
  sort: number;
  updatedAt: string;
}

interface PageFull extends PageRow {
  content: string;
}

const TEMPLATES: { slug: string; title: string; content: string }[] = [
  {
    slug: 'terms',
    title: 'Terms of Service',
    content: '# Terms of Service\n\n*Last updated: today*\n\n## 1. Using our service\n\nDescribe what customers may and may not do.\n\n## 2. Payments and refunds\n\n…',
  },
  {
    slug: 'privacy',
    title: 'Privacy Policy',
    content: '# Privacy Policy\n\n## What we collect\n\n- Your email address and username\n- IP addresses in our activity logs\n\n## Contact\n\nEmail us at [support@example.com](mailto:support@example.com).',
  },
  { slug: 'rules', title: 'Server Rules', content: '# Rules\n\n1. Be respectful.\n2. No cheating or exploits.\n3. Have fun!' },
];

export function PagesListPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { data, isLoading } = useQuery({ queryKey: ['admin', 'pages'], queryFn: () => api.get<{ data: PageRow[] }>('/admin/pages').then((r) => r.data) });
  const create = useMutation({
    mutationFn: (t: (typeof TEMPLATES)[number] | null) =>
      api.post<PageFull>('/admin/pages', t ?? { slug: `page-${Math.random().toString(36).slice(2, 6)}`, title: 'New page', content: '# New page\n' }),
    onSuccess: (page) => {
      void qc.invalidateQueries({ queryKey: ['admin', 'pages'] });
      navigate(`/admin/pages/${page.id}`);
    },
  });
  const existing = new Set(data?.map((p) => p.slug));

  return (
    <>
      <PageHeader
        title="Pages"
        description="Terms, privacy policy, rules or anything else, at /p/<address>."
        actions={
          <Button icon={<Plus className="size-4" />} loading={create.isPending} onClick={() => create.mutate(null)}>
            New page
          </Button>
        }
      />
      {create.error && (
        <div className="mb-4">
          <Alert>{create.error.message}</Alert>
        </div>
      )}
      <Card padded={false}>
        {isLoading ? (
          <PageLoader />
        ) : !data?.length ? (
          <EmptyState icon={<FileText className="size-8" />} title="No pages yet">
            Start from a template:
            <div className="mt-3 flex flex-wrap justify-center gap-2">
              {TEMPLATES.map((t) => (
                <Button key={t.slug} size="sm" variant="secondary" onClick={() => create.mutate(t)}>
                  {t.title}
                </Button>
              ))}
            </div>
          </EmptyState>
        ) : (
          <Table head={['Page', 'Address', 'Status', 'Updated']}>
            {data.map((p) => (
              <tr key={p.id} className="hover:bg-surface-alt/50">
                <Td>
                  <Link to={`/admin/pages/${p.id}`} className="font-medium hover:text-primary">
                    {p.title}
                  </Link>
                </Td>
                <Td className="font-mono text-xs text-muted">/p/{p.slug}</Td>
                <Td>
                  {p.published ? <Badge tone="success">Published</Badge> : <Badge>Draft</Badge>} {p.showInFooter && <Badge>Footer</Badge>}
                </Td>
                <Td className="text-muted">{timeAgo(p.updatedAt)}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      {data && data.length > 0 && TEMPLATES.some((t) => !existing.has(t.slug)) && (
        <div className="mt-4 flex flex-wrap items-center gap-2 text-sm text-muted">
          Templates:
          {TEMPLATES.filter((t) => !existing.has(t.slug)).map((t) => (
            <Button key={t.slug} size="sm" variant="ghost" onClick={() => create.mutate(t)}>
              + {t.title}
            </Button>
          ))}
        </div>
      )}
    </>
  );
}

export function PageEditorPage() {
  const { id } = useParams();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { data, isLoading } = useQuery({ queryKey: ['admin', 'page', id], queryFn: () => api.get<PageFull>(`/admin/pages/${id}`) });
  const [draft, setDraft] = useState<PageFull | null>(null);
  useEffect(() => {
    if (data) setDraft(data);
  }, [data]);

  const save = useMutation({
    mutationFn: (p: PageFull) => api.patch<PageFull>(`/admin/pages/${id}`, { slug: p.slug, title: p.title, content: p.content, published: p.published, showInFooter: p.showInFooter, sort: p.sort }),
    onSuccess: (p) => {
      qc.setQueryData(['admin', 'page', id], p);
      void qc.invalidateQueries({ queryKey: ['admin', 'pages'] });
      void qc.invalidateQueries({ queryKey: ['branding'] });
    },
  });
  const remove = useMutation({
    mutationFn: () => api.delete(`/admin/pages/${id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin', 'pages'] });
      void qc.invalidateQueries({ queryKey: ['branding'] });
      navigate('/admin/pages');
    },
  });

  if (isLoading || !draft) return <PageLoader />;
  const set = <K extends keyof PageFull>(k: K, v: PageFull[K]) => setDraft((d) => d && { ...d, [k]: v });
  const dirty = JSON.stringify(draft) !== JSON.stringify(data);
  const fieldError = (k: string) => (save.error instanceof ApiError ? save.error.field(k) : undefined);

  return (
    <>
      <PageHeader
        title={draft.title || 'Untitled page'}
        description={<span className="font-mono">/p/{draft.slug}</span>}
        actions={
          <>
            <a href={`/p/${data!.slug}`} target="_blank" rel="noreferrer">
              <Button variant="secondary" icon={<ExternalLink className="size-4" />}>
                View
              </Button>
            </a>
            <Button variant="ghost" className="text-danger" loading={remove.isPending} onClick={() => confirm('Delete this page?') && remove.mutate()}>
              Delete
            </Button>
            <Button loading={save.isPending} disabled={!dirty} onClick={() => save.mutate(draft)}>
              Save
            </Button>
          </>
        }
      />
      {save.error && !fieldError('slug') && !fieldError('title') && (
        <div className="mb-4">
          <Alert>{save.error.message}</Alert>
        </div>
      )}
      <Card className="mb-6">
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <Field label="Title" error={fieldError('title')}>{(fid) => <Input id={fid} value={draft.title} onChange={(e) => set('title', e.target.value)} />}</Field>
          <Field label="Address" hint="Lowercase, numbers and dashes" error={fieldError('slug')}>
            {(fid) => <Input id={fid} className="font-mono" value={draft.slug} onChange={(e) => set('slug', e.target.value)} />}
          </Field>
          <div className="flex items-end pb-2">
            <Switch checked={draft.published} onChange={(v) => set('published', v)} label="Published" description="Drafts are only visible to admins." />
          </div>
          <div className="flex items-end pb-2">
            <Switch checked={draft.showInFooter} onChange={(v) => set('showInFooter', v)} label="Link in footer" />
          </div>
        </div>
      </Card>
      <div className="grid gap-6 xl:grid-cols-2">
        <Card title="Markdown">
          <Textarea className="min-h-[60vh] font-mono text-xs leading-relaxed" spellCheck={false} value={draft.content} onChange={(e) => set('content', e.target.value)} />
        </Card>
        <Card title="Preview">
          <Markdown source={draft.content} className="max-h-[60vh] overflow-auto" />
        </Card>
      </div>
    </>
  );
}
