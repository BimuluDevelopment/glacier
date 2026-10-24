import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import YAML, { isMap, isSeq, type Document } from 'yaml';
import type { ConfigFile, ConfigFileReplacement } from '@glacier/shared';
import type { DaemonConfig } from '../config';
import { resolveSafe } from '../fs/sandbox';

/**
 * Applies an egg's config-file replacements before each start, e.g. forcing `server-port` in
 * server.properties to the server's allocation so users cannot bind ports they do not own.
 */

export function resolveDaemonTemplates(value: string, config: DaemonConfig): string {
  return value.replace(/\{\{\s*config\.([a-zA-Z0-9_.]+)\s*\}\}/g, (whole, key: string) => {
    if (key === 'docker.interface' || key === 'docker.network.interface') return config.docker.network.interface;
    if (key === 'system.timezone') return config.system.timezone;
    return whole;
  });
}

/** "true" -> true, "25565" -> 25565, anything else stays a string. Mirrors how eggs expect types. */
export function coerceScalar(value: string): string | number | boolean {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?(0|[1-9]\d*)(\.\d+)?$/.test(value) && value.length < 16) return Number(value);
  return value;
}

export function applyProperties(text: string, replace: ConfigFileReplacement[]): string {
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  for (const { match, replaceWith } of replace) {
    const index = lines.findIndex((line) => {
      const trimmed = line.trimStart();
      if (trimmed.startsWith('#') || trimmed.startsWith('!')) return false;
      const key = trimmed.split(/[=:]/, 1)[0]!.trim();
      return key === match;
    });
    const line = `${match}=${replaceWith}`;
    if (index === -1) lines.push(line);
    else lines[index] = line;
  }
  return lines.join('\n') + '\n';
}

export function applyIni(text: string, replace: ConfigFileReplacement[]): string {
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  for (const { match, replaceWith } of replace) {
    const dot = match.indexOf('.');
    const section = dot === -1 ? null : match.slice(0, dot);
    const key = dot === -1 ? match : match.slice(dot + 1);

    let inSection = section === null;
    let sectionEnd = section === null ? -1 : -2;
    let replaced = false;
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i]!.trim();
      const header = /^\[(.+)\]$/.exec(trimmed);
      if (header) {
        if (inSection && section !== null) {
          sectionEnd = i;
          break;
        }
        inSection = header[1] === section;
        if (section === null) break;
        continue;
      }
      if (inSection && !trimmed.startsWith(';') && !trimmed.startsWith('#') && trimmed.split('=', 1)[0]!.trim() === key) {
        lines[i] = `${key}=${replaceWith}`;
        replaced = true;
        break;
      }
    }
    if (replaced) continue;
    if (section === null) {
      const firstHeader = lines.findIndex((l) => /^\s*\[.+\]\s*$/.test(l));
      lines.splice(firstHeader === -1 ? lines.length : firstHeader, 0, `${key}=${replaceWith}`);
    } else if (sectionEnd >= 0) {
      lines.splice(sectionEnd, 0, `${key}=${replaceWith}`);
    } else if (inSection) {
      lines.push(`${key}=${replaceWith}`);
    } else {
      lines.push(`[${section}]`, `${key}=${replaceWith}`);
    }
  }
  return lines.join('\n') + '\n';
}

/** Replace whole lines starting with `match`. Lines that do not exist are not added. */
export function applyFile(text: string, replace: ConfigFileReplacement[]): string {
  return text
    .split('\n')
    .map((line) => {
      const hit = replace.find((r) => line.replace(/\r$/, '').startsWith(r.match));
      return hit ? hit.replaceWith : line;
    })
    .join('\n');
}

/** Split "servers.*.address" or "listeners[0].host" into path segments. */
export function parsePath(match: string): (string | number)[] {
  const segments: (string | number)[] = [];
  for (const part of match.split('.')) {
    const re = /([^[\]]+)|\[(\d+|\*)\]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(part))) {
      if (m[1] !== undefined) segments.push(m[1]);
      else segments.push(m[2] === '*' ? '*' : Number(m[2]));
    }
  }
  return segments;
}

/** Expand `*` segments against the actual data so we know every concrete path to set. */
function expandPaths(data: unknown, segments: (string | number)[]): (string | number)[][] {
  const star = segments.indexOf('*');
  if (star === -1) return [segments];
  const prefix = segments.slice(0, star);
  let node: any = data;
  for (const s of prefix) node = node?.[s as any];
  if (node == null || typeof node !== 'object') return [];
  const keys = Array.isArray(node) ? node.map((_, i) => i) : Object.keys(node);
  return keys.flatMap((k) => expandPaths(data, [...prefix, k, ...segments.slice(star + 1)]));
}

function setIn(target: any, segments: (string | number)[], value: unknown) {
  let node = target;
  for (let i = 0; i < segments.length - 1; i++) {
    const s = segments[i]!;
    if (node[s] == null || typeof node[s] !== 'object') node[s] = typeof segments[i + 1] === 'number' ? [] : {};
    node = node[s];
  }
  node[segments.at(-1)!] = value;
}

/** The value a replacement sets: its structured `value` if it has one, else the coerced string. */
function replacementValue(r: ConfigFileReplacement): unknown {
  return r.value !== undefined ? r.value : coerceScalar(r.replaceWith);
}

export function applyJson(text: string, replace: ConfigFileReplacement[]): string {
  const data = text.trim() ? JSON.parse(text) : {};
  for (const r of replace) {
    for (const p of expandPaths(data, parsePath(r.match))) setIn(data, p, replacementValue(r));
  }
  return JSON.stringify(data, null, 2) + '\n';
}

