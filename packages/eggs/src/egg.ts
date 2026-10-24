import { z } from 'zod';

/**
 * Pterodactyl egg (PTDL_v1 / PTDL_v2) support. Eggs exported from Pterodactyl import as-is, and
 * Glacier Panel eggs export back to PTDL_v2 so they work in either panel.
 */

/** Pterodactyl stores several config blocks as JSON-encoded strings; accept either form. */
const jsonish = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    try {
      return JSON.parse(trimmed);
    } catch {
      return value;
    }
  }, schema);

const boolish = z.union([z.boolean(), z.number(), z.string()]).transform((v) => v === true || v === 1 || v === '1' || v === 'true');

const findValue = z.union([z.string(), z.number(), z.boolean(), z.record(z.string(), z.unknown())]);

const configFileSchema = z.object({
  parser: z.string().default('file'),
  find: z.record(z.string(), findValue).default({}),
});

const ptdlVariableSchema = z.object({
  name: z.string().min(1),
  description: z.string().nullable().default(''),
  env_variable: z.string().regex(/^[A-Z0-9_]+$/i, 'Environment variable names may only contain letters, numbers and _'),
  default_value: z.union([z.string(), z.number(), z.null()]).transform((v) => (v == null ? '' : String(v))).default(''),
  user_viewable: boolish.default(true),
  user_editable: boolish.default(true),
  rules: z.union([z.string(), z.array(z.string())]).transform((v) => (Array.isArray(v) ? v.join('|') : v)).default('nullable|string'),
  field_type: z.string().optional(),
});

export const ptdlEggSchema = z.object({
  meta: z.object({ version: z.enum(['PTDL_v1', 'PTDL_v2']) }).loose(),
  uuid: z.string().optional(),
  name: z.string().min(1),
  author: z.string().default('unknown@unknown'),
  description: z.string().nullable().default(''),
  features: z.array(z.string()).nullable().default([]),
  docker_images: z.record(z.string(), z.string()).optional(),
  image: z.string().optional(),
  file_denylist: z.union([z.array(z.string()), z.string()]).transform((v) => (Array.isArray(v) ? v : v ? v.split('\n') : [])).default([]),
  startup: z.string().min(1),
  config: z.object({
    files: jsonish(z.record(z.string(), configFileSchema).nullable()).default({}),
    startup: jsonish(
      z
        .object({ done: z.union([z.string(), z.array(z.string())]).optional() })
        .loose()
        .nullable(),
    ).default({}),
    logs: jsonish(z.unknown()).optional(),
    stop: z.string().default('^C'),
  }),
  scripts: z.object({
    installation: z.object({
      script: z.string().default(''),
      container: z.string().default('ghcr.io/pterodactyl/installers:alpine'),
      entrypoint: z.string().default('ash'),
    }),
  }),
  variables: z.array(ptdlVariableSchema).default([]),
});

export type PtdlEgg = z.input<typeof ptdlEggSchema>;

export interface EggConfigFile {
  parser: string;
  find: Record<string, unknown>;
}

export interface EggVariableDefinition {
  name: string;
  description: string;
  envVariable: string;
  defaultValue: string;
  userViewable: boolean;
  userEditable: boolean;
  rules: string;
}

/** Normalized egg as stored by the panel. */
export interface EggDefinition {
  uuid?: string;
  name: string;
  author: string;
  description: string;
  features: string[];
  /** Label -> image. The first entry is the default. */
  dockerImages: Record<string, string>;
  fileDenylist: string[];
  startup: string;
  config: {
    files: Record<string, EggConfigFile>;
    startupDone: string[];
    stop: string;
  };
  install: { script: string; container: string; entrypoint: string };
  variables: EggVariableDefinition[];
}

export class EggParseError extends Error {
  constructor(
    message: string,
    public readonly issues: string[],
  ) {
    super(message);
  }
}

export function parseEgg(input: unknown): EggDefinition {
  const raw = typeof input === 'string' ? safeJson(input) : input;
  const result = ptdlEggSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new EggParseError('This is not a valid Pterodactyl/Glacier Panel egg', issues);
  }
  const egg = result.data;

  const dockerImages = egg.docker_images && Object.keys(egg.docker_images).length > 0 ? egg.docker_images : egg.image ? { Default: egg.image } : {};
  if (Object.keys(dockerImages).length === 0) {
    throw new EggParseError('This egg does not define any Docker images', ['docker_images: missing']);
  }

  const done = egg.config.startup?.done;
  const envNames = new Set<string>();
  for (const v of egg.variables) {
    if (envNames.has(v.env_variable)) throw new EggParseError('Duplicate variable', [`variables: ${v.env_variable} appears twice`]);
    envNames.add(v.env_variable);
  }

  return {
    uuid: egg.uuid,
    name: egg.name,
    author: egg.author,
    description: egg.description ?? '',
    features: egg.features ?? [],
    dockerImages,
    fileDenylist: egg.file_denylist.map((l) => l.trim()).filter(Boolean),
    startup: egg.startup,
    config: {
      files: egg.config.files ?? {},
      startupDone: done == null ? [] : Array.isArray(done) ? done : [done],
      stop: egg.config.stop,
    },
    install: {
      script: egg.scripts.installation.script.replace(/\r\n/g, '\n'),
      container: egg.scripts.installation.container,
      entrypoint: egg.scripts.installation.entrypoint,
    },
    variables: egg.variables.map((v) => ({
      name: v.name,
      description: v.description ?? '',
      envVariable: v.env_variable,
      defaultValue: v.default_value,
      userViewable: v.user_viewable,
      userEditable: v.user_editable,
      rules: v.rules,
    })),
  };
}

/** Export to PTDL_v2, the format Pterodactyl's "Import Egg" understands. */
export function toPtdl(egg: EggDefinition): Record<string, unknown> {
  return {
    _comment: 'DO NOT EDIT: FILE GENERATED AUTOMATICALLY BY GLACIER PANEL',
    meta: { version: 'PTDL_v2', update_url: null },
    exported_at: new Date().toISOString(),
    ...(egg.uuid ? { uuid: egg.uuid } : {}),
    name: egg.name,
    author: egg.author,
    description: egg.description,
    features: egg.features,
    docker_images: egg.dockerImages,
    file_denylist: egg.fileDenylist,
    startup: egg.startup,
    config: {
      files: JSON.stringify(egg.config.files, null, 4),
      startup: JSON.stringify({ done: egg.config.startupDone.length === 1 ? egg.config.startupDone[0] : egg.config.startupDone }, null, 4),
      logs: '{}',
      stop: egg.config.stop,
    },
    scripts: {
      installation: { script: egg.install.script, container: egg.install.container, entrypoint: egg.install.entrypoint },
    },
    variables: egg.variables.map((v) => ({
      name: v.name,
      description: v.description,
      env_variable: v.envVariable,
      default_value: v.defaultValue,
      user_viewable: v.userViewable,
      user_editable: v.userEditable,
      rules: v.rules,
      field_type: 'text',
    })),
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new EggParseError('The egg file is not valid JSON', ['(root): invalid JSON']);
  }
}
