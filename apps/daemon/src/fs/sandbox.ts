import { lstat, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';

export class SandboxError extends Error {}

export function isInside(root: string, target: string) {
  return target === root || target.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

/**
 * Resolve a user-supplied path inside a server's data directory. Rejects `..` escapes and
 * symlinks (on the path or any existing ancestor) that point outside the directory.
 */
export async function resolveSafe(root: string, userPath: string): Promise<string> {
  const rootReal = await realpath(root);
  const cleaned = userPath.replace(/\\/g, '/').replace(/^\/+/, '');
  const target = path.resolve(rootReal, cleaned);
  if (!isInside(rootReal, target)) throw new SandboxError(`Path "${userPath}" is outside the server directory`);

  let current = target;
  for (;;) {
    try {
      const real = await realpath(current);
      if (!isInside(rootReal, real)) throw new SandboxError(`Path "${userPath}" resolves outside the server directory`);
      return target;
    } catch (err) {
      if (err instanceof SandboxError) throw err;
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      const parent = path.dirname(current);
      if (parent === current || !isInside(rootReal, parent)) return target;
      current = parent;
    }
  }
}

/** Total size in bytes of everything under `dir`. Symlinks are counted, not followed. */
export async function directorySize(dir: string): Promise<number> {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop()!;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else {
        try {
          total += (await lstat(full)).size;
        } catch {
          // File vanished while walking.
        }
      }
    }
  }
  return total;
}
