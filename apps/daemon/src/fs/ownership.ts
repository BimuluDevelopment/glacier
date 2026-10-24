import { chown, lchown, readdir } from 'node:fs/promises';
import path from 'node:path';

/** chown is meaningless on Windows (dev only) and impossible without root. */
const canChown = process.platform !== 'win32' && process.getuid?.() === 0;

export async function chownPath(target: string, uid: number, gid: number) {
  if (!canChown) return;
  await lchown(target, uid, gid).catch(() => undefined);
}

/** Give the container user ownership of everything in a server directory. */
export async function chownRecursive(dir: string, uid: number, gid: number) {
  if (!canChown) return;
  await chown(dir, uid, gid);
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop()!;
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      await lchown(full, uid, gid).catch(() => undefined);
      if (entry.isDirectory()) stack.push(full);
    }
  }
}
