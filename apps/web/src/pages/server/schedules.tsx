import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, ChevronDown, ChevronRight, Pencil, Play, Plus, Trash2 } from 'lucide-react';
import { api } from '../../lib/api';
import { useForm } from '../../lib/forms';
import { formatDate, timeAgo } from '../../lib/format';
import { useServer } from '../../features/server/context';
import { Alert, Badge, Button, Card, EmptyState, Field, Input, Modal, PageLoader, Select, Switch } from '../../components/ui';
import { ConfirmDialog } from './files';
import { IconButton } from './backups';

interface Task {
  id: number;
  sequence: number;
  action: 'command' | 'power' | 'backup';
  payload: string;
  timeOffset: number;
  continueOnFailure: boolean;
}

interface Schedule {
  id: number;
  name: string;
  cronMinute: string;
  cronHour: string;
  cronDayOfMonth: string;
  cronMonth: string;
  cronDayOfWeek: string;
  isActive: boolean;
  onlyWhenOnline: boolean;
  isProcessing: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  tasks: Task[];
}

const PRESETS: { label: string; cron: [string, string, string, string, string] }[] = [
  { label: 'Every 5 minutes', cron: ['*/5', '*', '*', '*', '*'] },
  { label: 'Every hour', cron: ['0', '*', '*', '*', '*'] },
  { label: 'Every 6 hours', cron: ['0', '*/6', '*', '*', '*'] },
  { label: 'Daily at 04:00', cron: ['0', '4', '*', '*', '*'] },
  { label: 'Weekly (Sunday 04:00)', cron: ['0', '4', '*', '*', '0'] },
];

const cronString = (s: Pick<Schedule, 'cronMinute' | 'cronHour' | 'cronDayOfMonth' | 'cronMonth' | 'cronDayOfWeek'>) =>
  `${s.cronMinute} ${s.cronHour} ${s.cronDayOfMonth} ${s.cronMonth} ${s.cronDayOfWeek}`;

function describeTask(t: Task) {
  if (t.action === 'command') return <>Send command <code className="rounded bg-bg px-1.5 py-0.5 font-mono text-xs">{t.payload}</code></>;
  if (t.action === 'power') return <>Power: <strong>{t.payload}</strong></>;
  return <>Create a backup{t.payload ? ' (with ignore rules)' : ''}</>;
}

