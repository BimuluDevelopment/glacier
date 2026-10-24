import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { ChevronRight } from 'lucide-react';
import type { Line } from './useServerSocket';

const PREFIX = {
  daemon: '\x1b[1;33m[Glacier Panel]\x1b[0m ',
  install: '\x1b[1;36m[Installer]\x1b[0m ',
  error: '\x1b[1;31m[Error]\x1b[0m ',
  console: '',
  clear: '',
} as const;

function cssVar(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** xterm.js console. `register` hands the parent a writer for incoming lines. */
export function Console({
  register,
  onCommand,
  canCommand,
  placeholder = 'Type a command…',
}: {
  register: (write: (line: Line) => void) => void;
  onCommand: (command: string) => void;
  canCommand: boolean;
  placeholder?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [input, setInput] = useState('');
  const history = useRef<string[]>([]);
  const historyIndex = useRef(-1);

  useEffect(() => {
    const term = new Terminal({
      convertEol: true,
      disableStdin: true,
      cursorStyle: 'underline',
      fontSize: 13,
      lineHeight: 1.25,
      scrollback: 5000,
      fontFamily: `${cssVar('--sl-mono') || 'monospace'}, ui-monospace, Menlo, Consolas, monospace`,
      theme: {
        background: cssVar('--sl-background'),
        foreground: cssVar('--sl-text'),
        cursor: 'transparent',
        selectionBackground: cssVar('--sl-primary') + '55',
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current!);
    fit.fit();

    const observer = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        // Terminal disposed mid-resize.
      }
    });
    observer.observe(containerRef.current!);

    register((line) => {
      if (line.kind === 'clear') term.clear();
      else term.writeln(PREFIX[line.kind] + line.text);
    });

    return () => {
      observer.disconnect();
      term.dispose();
    };
  }, [register]);

  const submit = () => {
    const cmd = input.trim();
    if (!cmd) return;
    onCommand(cmd);
    history.current = [cmd, ...history.current.filter((c) => c !== cmd)].slice(0, 50);
    historyIndex.current = -1;
    setInput('');
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') submit();
    else if (e.key === 'ArrowUp') {
      e.preventDefault();
      historyIndex.current = Math.min(history.current.length - 1, historyIndex.current + 1);
      setInput(history.current[historyIndex.current] ?? '');
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      historyIndex.current = Math.max(-1, historyIndex.current - 1);
      setInput(historyIndex.current === -1 ? '' : (history.current[historyIndex.current] ?? ''));
    }
  };

  return (
    <div className="overflow-hidden rounded-ui border border-border bg-bg">
      <div ref={containerRef} className="h-[28rem] px-3 pt-3" />
      <div className="flex items-center gap-2 border-t border-border px-3">
        <ChevronRight className="size-4 text-primary" />
        <input
          className="h-11 flex-1 bg-transparent font-mono text-sm outline-none placeholder:text-muted disabled:cursor-not-allowed"
          placeholder={canCommand ? placeholder : 'Commands are unavailable right now'}
          value={input}
          disabled={!canCommand}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          aria-label="Console command"
        />
      </div>
    </div>
  );
}
