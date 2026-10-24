import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import {
  Archive,
  ChevronRight,
  Copy,
  Download,
  File,
  FileArchive,
  FilePlus,
  FileText,
  Folder,
  FolderPlus,
  Search,
  Lock,
  MoreHorizontal,
  Pencil,
  Trash2,
  Upload,
  PackageOpen,
} from 'lucide-react';
import type { FileEntry, FileSearchHit } from '@glacier/shared';
import { api, errorMessage } from '../../lib/api';
import { formatBytes, formatDate, timeAgo } from '../../lib/format';
import { useServer } from '../../features/server/context';
import { Alert, Button, Card, EmptyState, Field, Input, Modal, PageLoader } from '../../components/ui';

export function joinPath(dir: string, name: string) {
  return `${dir.endsWith('/') ? dir : `${dir}/`}${name}`;
}

const isArchive = (name: string) => /\.(zip|tar|tar\.gz|tgz|mrpack)$/i.test(name);

function FileIcon({ entry }: { entry: FileEntry }) {
  if (entry.isDirectory) return <Folder className="size-4 shrink-0 text-primary" />;
  if (isArchive(entry.name)) return <FileArchive className="size-4 shrink-0 text-warning" />;
  if (entry.editable) return <FileText className="size-4 shrink-0 text-muted" />;
  return <File className="size-4 shrink-0 text-muted" />;
}

type Dialog =
  | { kind: 'mkdir' }
  | { kind: 'rename'; entry: FileEntry }
  | { kind: 'chmod'; entry: FileEntry }
  | { kind: 'delete'; names: string[] };