export function SchedulesTab() {
  const { server, can, base } = useServer();
  const qc = useQueryClient();
  const key = ['server', server.id, 'schedules'];
  const { data, isLoading } = useQuery({
    queryKey: key,
    queryFn: () => api.get<{ data: Schedule[] }>(`${base}/schedules`).then((r) => r.data),
    refetchInterval: (q) => (q.state.data?.some((s) => s.isProcessing) ? 3_000 : 30_000),
  });
  const [editing, setEditing] = useState<Schedule | 'new' | null>(null);
  const [taskFor, setTaskFor] = useState<{ schedule: Schedule; task?: Task } | null>(null);
  const [deleting, setDeleting] = useState<Schedule | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: key });

  const execute = useMutation({ mutationFn: (s: Schedule) => api.post(`${base}/schedules/${s.id}/execute`), onSuccess: refresh });
  const removeTask = useMutation({ mutationFn: ({ s, t }: { s: Schedule; t: Task }) => api.delete(`${base}/schedules/${s.id}/tasks/${t.id}`), onSuccess: refresh });

  if (isLoading || !data) return <PageLoader />;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        {can('schedule.create') && (
          <Button icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>
            New schedule
          </Button>
        )}
      </div>
      {(execute.error || removeTask.error) && <Alert>{(execute.error ?? removeTask.error)!.message}</Alert>}
      {data.length === 0 ? (
        <Card>
          <EmptyState icon={<CalendarClock className="size-8" />} title="No schedules">
            Automate restarts, announcements and backups on a timer.
          </EmptyState>
        </Card>
      ) : (
        data.map((s) => (
          <Card key={s.id} padded={false}>
            <div className="flex flex-wrap items-center gap-3 px-5 py-4">
              <button onClick={() => setOpen(open === s.id ? null : s.id)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                {open === s.id ? <ChevronDown className="size-4 text-muted" /> : <ChevronRight className="size-4 text-muted" />}
                <div className="min-w-0">
                  <div className="flex items-center gap-2 font-medium">
                    {s.name}
                    {!s.isActive && <Badge>Paused</Badge>}
                    {s.isProcessing && <Badge tone="warning">Running</Badge>}
                  </div>
                  <div className="mt-0.5 font-mono text-xs text-muted">{cronString(s)}</div>
                </div>
              </button>
              <div className="text-right text-xs text-muted">
                <div>Next: {s.isActive && s.nextRunAt ? <span title={formatDate(s.nextRunAt)}>{timeAgo(s.nextRunAt)}</span> : '—'}</div>
                <div>Last: {s.lastRunAt ? <span title={formatDate(s.lastRunAt)}>{timeAgo(s.lastRunAt)}</span> : 'never'}</div>
              </div>
              {can('schedule.update') && (
                <div className="flex gap-1">
                  <IconButton label="Run now" disabled={s.isProcessing || !s.tasks.length} onClick={() => execute.mutate(s)}>
                    <Play className="size-4" />
                  </IconButton>
                  <IconButton label="Edit" onClick={() => setEditing(s)}>
                    <Pencil className="size-4" />
                  </IconButton>
                </div>
              )}
              {can('schedule.delete') && (
                <IconButton label="Delete" danger onClick={() => setDeleting(s)}>
                  <Trash2 className="size-4" />
                </IconButton>
              )}
            </div>
            {open === s.id && (
              <div className="border-t border-border px-5 py-4">
                {s.tasks.length === 0 ? (
                  <p className="text-sm text-muted">No tasks yet. A schedule does nothing until you add one.</p>
                ) : (
                  <ol className="flex flex-col gap-2">
                    {s.tasks.map((t) => (
                      <li key={t.id} className="flex items-center gap-3 rounded-ui bg-surface-alt px-3 py-2 text-sm">
                        <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary">{t.sequence}</span>
                        <span className="flex-1">
                          {t.timeOffset > 0 && <span className="text-muted">after {t.timeOffset}s · </span>}
                          {describeTask(t)}
                          {t.continueOnFailure && <span className="text-muted"> · continues on failure</span>}
                        </span>
                        {can('schedule.update') && (
                          <>
                            <IconButton label="Edit task" onClick={() => setTaskFor({ schedule: s, task: t })}>
                              <Pencil className="size-4" />
                            </IconButton>
                            <IconButton label="Delete task" danger onClick={() => removeTask.mutate({ s, t })}>
                              <Trash2 className="size-4" />
                            </IconButton>
                          </>
                        )}
                      </li>
                    ))}
                  </ol>
                )}
                {can('schedule.update') && s.tasks.length < 10 && (
                  <Button size="sm" variant="secondary" className="mt-3" icon={<Plus className="size-4" />} onClick={() => setTaskFor({ schedule: s })}>
                    Add task
                  </Button>
                )}
              </div>
            )}
          </Card>
        ))
      )}

      {editing && <ScheduleModal schedule={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={refresh} />}
      {taskFor && <TaskModal schedule={taskFor.schedule} task={taskFor.task} onClose={() => setTaskFor(null)} onSaved={refresh} />}
      {deleting && (
        <ConfirmDialog
          title="Delete schedule"
          body={`Delete "${deleting.name}" and its tasks?`}
          confirm="Delete"
          onClose={() => setDeleting(null)}
          onConfirm={() => api.delete(`${base}/schedules/${deleting.id}`).then(refresh)}
        />
      )}
    </div>
  );
}