export function applyYaml(text: string, replace: ConfigFileReplacement[]): string {
  // Edit the document in place so comments and formatting survive.
  const doc: Document = text.trim() ? YAML.parseDocument(text) : new YAML.Document({});
  if (!isMap(doc.contents) && !isSeq(doc.contents)) doc.contents = doc.createNode({}) as any;
  for (const r of replace) {
    const value = replacementValue(r);
    for (const p of expandPaths(doc.toJS(), parsePath(r.match))) doc.setIn(p, value !== null && typeof value === 'object' ? doc.createNode(value) : value);
  }
  return doc.toString();
}

const BARE_TOML_KEY = /^[A-Za-z0-9_-]+$/;

function tomlKey(key: string) {
  return BARE_TOML_KEY.test(key) ? key : JSON.stringify(key);
}

/** JSON string escapes are valid TOML basic strings, and JSON-style arrays are valid TOML arrays. */
export function tomlValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(', ')}]`;
  if (value !== null && typeof value === 'object') {
    return `{ ${Object.entries(value).map(([k, v]) => `${tomlKey(k)} = ${tomlValue(v)}`).join(', ')} }`;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(String(value ?? ''));
}

/** The key a `key = value` line sets, unquoted, or null for other lines. */
function tomlLineKey(line: string): string | null {
  const m = /^\s*("(?:[^"\\]|\\.)*"|[A-Za-z0-9_.-]+)\s*=/.exec(line);
  if (!m) return null;
  return m[1]!.startsWith('"') ? (JSON.parse(m[1]!) as string) : m[1]!;
}

const tomlHeader = (line: string) => /^\s*\[/.test(line);

/**
 * Line-based TOML editing for proxy configs like velocity.toml, so comments survive. `match` is a
 * top-level key ("bind"), a key in a table ("advanced.compression-threshold"), or a table name with
 * a map value, which replaces that whole table ("servers").
 */
export function applyToml(text: string, replace: ConfigFileReplacement[]): string {
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();

  // Where a table's body starts and ends (end is exclusive). The top level is table null.
  const range = (table: string | null): [number, number] | null => {
    if (table === null) {
      const first = lines.findIndex(tomlHeader);
      return [0, first === -1 ? lines.length : first];
    }
    const header = lines.findIndex((l) => {
      const m = /^\s*\[\s*("(?:[^"\\]|\\.)*"|[^\]\s]+)\s*\]\s*(#.*)?$/.exec(l);
      return m && (m[1]!.startsWith('"') ? JSON.parse(m[1]!) : m[1]) === table;
    });
    if (header === -1) return null;
    const next = lines.findIndex((l, i) => i > header && tomlHeader(l));
    return [header + 1, next === -1 ? lines.length : next];
  };

  for (const r of replace) {
    const value = replacementValue(r);

    if (value !== null && typeof value === 'object' && !Array.isArray(value) && !r.match.includes('.')) {
      const body = Object.entries(value).map(([k, v]) => `${tomlKey(k)} = ${tomlValue(v)}`);
      const found = range(r.match);
      if (!found) {
        if (lines.length && lines.at(-1) !== '') lines.push('');
        lines.push(`[${tomlKey(r.match)}]`, ...body);
      } else {
        const [start, end] = found;
        lines.splice(start, end - start, ...body, ...(end < lines.length ? [''] : []));
      }
      continue;
    }

    const dot = r.match.indexOf('.');
    const table = dot === -1 ? null : r.match.slice(0, dot);
    const key = dot === -1 ? r.match : r.match.slice(dot + 1);
    const line = `${tomlKey(key)} = ${tomlValue(value)}`;
    const found = range(table);
    if (!found) {
      if (lines.length && lines.at(-1) !== '') lines.push('');
      lines.push(`[${tomlKey(table!)}]`, line);
      continue;
    }
    const [start, end] = found;
    const index = lines.findIndex((l, i) => i >= start && i < end && tomlLineKey(l) === key);
    if (index === -1) {
      // Add it after the table's last non-blank line.
      let at = end;
      while (at > start && lines[at - 1]!.trim() === '') at--;
      lines.splice(at, 0, line);
      continue;
    }
    // A multi-line array value continues until its closing bracket.
    let last = index;
    const rest = lines[index]!.slice(lines[index]!.indexOf('=') + 1);
    if ((rest.match(/\[/g) ?? []).length > (rest.match(/\]/g) ?? []).length) {
      while (last + 1 < end && !lines[last + 1]!.includes(']')) last++;
      if (last + 1 < end) last++;
    }
    lines.splice(index, last - index + 1, line);
  }
  return lines.join('\n') + '\n';
}

const APPLIERS = {
  properties: applyProperties,
  ini: applyIni,
  file: applyFile,
  json: applyJson,
  yaml: applyYaml,
  toml: applyToml,
} as const;

/**
 * Apply every config file for a server and return the paths that were written. Errors in one
 * file are reported and do not stop the others.
 */
export async function applyConfigFiles(
  dataDir: string,
  files: ConfigFile[],
  config: DaemonConfig,
  onError: (file: string, err: Error) => void,
): Promise<string[]> {
  const written: string[] = [];
  for (const cf of files) {
    try {
      const target = await resolveSafe(dataDir, cf.file);
      let text = '';
      try {
        text = await readFile(target, 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        // Proxies write a complete velocity.toml on first start; a partial one would confuse them.
        if (cf.parser === 'file' || cf.parser === 'toml') continue;
        await mkdir(path.dirname(target), { recursive: true });
      }
      const replace = cf.replace.map((r) => ({ ...r, replaceWith: resolveDaemonTemplates(r.replaceWith, config) }));
      const next = APPLIERS[cf.parser](text, replace);
      if (next !== text) {
        await writeFile(target, next);
        written.push(target);
      }
    } catch (err) {
      onError(cf.file, err as Error);
    }
  }
  return written;
}
