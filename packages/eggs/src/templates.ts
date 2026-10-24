import type { ConfigFile, ConfigFileParser } from '@glacier/shared';
import type { EggConfigFile } from './egg';

export interface TemplateContext {
  ip: string;
  port: number;
  memory: number;
  env: Record<string, string>;
}

const SUPPORTED_PARSERS: ConfigFileParser[] = ['properties', 'json', 'yaml', 'ini', 'file'];

/**
 * Resolve the `{{...}}` placeholders Pterodactyl eggs use inside config file replacements.
 * `{{config.*}}` placeholders refer to daemon configuration and are left for the daemon.
 */
export function resolveTemplate(value: string, ctx: TemplateContext): string {
  return value.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (whole, key: string) => {
    switch (key) {
      case 'server.build.default.ip':
      case 'server.allocations.default.ip':
        return ctx.ip;
      case 'server.build.default.port':
      case 'server.allocations.default.port':
        return String(ctx.port);
      case 'server.build.memory':
        return String(ctx.memory);
    }
    const env = /^(?:server\.build\.)?env\.([A-Za-z0-9_]+)$/.exec(key);
    if (env) return ctx.env[env[1]!] ?? '';
    return whole;
  });
}

/** Convert an egg's `config.files` block into the replacement list sent to the daemon. */
export function buildConfigFiles(files: Record<string, EggConfigFile>, ctx: TemplateContext): ConfigFile[] {
  const out: ConfigFile[] = [];
  for (const [file, def] of Object.entries(files)) {
    const parser = (SUPPORTED_PARSERS as string[]).includes(def.parser) ? (def.parser as ConfigFileParser) : null;
    if (!parser) continue;
    out.push({
      file,
      parser,
      replace: Object.entries(def.find).map(([match, raw]) => ({
        match,
        replaceWith: resolveTemplate(typeof raw === 'string' ? raw : JSON.stringify(raw), ctx),
      })),
    });
  }
  return out;
}

/**
 * Validate a startup variable against its Laravel-style rule string (the format eggs use),
 * e.g. "required|string|max:20" or "nullable|in:true,false". Returns an error message or null.
 */
export function validateVariable(value: string, rules: string, label = 'This value'): string | null {
  const list = rules
    .split('|')
    .map((r) => r.trim())
    .filter(Boolean);
  const nullable = list.includes('nullable');
  const required = list.includes('required');
  if (value === '') {
    if (required) return `${label} is required`;
    if (nullable || !required) return null;
  }
  const numeric = list.includes('integer') || list.includes('numeric');

  for (const rule of list) {
    const [name, arg = ''] = splitOnce(rule, ':');
    switch (name) {
      case 'integer':
        if (!/^-?\d+$/.test(value)) return `${label} must be a whole number`;
        break;
      case 'numeric':
        if (value.trim() === '' || Number.isNaN(Number(value))) return `${label} must be a number`;
        break;
      case 'boolean':
        if (!['true', 'false', '1', '0'].includes(value)) return `${label} must be true or false`;
        break;
      case 'alpha_dash':
        if (!/^[A-Za-z0-9_-]+$/.test(value)) return `${label} may only contain letters, numbers, dashes and underscores`;
        break;
      case 'alpha_num':
        if (!/^[A-Za-z0-9]+$/.test(value)) return `${label} may only contain letters and numbers`;
        break;
      case 'url':
        if (!isUrl(value)) return `${label} must be a URL`;
        break;
      case 'in': {
        const options = arg.split(',');
        if (!options.includes(value)) return `${label} must be one of: ${options.join(', ')}`;
        break;
      }
      case 'min':
      case 'max': {
        const limit = Number(arg);
        const size = numeric ? Number(value) : value.length;
        if (name === 'min' && size < limit) return numeric ? `${label} must be at least ${limit}` : `${label} must be at least ${limit} characters`;
        if (name === 'max' && size > limit) return numeric ? `${label} must be at most ${limit}` : `${label} must be at most ${limit} characters`;
        break;
      }
      case 'between': {
        const [lo, hi] = arg.split(',').map(Number) as [number, number];
        const size = numeric ? Number(value) : value.length;
        if (size < lo || size > hi) return `${label} must be between ${lo} and ${hi}`;
        break;
      }
      case 'regex': {
        const re = parsePhpRegex(arg);
        if (re && !re.test(value)) return `${label} has an invalid format`;
        break;
      }
    }
  }
  return null;
}

function splitOnce(s: string, sep: string): [string, string?] {
  const i = s.indexOf(sep);
  return i === -1 ? [s] : [s.slice(0, i), s.slice(i + 1)];
}

function isUrl(value: string) {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

/** PHP regexes look like `/^[a-z]+$/i`; convert the common subset to a JS RegExp. */
function parsePhpRegex(source: string): RegExp | null {
  const m = /^(.)(.*)\1([a-z]*)$/s.exec(source);
  if (!m) return null;
  try {
    return new RegExp(m[2]!, m[3]!.replace(/[^gimsuy]/g, ''));
  } catch {
    return null;
  }
}