function ScheduleModal({ schedule, onClose, onSaved }: { schedule: Schedule | null; onClose: () => void; onSaved: () => void }) {
  const { base } = useServer();
  const form = useForm({
    name: schedule?.name ?? '',
    cronMinute: schedule?.cronMinute ?? '0',
    cronHour: schedule?.cronHour ?? '4',
    cronDayOfMonth: schedule?.cronDayOfMonth ?? '*',
    cronMonth: schedule?.cronMonth ?? '*',
    cronDayOfWeek: schedule?.cronDayOfWeek ?? '*',
    isActive: schedule?.isActive ?? true,
    onlyWhenOnline: schedule?.onlyWhenOnline ?? false,
  });
  const onSubmit = form.submit(async (v) => {
    if (schedule) await api.patch(`${base}/schedules/${schedule.id}`, v);
    else await api.post(`${base}/schedules`, v);
    onSaved();
    onClose();
  });
  const fields = [
    ['cronMinute', 'Minute'],
    ['cronHour', 'Hour'],
    ['cronDayOfMonth', 'Day (month)'],
    ['cronMonth', 'Month'],
    ['cronDayOfWeek', 'Day (week)'],
  ] as const;

  return (
    <Modal open onClose={onClose} title={schedule ? 'Edit schedule' : 'New schedule'} wide>
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        {form.error && <Alert>{form.error.message}</Alert>}
        <Field label="Name" error={form.fieldError('name')}>{(id) => <Input id={id} required placeholder="Nightly restart" {...form.bind('name')} />}</Field>
        <div>
          <p className="mb-2 text-sm font-medium">When</p>
          <div className="mb-3 flex flex-wrap gap-2">
            {PRESETS.map((p) => (
              <button
                key={p.label}
                type="button"
                className="rounded-full border border-border px-3 py-1 text-xs hover:border-primary hover:text-primary"
                onClick={() =>
                  form.setValues((v) => ({ ...v, cronMinute: p.cron[0], cronHour: p.cron[1], cronDayOfMonth: p.cron[2], cronMonth: p.cron[3], cronDayOfWeek: p.cron[4] }))
                }
              >
                {p.label}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-5 gap-2">
            {fields.map(([k, label]) => (
              <Field key={k} label={label}>
                {(id) => <Input id={id} className="font-mono" required {...form.bind(k)} />}
              </Field>
            ))}
          </div>
          <p className="mt-2 text-xs text-muted">Standard cron syntax, in the panel's timezone. Example: 30 */2 * * 1-5 runs at :30 every two hours on weekdays.</p>
        </div>
        <Switch checked={form.values.isActive} onChange={(v) => form.set('isActive', v)} label="Active" />
        <Switch
          checked={form.values.onlyWhenOnline}
          onChange={(v) => form.set('onlyWhenOnline', v)}
          label="Only when the server is running"
          description="Skip the run if the server is offline (handy for command tasks)."
        />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={form.submitting}>
            {schedule ? 'Save' : 'Create'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function TaskModal({ schedule, task, onClose, onSaved }: { schedule: Schedule; task?: Task; onClose: () => void; onSaved: () => void }) {
  const { base, server } = useServer();
  const form = useForm({
    action: task?.action ?? 'command',
    payload: task?.payload ?? '',
    timeOffset: String(task?.timeOffset ?? 0),
    continueOnFailure: task?.continueOnFailure ?? false,
  });
  const onSubmit = form.submit(async (v) => {
    const body = { ...v, timeOffset: Number(v.timeOffset) };
    if (task) await api.patch(`${base}/schedules/${schedule.id}/tasks/${task.id}`, body);
    else await api.post(`${base}/schedules/${schedule.id}/tasks`, body);
    onSaved();
    onClose();
  });
  return (
    <Modal open onClose={onClose} title={task ? 'Edit task' : 'Add task'}>
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        {form.error && !form.fieldError('payload') && <Alert>{form.error.message}</Alert>}
        <Field label="Action">
          {(id) => (
            <Select
              id={id}
              value={form.values.action}
              onChange={(e) => form.setValues((v) => ({ ...v, action: e.target.value as Task['action'], payload: e.target.value === 'power' ? 'restart' : '' }))}
            >
              <option value="command">Send a console command</option>
              <option value="power">Power action</option>
              {server.featureLimits.backups > 0 && <option value="backup">Create a backup</option>}
            </Select>
          )}
        </Field>
        {form.values.action === 'command' && (
          <Field label="Command" error={form.fieldError('payload')}>{(id) => <Input id={id} className="font-mono" placeholder="say Restarting in 5 minutes!" {...form.bind('payload')} />}</Field>
        )}
        {form.values.action === 'power' && (
          <Field label="Power action" error={form.fieldError('payload')}>
            {(id) => (
              <Select id={id} {...form.bind('payload')}>
                <option value="start">Start</option>
                <option value="restart">Restart</option>
                <option value="stop">Stop</option>
                <option value="kill">Kill</option>
              </Select>
            )}
          </Field>
        )}
        {form.values.action === 'backup' && (
          <Field label="Ignored files (optional)" hint="One pattern per line. At the backup limit, the oldest unlocked backup is replaced.">
            {(id) => <Input id={id} className="font-mono" placeholder="logs/" {...form.bind('payload')} />}
          </Field>
        )}
        <Field label="Delay before this task (seconds)" hint="0–900. Use it to space out warnings before a restart.">
          {(id) => <Input id={id} type="number" min={0} max={900} {...form.bind('timeOffset')} />}
        </Field>
        <Switch checked={form.values.continueOnFailure} onChange={(v) => form.set('continueOnFailure', v)} label="Continue if this task fails" />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={form.submitting}>
            {task ? 'Save' : 'Add task'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
