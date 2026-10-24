import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Megaphone, Plus } from 'lucide-react';
import { api } from '../../lib/api';
import { useForm } from '../../lib/forms';
import { formatDate } from '../../lib/format';
import { Markdown } from '../../theme/i18n';
import { Alert, Badge, Button, Card, EmptyState, Field, Input, Modal, PageHeader, PageLoader, Select, Switch, Table, Td, Textarea } from '../../components/ui';

type Tone = 'primary' | 'success' | 'warning' | 'danger';

interface Announcement {
  id: number;
  title: string;
  body: string;
  tone: Tone;
  active: boolean;
  startsAt: string | null;
  endsAt: string | null;
  createdAt: string;
}

/** "2026-10-24T13:05" for <input type="datetime-local"> from an ISO date. */
const toLocalInput = (iso: string | null) => (iso ? new Date(new Date(iso).getTime() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : '');

export function AnnouncementsPage() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['admin', 'announcements'], queryFn: () => api.get<{ data: Announcement[] }>('/admin/announcements').then((r) => r.data) });
  const [editing, setEditing] = useState<Announcement | 'new' | null>(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['admin', 'announcements'] });
    void qc.invalidateQueries({ queryKey: ['announcements'] });
  };
  const remove = useMutation({ mutationFn: (id: number) => api.delete(`/admin/announcements/${id}`), onSuccess: refresh });

  return (
    <>
      <PageHeader
        title="Announcements"
        description="Messages on everyone's dashboard: maintenance, events, new servers."
        actions={
          <Button icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>
            New announcement
          </Button>
        }
      />
      <Card padded={false}>
        {isLoading ? (
          <PageLoader />
        ) : !data?.length ? (
          <EmptyState icon={<Megaphone className="size-8" />} title="No announcements" />
        ) : (
          <Table head={['Announcement', 'Shown', '']}>
            {data.map((a) => (
              <tr key={a.id}>
                <Td>
                  <button className="text-left font-medium hover:text-primary" onClick={() => setEditing(a)}>
                    {a.title}
                  </button>{' '}
                  {!a.active && <Badge>Hidden</Badge>}
                </Td>
                <Td className="text-xs text-muted">
                  {a.startsAt ? `from ${formatDate(a.startsAt)}` : 'now'} {a.endsAt ? `until ${formatDate(a.endsAt)}` : ''}
                </Td>
                <Td className="text-right">
                  <Button size="sm" variant="ghost" onClick={() => confirm(`Delete "${a.title}"?`) && remove.mutate(a.id)}>
                    Delete
                  </Button>
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      {editing && <AnnouncementModal announcement={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={refresh} />}
    </>
  );
}

function AnnouncementModal({ announcement, onClose, onSaved }: { announcement: Announcement | null; onClose: () => void; onSaved: () => void }) {
  const form = useForm({
    title: announcement?.title ?? '',
    body: announcement?.body ?? '',
    tone: announcement?.tone ?? ('primary' as Tone),
    active: announcement?.active ?? true,
    startsAt: toLocalInput(announcement?.startsAt ?? null),
    endsAt: toLocalInput(announcement?.endsAt ?? null),
  });
  const onSubmit = form.submit(async (v) => {
    const body = { ...v, startsAt: v.startsAt ? new Date(v.startsAt).toISOString() : null, endsAt: v.endsAt ? new Date(v.endsAt).toISOString() : null };
    if (announcement) await api.patch(`/admin/announcements/${announcement.id}`, body);
    else await api.post('/admin/announcements', body);
    onSaved();
    onClose();
  });
  return (
    <Modal open onClose={onClose} title={announcement ? 'Edit announcement' : 'New announcement'} wide>
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        {form.error && !form.fieldError('endsAt') && <Alert>{form.error.message}</Alert>}
        <Field label="Title">{(id) => <Input id={id} required {...form.bind('title')} />}</Field>
        <Field label="Message (Markdown)">{(id) => <Textarea id={id} rows={5} {...form.bind('body')} />}</Field>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Color">
            {(id) => (
              <Select id={id} value={form.values.tone} onChange={(e) => form.set('tone', e.target.value as Tone)}>
                <option value="primary">Brand</option>
                <option value="success">Green</option>
                <option value="warning">Amber</option>
                <option value="danger">Red</option>
              </Select>
            )}
          </Field>
          <Field label="Show from (optional)">{(id) => <Input id={id} type="datetime-local" {...form.bind('startsAt')} />}</Field>
          <Field label="Until (optional)" error={form.fieldError('endsAt')}>{(id) => <Input id={id} type="datetime-local" {...form.bind('endsAt')} />}</Field>
        </div>
        <Switch checked={form.values.active} onChange={(v) => form.set('active', v)} label="Visible" />
        {form.values.body && (
          <div className="rounded-ui border border-border p-4">
            <p className="mb-2 text-xs uppercase tracking-wide text-muted">Preview</p>
            <Markdown source={form.values.body} className="text-sm" />
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={form.submitting}>
            {announcement ? 'Save' : 'Publish'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
