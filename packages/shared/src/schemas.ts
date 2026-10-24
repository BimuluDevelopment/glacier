import { z } from 'zod';
import { POWER_ACTIONS } from './protocol';

/** Request bodies shared by the API (validation) and the web app (forms). */

export const usernameSchema = z
  .string()
  .min(3)
  .max(32)
  .regex(/^[a-zA-Z0-9_.-]+$/, 'Only letters, numbers, dots, dashes and underscores');

export const passwordSchema = z.string().min(8, 'At least 8 characters').max(256);

export const loginSchema = z.object({
  login: z.string().min(1, 'Required'),
  password: z.string().min(1, 'Required'),
});

export const registerSchema = z.object({
  email: z.email(),
  username: usernameSchema,
  password: passwordSchema,
});

export const setupSchema = registerSchema.extend({
  panelName: z.string().min(1).max(64).default('Glacier Panel'),
});

export const updateAccountSchema = z.object({
  email: z.email().optional(),
  username: usernameSchema.optional(),
  firstName: z.string().max(64).nullable().optional(),
  lastName: z.string().max(64).nullable().optional(),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: passwordSchema,
});

export const adminUserSchema = z.object({
  email: z.email(),
  username: usernameSchema,
  password: passwordSchema.optional(),
  firstName: z.string().max(64).nullable().optional(),
  lastName: z.string().max(64).nullable().optional(),
  rootAdmin: z.boolean().default(false),
});

export const locationSchema = z.object({
  short: z.string().min(1).max(32).regex(/^[a-z0-9-]+$/, 'Lowercase letters, numbers and dashes'),
  long: z.string().max(191).nullable().optional(),
});

export const nodeSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).nullable().optional(),
  locationId: z.number().int().positive(),
  fqdn: z.string().min(1).max(255),
  scheme: z.enum(['http', 'https']).default('https'),
  behindProxy: z.boolean().default(false),
  public: z.boolean().default(true),
  daemonPort: z.number().int().min(1).max(65535).default(8080),
  sftpPort: z.number().int().min(1).max(65535).default(2022),
  memory: z.number().int().min(0),
  memoryOverallocate: z.number().int().min(-1).default(0),
  disk: z.number().int().min(0),
  diskOverallocate: z.number().int().min(-1).default(0),
  uploadSize: z.number().int().min(1).max(10_240).default(100),
  dataDirectory: z.string().min(1).default('/var/lib/glacier/volumes'),
  maintenance: z.boolean().default(false),
});

export const allocationCreateSchema = z.object({
  ip: z.string().min(1),
  ipAlias: z.string().max(255).nullable().optional(),
  /** e.g. "25565, 25570-25580" */
  ports: z.string().min(1),
});

export const nestSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).nullable().optional(),
});

export const serverBuildSchema = z.object({
  memory: z.number().int().min(0),
  swap: z.number().int().min(-1).default(0),
  disk: z.number().int().min(0),
  io: z.number().int().min(10).max(1000).default(500),
  cpu: z.number().int().min(0).default(0),
  threads: z.string().regex(/^[0-9,-]*$/).nullable().optional(),
  oomKiller: z.boolean().default(true),
  databaseLimit: z.number().int().min(0).default(0),
  allocationLimit: z.number().int().min(0).default(0),
  backupLimit: z.number().int().min(0).default(0),
});

export const serverCreateSchema = serverBuildSchema.extend({
  name: z.string().min(1).max(191),
  description: z.string().max(1000).nullable().optional(),
  ownerId: z.uuid(),
  eggId: z.number().int().positive(),
  allocationId: z.number().int().positive(),
  additionalAllocationIds: z.array(z.number().int().positive()).default([]),
  image: z.string().min(1).optional(),
  startup: z.string().min(1).optional(),
  environment: z.record(z.string(), z.string()).default({}),
  startOnCompletion: z.boolean().default(true),
});

export const powerSchema = z.object({ signal: z.enum(POWER_ACTIONS as [string, ...string[]]) });
export const commandSchema = z.object({ command: z.string().min(1).max(4096) });

export type LoginInput = z.infer<typeof loginSchema>;
export type RegisterInput = z.infer<typeof registerSchema>;
export type SetupInput = z.input<typeof setupSchema>;
export type NodeInput = z.input<typeof nodeSchema>;
export type ServerCreateInput = z.input<typeof serverCreateSchema>;
