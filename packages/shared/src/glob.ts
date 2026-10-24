/**
 * Minimal gitignore-style matching used for egg file denylists and backup ignore lists.
 *
 * - `*` matches within one path segment, `**` across segments, `?` one character.
 * - A pattern without a slash matches the basename anywhere (`*.log`, `server.jar`).
 * - A leading `/` or any inner slash anchors the pattern to the server root (`/plugins/*.jar`).
 * - A trailing `/` only matches directories and everything inside them (`cache/`).
 * - A leading `!` re-includes a previously matched path.
 * Paths are server-relative with forward slashes and no leading slash.
 */
export function globToRegExp(pattern: string): RegExp {
  let p = pattern.trim();
  const dirOnly = p.endsWith('/');
  if (dirOnly) p = p.slice(0, -1);
  const anchored = p.startsWith('/') || p.includes('/');
  p = p.replace(/^\/+/, '');

  let re = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i]!;
    if (c === '*') {
      if (p[i + 1] === '*') {
        // "**/" matches zero or more directories; a trailing "**" matches everything.
        if (p[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }

  const prefix = anchored ? '^' : '^(?:.*/)?';
  // Matching a directory also matches everything below it.
  const suffix = dirOnly ? '/.*$' : '(?:/.*)?$';
  return new RegExp(prefix + re + suffix);
}

export class PathMatcher {
  private readonly rules: { re: RegExp; negate: boolean }[];

  constructor(patterns: readonly string[]) {
    this.rules = patterns
      .map((p) => p.trim())
      .filter((p) => p && !p.startsWith('#'))
      .map((p) => (p.startsWith('!') ? { re: globToRegExp(p.slice(1)), negate: true } : { re: globToRegExp(p), negate: false }));
  }

  get empty() {
    return this.rules.length === 0;
  }

  /**
   * `relative` is server-relative; a leading slash and backslashes are tolerated. Pass
   * `isDirectory` so directory-only patterns (`cache/`) match the directory itself.
   */
  matches(relative: string, isDirectory = false): boolean {
    const path = relative.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
    if (!path) return false;
    const candidates = isDirectory ? [path, `${path}/`] : [path];
    let matched = false;
    for (const rule of this.rules) {
      if (candidates.some((c) => rule.re.test(c))) matched = !rule.negate;
    }
    return matched;
  }
}
