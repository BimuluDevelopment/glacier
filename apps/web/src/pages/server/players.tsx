import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, Crown, LogOut, ShieldCheck, Users } from 'lucide-react';
import type { MinecraftStatus, PlayerEntry } from '@glacier/shared';
import { api, errorMessage } from '../../lib/api';
import { useForm } from '../../lib/forms';
import { useServer } from '../../features/server/context';
import { Alert, Badge, Button, Card, EmptyState, Input, PageLoader } from '../../components/ui';

type Action = 'whitelist-add' | 'whitelist-remove' | 'op' | 'deop' | 'ban' | 'pardon' | 'kick';

interface PlayersData {
  status: MinecraftStatus;
  whitelist: PlayerEntry[];
  ops: PlayerEntry[];
  banned: PlayerEntry[];
}

/** Player heads from a public avatar service, keyed by UUID (falls back to the name). */
const head = (p: { name: string; uuid?: string; id?: string }) => `https://mc-heads.net/avatar/${encodeURIComponent(p.uuid || p.id || p.name)}/32`;

export function PlayersTab() {
  const { server, base, can } = useServer();
  const qc = useQueryClient();
  const key = ['server', server.id, 'players'];
  const { data, isLoading, error } = useQuery({ queryKey: key, queryFn: () => api.get<PlayersData>(`${base}/players`), refetchInterval: 20_000 });
  const [notice, setNotice] = useState<string | null>(null);
  const act = useMutation({
    mutationFn: (b: { action: Action; name: string; reason?: string }) => api.post<{ applied: 'console' | 'file' }>(`${base}/players`, b),
    onSuccess: (r, b) => {
      setNotice(r.applied === 'console' ? `Sent to the server: ${b.action.replace('-', ' ')} ${b.name}.` : `Saved. The change applies the next time the server starts.`);
      // The server writes its JSON files a moment after the command.
      setTimeout(() => void qc.invalidateQueries({ queryKey: key }), 1500);
    },
  });
  if (isLoading) return <PageLoader />;
  if (error || !data) return <Alert>{errorMessage(error)}</Alert>;
  const manage = can('players.manage');
  const { status } = data;

  return (
    <div className="flex flex-col gap-6">
      {notice && <Alert tone="success">{notice}</Alert>}
      {act.error && <Alert>{act.error.message}</Alert>}

      <Card
        title="Online now"
        actions={status.online ? <Badge tone="success">{status.players?.online ?? 0} / {status.players?.max ?? 0}</Badge> : <Badge>Offline</Badge>}
        padded={false}
      >
        {!status.online ? (
          <EmptyState icon={<Users className="size-7" />} title="The server isn't running">
            Whitelist, op and ban changes are saved to the server's files and apply on the next start.
          </EmptyState>
        ) : (
          <>
            <div className="border-b border-border px-5 py-3 text-xs text-muted">
              {status.version} · {status.latencyMs} ms {status.motd && <span className="ml-2 text-text">“{status.motd}”</span>}
            </div>
            {!status.players?.sample.length ? (
              <EmptyState title={status.players?.online ? 'This server hides its player list' : 'Nobody is online'} />
            ) : (
              <ul className="divide-y divide-border">
                {status.players.sample.map((p) => (
                  <li key={p.id} className="flex items-center gap-3 px-5 py-2.5">
                    <img src={head(p)} alt="" className="size-7 rounded" loading="lazy" />
                    <span className="flex-1 font-medium">{p.name}</span>
                    {manage && (
                      <div className="flex gap-1">
                        <Button size="sm" variant="ghost" icon={<Crown className="size-4" />} onClick={() => act.mutate({ action: 'op', name: p.name })}>
                          Op
                        </Button>
                        <Button size="sm" variant="ghost" icon={<LogOut className="size-4" />} onClick={() => act.mutate({ action: 'kick', name: p.name, reason: prompt('Kick reason (optional)') ?? undefined })}>
                          Kick
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-danger"
                          icon={<Ban className="size-4" />}
                          onClick={() => {
                            const reason = prompt(`Ban ${p.name}? Reason (optional):`);
                            if (reason !== null) act.mutate({ action: 'ban', name: p.name, reason: reason || undefined });
                          }}
                        >
                          Ban
                        </Button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </Card>

      <div className="grid gap-6 xl:grid-cols-3">
        <PlayerList
          title="Whitelist"
          icon={<ShieldCheck className="size-4" />}
          hint="Only listed players can join when white-list=true in server.properties."
          players={data.whitelist}
          addLabel="Add"
          onAdd={manage ? (name) => act.mutate({ action: 'whitelist-add', name }) : undefined}
          onRemove={manage ? (p) => act.mutate({ action: 'whitelist-remove', name: p.name }) : undefined}
        />
        <PlayerList
          title="Operators"
          icon={<Crown className="size-4" />}
          hint="Ops can use every command."
          players={data.ops}
          addLabel="Op"
          onAdd={manage ? (name) => act.mutate({ action: 'op', name }) : undefined}
          onRemove={manage ? (p) => act.mutate({ action: 'deop', name: p.name }) : undefined}
        />
        <PlayerList
          title="Banned"
          icon={<Ban className="size-4" />}
          players={data.banned}
          addLabel="Ban"
          onAdd={manage ? (name) => act.mutate({ action: 'ban', name }) : undefined}
          onRemove={manage ? (p) => act.mutate({ action: 'pardon', name: p.name }) : undefined}
          removeLabel="Unban"
        />
      </div>
    </div>
  );
}

function PlayerList({
  title,
  icon,
  hint,
  players,
  addLabel,
  onAdd,
  onRemove,
  removeLabel = 'Remove',
}: {
  title: string;
  icon: React.ReactNode;
  hint?: string;
  players: PlayerEntry[];
  addLabel: string;
  onAdd?: (name: string) => void;
  onRemove?: (p: PlayerEntry) => void;
  removeLabel?: string;
}) {
  const form = useForm({ name: '' });
  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          {icon} {title} <span className="font-normal text-muted">({players.length})</span>
        </span>
      }
      padded={false}
    >
      {hint && <p className="border-b border-border px-5 py-2 text-xs text-muted">{hint}</p>}
      {onAdd && (
        <form
          className="flex gap-2 border-b border-border p-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!/^[A-Za-z0-9_]{3,16}$/.test(form.values.name)) return;
            onAdd(form.values.name);
            form.set('name', '');
          }}
        >
          <Input className="h-9" placeholder="Player name" {...form.bind('name')} aria-label={`${addLabel} player`} />
          <Button size="sm" className="h-9" type="submit">
            {addLabel}
          </Button>
        </form>
      )}
      {players.length === 0 ? (
        <p className="px-5 py-6 text-center text-sm text-muted">Nobody yet.</p>
      ) : (
        <ul className="max-h-80 divide-y divide-border overflow-y-auto">
          {players.map((p) => (
            <li key={p.uuid || p.name} className="flex items-center gap-3 px-4 py-2">
              <img src={head(p)} alt="" className="size-6 rounded" loading="lazy" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{p.name}</div>
                {p.detail && <div className="truncate text-xs text-muted">{p.detail}</div>}
              </div>
              {onRemove && (
                <Button size="sm" variant="ghost" onClick={() => onRemove(p)}>
                  {removeLabel}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