export function FilesTab() {
  const { server, can, base } = useServer();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const dir = params.get('dir') || '/';
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [upload, setUpload] = useState<{ pct: number; names: string } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [searching, setSearching] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'danger' | 'success'; text: string } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const key = ['server', server.id, 'files', dir];
  const { data, isLoading, error } = useQuery({
    queryKey: key,
    queryFn: () => api.get<{ data: FileEntry[] }>(`${base}/files/list?directory=${encodeURIComponent(dir)}`).then((r) => r.data),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['server', server.id, 'files'] });

  useEffect(() => setSelected(new Set()), [dir]);

  const go = (path: string) => setParams(path === '/' ? {} : { dir: path });
  const crumbs = dir.split('/').filter(Boolean);

  const action = useMutation({
    mutationFn: async (fn: () => Promise<unknown>) => fn(),
    onSuccess: () => {
      setSelected(new Set());
      void refresh();
    },
    onError: (err) => setNotice({ tone: 'danger', text: errorMessage(err) }),
  });
  const run = (fn: () => Promise<unknown>, success?: string) =>
    action.mutate(async () => {
      setNotice(null);
      await fn();
      if (success) setNotice({ tone: 'success', text: success });
    });

  const download = async (entry: FileEntry) => {
    try {
      const { url } = await api.get<{ url: string }>(`${base}/files/download?file=${encodeURIComponent(joinPath(dir, entry.name))}`);
      window.location.href = url;
    } catch (err) {
      setNotice({ tone: 'danger', text: errorMessage(err) });
    }
  };

  const uploadFiles = async (files: File[]) => {
    if (!files.length || !can('file.create')) return;
    setNotice(null);
    try {
      const { url, maxBytes } = await api.get<{ url: string; maxBytes: number }>(`${base}/files/upload`);
      const tooBig = files.find((f) => f.size > maxBytes);
      if (tooBig) throw new Error(`"${tooBig.name}" is larger than the ${formatBytes(maxBytes, 0)} upload limit. Use SFTP for big files.`);
      const form = new FormData();
      for (const f of files) form.append('files', f, f.name);
      setUpload({ pct: 0, names: files.length === 1 ? files[0]!.name : `${files.length} files` });
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `${url}&directory=${encodeURIComponent(dir)}`);
        xhr.upload.onprogress = (e) => e.lengthComputable && setUpload((u) => u && { ...u, pct: Math.round((e.loaded / e.total) * 100) });
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) return resolve();
          let message = `Upload failed (${xhr.status})`;
          try {
            message = JSON.parse(xhr.responseText).message ?? message;
          } catch {
            // keep default
          }
          reject(new Error(message));
        };
        xhr.onerror = () => reject(new Error("Couldn't reach the node. Is its daemon online and its certificate trusted?"));
        xhr.send(form);
      });
      setNotice({ tone: 'success', text: `Uploaded ${files.length === 1 ? files[0]!.name : `${files.length} files`}.` });
      void refresh();
    } catch (err) {
      setNotice({ tone: 'danger', text: errorMessage(err) });
    } finally {
      setUpload(null);
    }
  };

  const toggle = (name: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  const allSelected = Boolean(data?.length) && data!.every((e) => selected.has(e.name));

  const open = (entry: FileEntry) => {
    if (entry.isDirectory) go(joinPath(dir, entry.name));
    else if (entry.editable) navigate(`edit?file=${encodeURIComponent(joinPath(dir, entry.name))}`);
    else if (can('file.read')) void download(entry);
  };

  return (
    <div
      className="relative"
      onDragOver={(e) => {
        if (!can('file.create') || !e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        void uploadFiles(Array.from(e.dataTransfer.files));
      }}
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <nav className="flex min-w-0 flex-wrap items-center gap-1 font-mono text-sm">
          <button onClick={() => go('/')} className="rounded px-1.5 py-0.5 text-muted hover:bg-surface-alt hover:text-text">
            /home/container
          </button>
          {crumbs.map((c, i) => (
            <span key={i} className="flex items-center gap-1">
              <ChevronRight className="size-3.5 text-muted" />
              <button onClick={() => go('/' + crumbs.slice(0, i + 1).join('/'))} className="rounded px-1.5 py-0.5 hover:bg-surface-alt">
                {c}
              </button>
            </span>
          ))}
        </nav>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" icon={<Search className="size-4" />} onClick={() => setSearching((v) => !v)}>
            Search
          </Button>
          {can('file.create') && (
            <>
              <Button size="sm" variant="secondary" icon={<FolderPlus className="size-4" />} onClick={() => setDialog({ kind: 'mkdir' })}>
                New folder
              </Button>
              <Link to={`edit?dir=${encodeURIComponent(dir)}`}>
                <Button size="sm" variant="secondary" icon={<FilePlus className="size-4" />}>
                  New file
                </Button>
              </Link>
              <Button size="sm" icon={<Upload className="size-4" />} loading={Boolean(upload)} onClick={() => fileInput.current?.click()}>
                Upload
              </Button>
              <input
                ref={fileInput}
                type="file"
                multiple
                hidden
                onChange={(e) => {
                  void uploadFiles(Array.from(e.target.files ?? []));
                  e.target.value = '';
                }}
              />
            </>
          )}
        </div>
      </div>

      {searching && <FileSearch directory={dir} onClose={() => setSearching(false)} />}

      {notice && (
        <div className="mb-4">
          <Alert tone={notice.tone}>{notice.text}</Alert>
        </div>
      )}
      {upload && (
        <div className="mb-4 rounded-ui border border-border bg-surface p-3 text-sm">
          <div className="mb-2 flex justify-between">
            <span>Uploading {upload.names}…</span>
            <span className="tabular-nums text-muted">{upload.pct}%</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-surface-alt">
            <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${upload.pct}%` }} />
          </div>
        </div>
      )}

      {selected.size > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-ui border border-primary/40 bg-primary/8 px-4 py-2 text-sm">
          <span className="mr-auto">{selected.size} selected</span>
          {can('file.archive') && (
            <Button size="sm" variant="secondary" icon={<Archive className="size-4" />} loading={action.isPending} onClick={() => run(() => api.post(`${base}/files/compress`, { root: dir, files: [...selected] }), 'Archive created.')}>
              Archive
            </Button>
          )}
          {can('file.delete') && (
            <Button size="sm" variant="danger" icon={<Trash2 className="size-4" />} onClick={() => setDialog({ kind: 'delete', names: [...selected] })}>
              Delete
            </Button>
          )}
        </div>
      )}

      <Card padded={false}>
        {isLoading ? (
          <PageLoader />
        ) : error ? (
          <div className="p-5">
            <Alert>{errorMessage(error)}</Alert>
          </div>
        ) : !data?.length ? (
          <EmptyState icon={<Folder className="size-8" />} title="This folder is empty">
            {can('file.create') && 'Drop files here to upload them.'}
          </EmptyState>
        ) : (
          <div className="divide-y divide-border text-sm">
            <div className="flex items-center gap-3 px-4 py-2 text-xs uppercase tracking-wide text-muted">
              <input
                type="checkbox"
                aria-label="Select all"
                checked={allSelected}
                onChange={() => setSelected(allSelected ? new Set() : new Set(data.map((e) => e.name)))}
                className="accent-[var(--sl-primary)]"
              />
              <span className="flex-1">Name</span>
              <span className="hidden w-24 text-right sm:block">Size</span>
              <span className="hidden w-32 text-right md:block">Modified</span>
              <span className="w-8" />
            </div>
            {dir !== '/' && (
              <button onClick={() => go(dir.split('/').slice(0, -1).join('/') || '/')} className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-muted hover:bg-surface-alt/60">
                <span className="w-[13px]" />
                <Folder className="size-4" /> ..
              </button>
            )}
            {data.map((entry) => (
              <div key={entry.name} className={clsx('group flex items-center gap-3 px-4 py-2', selected.has(entry.name) ? 'bg-primary/8' : 'hover:bg-surface-alt/60')}>
                <input type="checkbox" aria-label={`Select ${entry.name}`} checked={selected.has(entry.name)} onChange={() => toggle(entry.name)} className="accent-[var(--sl-primary)]" />
                <button onClick={() => open(entry)} className="flex min-w-0 flex-1 items-center gap-2.5 text-left">
                  <FileIcon entry={entry} />
                  <span className="truncate">{entry.name}</span>
                </button>
                <span className="hidden w-24 text-right tabular-nums text-muted sm:block">{entry.isFile ? formatBytes(entry.size) : ''}</span>
                <span className="hidden w-32 text-right text-muted md:block" title={formatDate(entry.modifiedAt)}>
                  {timeAgo(entry.modifiedAt)}
                </span>
                <RowMenu>
                  {entry.editable && (
                    <MenuItem icon={<Pencil className="size-4" />} onClick={() => navigate(`edit?file=${encodeURIComponent(joinPath(dir, entry.name))}`)}>
                      Edit
                    </MenuItem>
                  )}
                  {can('file.update') && (
                    <MenuItem icon={<Pencil className="size-4" />} onClick={() => setDialog({ kind: 'rename', entry })}>
                      Rename / move
                    </MenuItem>
                  )}
                  {can('file.create') && (
                    <MenuItem icon={<Copy className="size-4" />} onClick={() => run(() => api.post(`${base}/files/copy`, { location: joinPath(dir, entry.name) }))}>
                      Copy
                    </MenuItem>
                  )}
                  {entry.isFile && (
                    <MenuItem icon={<Download className="size-4" />} onClick={() => void download(entry)}>
                      Download
                    </MenuItem>
                  )}
                  {entry.isFile && isArchive(entry.name) && can('file.archive') && (
                    <MenuItem icon={<PackageOpen className="size-4" />} onClick={() => run(() => api.post(`${base}/files/decompress`, { root: dir, file: entry.name }), `Extracted ${entry.name}.`)}>
                      Extract here
                    </MenuItem>
                  )}
                  {can('file.update') && (
                    <MenuItem icon={<Lock className="size-4" />} onClick={() => setDialog({ kind: 'chmod', entry })}>
                      Permissions
                    </MenuItem>
                  )}
                  {can('file.delete') && (
                    <MenuItem icon={<Trash2 className="size-4" />} danger onClick={() => setDialog({ kind: 'delete', names: [entry.name] })}>
                      Delete
                    </MenuItem>
                  )}
                </RowMenu>
              </div>
            ))}
          </div>
        )}
      </Card>

      {dragging && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-ui border-2 border-dashed border-primary bg-bg/80 text-lg font-medium">
          Drop to upload to {dir}
        </div>
      )}

      {dialog?.kind === 'mkdir' && (
        <PromptDialog
          title="New folder"
          label="Folder name"
          initial=""
          onClose={() => setDialog(null)}
          onSubmit={(name) => api.post(`${base}/files/create-directory`, { root: dir, name }).then(refresh)}
        />
      )}
      {dialog?.kind === 'rename' && (
        <PromptDialog
          title={`Rename ${dialog.entry.name}`}
          label="New name"
          hint="Use a path like ../plugins/name.jar to move it."
          initial={dialog.entry.name}
          onClose={() => setDialog(null)}
          onSubmit={(to) => api.put(`${base}/files/rename`, { root: dir, files: [{ from: dialog.entry.name, to }] }).then(refresh)}
        />
      )}
      {dialog?.kind === 'chmod' && (
        <PromptDialog
          title={`Permissions for ${dialog.entry.name}`}
          label="Mode"
          hint={`Currently ${dialog.entry.mode} (${dialog.entry.modeBits}). Use three octal digits like 644 or 755.`}
          initial={dialog.entry.modeBits}
          onClose={() => setDialog(null)}
          onSubmit={(mode) => api.post(`${base}/files/chmod`, { root: dir, files: [{ file: dialog.entry.name, mode }] }).then(refresh)}
        />
      )}
      {dialog?.kind === 'delete' && (
        <ConfirmDialog
          title="Delete files"
          body={dialog.names.length === 1 ? `Permanently delete "${dialog.names[0]}"?` : `Permanently delete ${dialog.names.length} items?`}
          confirm="Delete"
          onClose={() => setDialog(null)}
          onConfirm={() =>
            api.post(`${base}/files/delete`, { root: dir, files: dialog.names }).then(() => {
              setSelected(new Set());
              return refresh();
            })
          }
        />
      )}
    </div>
  );
}

function RowMenu({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  return (
    <div ref={ref} className="relative w-8">
      <button onClick={() => setOpen((o) => !o)} className="rounded p-1.5 text-muted hover:bg-surface-alt hover:text-text" aria-label="File actions">
        <MoreHorizontal className="size-4" />
      </button>
      {open && (
        <div className="absolute right-0 z-20 mt-1 w-48 overflow-hidden rounded-ui border border-border bg-surface py-1 shadow-xl" onClick={() => setOpen(false)}>
          {children}
        </div>
      )}
    </div>
  );
}

function MenuItem({ icon, children, onClick, danger }: { icon: React.ReactNode; children: React.ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <button onClick={onClick} className={clsx('flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm hover:bg-surface-alt', danger && 'text-danger')}>
      {icon}
      {children}
    </button>
  );
}

export function PromptDialog({
  title,
  label,
  hint,
  initial,
  onClose,
  onSubmit,
}: {
  title: string;
  label: string;
  hint?: string;
  initial: string;
  onClose: () => void;
  onSubmit: (value: string) => Promise<unknown>;
}) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Modal open onClose={onClose} title={title}>
      <form
        className="flex flex-col gap-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await onSubmit(value.trim());
            onClose();
          } catch (err) {
            setError(errorMessage(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        {error && <Alert>{error}</Alert>}
        <Field label={label} hint={hint}>
          {(id) => <Input id={id} autoFocus required value={value} onChange={(e) => setValue(e.target.value)} />}
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={busy}>
            Save
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export function ConfirmDialog({
  title,
  body,
  confirm,
  onClose,
  onConfirm,
  children,
}: {
  title: string;
  body: React.ReactNode;
  confirm: string;
  onClose: () => void;
  onConfirm: () => Promise<unknown>;
  children?: React.ReactNode;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Modal open onClose={onClose} title={title}>
      <div className="flex flex-col gap-4">
        {error && <Alert>{error}</Alert>}
        <div className="text-sm">{body}</div>
        {children}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            loading={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await onConfirm();
                onClose();
              } catch (err) {
                setError(errorMessage(err));
              } finally {
                setBusy(false);
              }
            }}
          >
            {confirm}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/** Find files by name (and optionally contents) below the current folder. */
function FileSearch({ directory, onClose }: { directory: string; onClose: () => void }) {
  const { base } = useServer();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [content, setContent] = useState(false);
  const [submitted, setSubmitted] = useState<{ query: string; content: boolean } | null>(null);
  const { data, isFetching, error } = useQuery({
    queryKey: ['file-search', base, directory, submitted],
    queryFn: () =>
      api.get<{ hits: FileSearchHit[]; truncated: boolean }>(
        `${base}/files/search?${new URLSearchParams({ query: submitted!.query, directory, content: String(submitted!.content) })}`,
      ),
    enabled: Boolean(submitted),
  });
  const open = (hit: FileSearchHit) => {
    if (hit.path.endsWith('/')) {
      const dir = hit.path.slice(0, -1);
      navigate(dir ? `?dir=${encodeURIComponent(dir)}` : '.');
      onClose();
    } else navigate(`edit?file=${encodeURIComponent(hit.path)}`);
  };
  return (
    <Card className="mb-4" padded={false}>
      <form
        className="flex flex-wrap items-center gap-3 border-b border-border p-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (query.trim().length >= 2) setSubmitted({ query: query.trim(), content });
        }}
      >
        <Input className="h-9 min-w-56 flex-1" autoFocus placeholder={`Search in ${directory === '/' ? 'all files' : directory}`} value={query} onChange={(e) => setQuery(e.target.value)} />
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="accent-[var(--sl-primary)]" checked={content} onChange={(e) => setContent(e.target.checked)} />
          Search inside text files
        </label>
        <Button size="sm" type="submit" loading={isFetching} disabled={query.trim().length < 2}>
          Search
        </Button>
        <Button size="sm" type="button" variant="ghost" onClick={onClose}>
          Close
        </Button>
      </form>
      {error && (
        <div className="p-3">
          <Alert>{errorMessage(error)}</Alert>
        </div>
      )}
      {data &&
        (data.hits.length === 0 ? (
          <p className="p-4 text-sm text-muted">Nothing found.</p>
        ) : (
          <ul className="max-h-80 divide-y divide-border overflow-y-auto text-sm">
            {data.hits.map((h) => (
              <li key={`${h.path}:${h.line ?? 0}`}>
                <button className="w-full px-4 py-2 text-left hover:bg-surface-alt/60" onClick={() => open(h)}>
                  <span className="font-mono text-xs">{h.path}</span>
                  {h.line && (
                    <span className="mt-0.5 block truncate font-mono text-xs text-muted">
                      {h.line}: {h.preview}
                    </span>
                  )}
                </button>
              </li>
            ))}
            {data.truncated && <li className="px-4 py-2 text-xs text-muted">Showing the first results only. Narrow the search or pick a folder.</li>}
          </ul>
        ))}
    </Card>
  );
}
