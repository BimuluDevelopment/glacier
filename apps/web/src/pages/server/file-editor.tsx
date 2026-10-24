import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import CodeMirror, { EditorView, Prec, keymap, type Extension } from '@uiw/react-codemirror';
import { json } from '@codemirror/lang-json';
import { yaml } from '@codemirror/lang-yaml';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { StreamLanguage } from '@codemirror/language';
import { properties } from '@codemirror/legacy-modes/mode/properties';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { toml } from '@codemirror/legacy-modes/mode/toml';
import { ArrowLeft, Check, Save } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { useServer } from '../../features/server/context';
import { useTheme } from '../../theme/ThemeProvider';
import { Alert, Badge, Button, Input, PageLoader } from '../../components/ui';
import { joinPath } from './files';

function languageFor(name: string): Extension[] {
  const lower = name.toLowerCase();
  const ext = lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : '';
  switch (ext) {
    case 'json':
    case 'mcmeta':
      return [json()];
    case 'yml':
    case 'yaml':
      return [yaml()];
    case 'js':
    case 'mjs':
    case 'cjs':
      return [javascript()];
    case 'ts':
      return [javascript({ typescript: true })];
    case 'py':
      return [python()];
    case 'properties':
    case 'ini':
    case 'cfg':
    case 'conf':
    case 'env':
      return [StreamLanguage.define(properties)];
    case 'sh':
    case 'bash':
      return [StreamLanguage.define(shell)];
    case 'toml':
      return [StreamLanguage.define(toml)];
    default:
      return lower === 'dockerfile' || lower.startsWith('.env') ? [StreamLanguage.define(shell)] : [];
  }
}

// The editor reads the same CSS variables as the rest of the panel, so it follows the admin's theme.
const panelTheme = EditorView.theme({
  '&': { backgroundColor: 'var(--sl-background)', color: 'var(--sl-text)', fontSize: '13px' },
  '.cm-content': { fontFamily: 'var(--font-mono)', caretColor: 'var(--sl-primary)' },
  '.cm-gutters': { backgroundColor: 'var(--sl-surface)', color: 'var(--sl-muted)', border: 'none' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--sl-primary) 7%, transparent)' },
  '.cm-activeLineGutter': { backgroundColor: 'color-mix(in srgb, var(--sl-primary) 12%, transparent)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': { backgroundColor: 'color-mix(in srgb, var(--sl-primary) 30%, transparent) !important' },
  '.cm-cursor': { borderLeftColor: 'var(--sl-primary)' },
  '.cm-panels': { backgroundColor: 'var(--sl-surface)', color: 'var(--sl-text)' },
});

export function FileEditorTab() {
  const { server, can, base } = useServer();
  const { mode } = useTheme();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const existing = params.get('file');
  const dir = existing ? existing.split('/').slice(0, -1).join('/') || '/' : params.get('dir') || '/';

  const [name, setName] = useState(existing ? existing.split('/').pop()! : '');
  const [content, setContent] = useState('');
  const [saved, setSaved] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);

  const { data, isLoading, error: loadError } = useQuery({
    queryKey: ['server', server.id, 'file', existing],
    queryFn: () => api.text(`${base}/files/contents?file=${encodeURIComponent(existing!)}`),
    enabled: Boolean(existing),
    gcTime: 0,
  });
  useEffect(() => {
    if (data !== undefined) {
      setContent(data);
      setSaved(data);
    }
  }, [data]);

  const dirty = content !== saved || (!existing && content !== '');
  const canSave = existing ? can('file.update') : can('file.create');

  const save = async () => {
    if (!canSave || saving) return;
    const target = joinPath(dir, name.trim());
    if (!name.trim()) return setError('Give the file a name first.');
    setSaving(true);
    setError(null);
    try {
      await api.post(`${base}/files/write`, { file: target, content, create: !existing });
      setSaved(content);
      setJustSaved(true);
      setTimeout(() => setJustSaved(false), 2000);
      void qc.invalidateQueries({ queryKey: ['server', server.id, 'files'] });
      if (!existing) navigate(`?file=${encodeURIComponent(target)}`, { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  // Warn before leaving with unsaved changes.
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  // Ctrl+S always calls the latest save without rebuilding the editor on every keystroke.
  const saveRef = useRef(save);
  saveRef.current = save;
  const extensions = useMemo(
    () => [
      ...languageFor(name),
      // Highest precedence so the panel colors win over the built-in light/dark theme.
      Prec.highest(panelTheme),
      EditorView.lineWrapping,
      keymap.of([{ key: 'Mod-s', preventDefault: true, run: () => (void saveRef.current(), true) }]),
    ],
    [name],
  );

  if (existing && isLoading) return <PageLoader />;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Link to={`../files${dir === '/' ? '' : `?dir=${encodeURIComponent(dir)}`}`} className="inline-flex items-center gap-1 text-sm text-muted hover:text-text">
          <ArrowLeft className="size-3.5" /> Files
        </Link>
        <span className="font-mono text-sm text-muted">{dir === '/' ? '/' : `${dir}/`}</span>
        {existing ? (
          <span className="font-mono text-sm">{name}</span>
        ) : (
          <Input className="h-8 w-60 font-mono" placeholder="new-file.txt" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
        )}
        {dirty && <Badge tone="warning">Unsaved</Badge>}
        <div className="ml-auto flex items-center gap-2">
          {justSaved && (
            <span className="flex items-center gap-1 text-sm text-success">
              <Check className="size-4" /> Saved
            </span>
          )}
          {canSave && (
            <Button size="sm" icon={<Save className="size-4" />} loading={saving} onClick={() => void save()} title="Save (Ctrl+S)">
              {existing ? 'Save' : 'Create file'}
            </Button>
          )}
        </div>
      </div>
      {(error || loadError) && <Alert>{error ?? errorMessage(loadError)}</Alert>}
      {!loadError && (
        <div className="overflow-hidden rounded-ui border border-border">
          <CodeMirror
            value={content}
            onChange={setContent}
            theme={mode}
            height="70vh"
            extensions={extensions}
            readOnly={!canSave}
            basicSetup={{ highlightActiveLine: true, foldGutter: true, searchKeymap: true }}
          />
        </div>
      )}
      <p className="text-xs text-muted">Ctrl+S saves · Ctrl+F searches · Ctrl+H replaces</p>
    </div>
  );
}
