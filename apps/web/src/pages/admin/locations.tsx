import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { useForm } from '../../lib/forms';
import { Alert, Button, Card, Input, PageHeader, PageLoader, Table, Td } from '../../components/ui';

export interface Location {
  id: number;
  short: string;
  long: string | null;
  _count: { nodes: number };
}

export function useLocations() {
  return useQuery({ queryKey: ['admin', 'locations'], queryFn: () => api.get<{ data: Location[] }>('/admin/locations').then((r) => r.data) });
}

export function LocationsPage() {
  const qc = useQueryClient();
  const { data, isLoading } = useLocations();
  const form = useForm({ short: '', long: '' });
  const refresh = () => qc.invalidateQueries({ queryKey: ['admin', 'locations'] });
  const onSubmit = form.submit(async (v) => {
    await api.post('/admin/locations', { short: v.short, long: v.long || null });
    form.setValues({ short: '', long: '' });
    await refresh();
  });
  const remove = useMutation({ mutationFn: (id: number) => api.delete(`/admin/locations/${id}`), onSuccess: refresh });

  return (
    <>
      <PageHeader title="Locations" description="Group nodes by region or data center." />
      <Card className="mb-6">
        <form onSubmit={onSubmit} className="flex flex-col gap-3 sm:flex-row sm:items-start">
          <div className="flex-1">
            <Input placeholder="Short code, e.g. eu-west" required {...form.bind('short')} />
            {form.fieldError('short') && <p className="mt-1 text-xs text-danger">{form.fieldError('short')}</p>}
          </div>
          <Input className="flex-[2]" placeholder="Description, e.g. Amsterdam, NL" {...form.bind('long')} />
          <Button type="submit" loading={form.submitting}>
            Add location
          </Button>
        </form>
        {form.error && !form.fieldError('short') && (
          <div className="mt-3">
            <Alert>{form.error.message}</Alert>
          </div>
        )}
      </Card>
      {remove.error && (
        <div className="mb-4">
          <Alert>{remove.error.message}</Alert>
        </div>
      )}
      <Card padded={false}>
        {isLoading ? (
          <PageLoader />
        ) : (
          <Table head={['Code', 'Description', 'Nodes', '']}>
            {data?.map((l) => (
              <tr key={l.id}>
                <Td className="font-mono">{l.short}</Td>
                <Td className="text-muted">{l.long ?? '—'}</Td>
                <Td>{l._count.nodes}</Td>
                <Td className="text-right">
                  <Button variant="ghost" size="sm" disabled={l._count.nodes > 0} onClick={() => remove.mutate(l.id)}>
                    Delete
                  </Button>
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
}
