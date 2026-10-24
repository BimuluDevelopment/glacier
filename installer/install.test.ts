import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const script = join(__dirname, 'install.sh');

// On Windows, a bare "bash" is System32's WSL launcher (found before PATH), which may have no
// Linux installed, so use Git Bash there.
const bash = (process.platform === 'win32' ? [join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe')] : ['bash']).find(
  (b) => spawnSync(b, ['-c', 'echo ok'], { encoding: 'utf8' }).stdout?.trim() === 'ok',
);

describe.skipIf(!bash)('install.sh', () => {
  it('parses', () => {
    expect(spawnSync(bash!, ['-n', script], { encoding: 'utf8' }).stderr).toBe('');
  });

  // `bash -n` passes even when a stray quote swallows the functions after it, so load the
  // script (minus its final `main "$@"`) from stdin, the way `curl | bash` runs it, and check
  // every function it declares really exists.
  it('defines every function', () => {
    const source = readFileSync(script, 'utf8');
    const declared = [...source.matchAll(/^([a-z_]+)\(\) *\{/gm)].map((m) => m[1]);
    const body = source.replace(/^main "\$@"\s*$/m, '');
    const res = spawnSync(bash!, ['-s'], { input: `${body}\ndeclare -F | cut -d' ' -f3\n`, encoding: 'utf8' });
    const defined = new Set(res.stdout.split(/\r?\n/));
    expect(declared.length).toBeGreaterThan(20);
    expect(declared.filter((name) => !defined.has(name!))).toEqual([]);
  });
});
