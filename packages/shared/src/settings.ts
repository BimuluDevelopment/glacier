import { z } from 'zod';
import { DEFAULT_FEATURES, FEATURE_FLAGS, type FeatureFlag } from './features';
import { isSafeHref } from './markdown';
import { EMAIL_TEMPLATES, type EmailTemplateKey } from './strings';

const hexColor = z.string().regex(/^#(?:[0-9a-fA-F]{3}){1,2}$/, 'Must be a hex color like #22c55e');
const optionalUrl = z.union([z.url(), z.literal(''), z.string().startsWith('/')]).default('');

export const themeColorsSchema = z.object({
  primary: hexColor,
  primaryForeground: hexColor,
  background: hexColor,
  surface: hexColor,
  surfaceAlt: hexColor,
  border: hexColor,
  text: hexColor,
  muted: hexColor,
  success: hexColor,
  warning: hexColor,
  danger: hexColor,
});
export type ThemeColors = z.infer<typeof themeColorsSchema>;

export const THEME_PRESETS: Record<string, { dark: ThemeColors; light: ThemeColors }> = {
  glacier: {
    dark: {
      primary: '#5ccfee',
      primaryForeground: '#03141c',
      background: '#0a1016',
      surface: '#101922',
      surfaceAlt: '#16222e',
      border: '#22323f',
      text: '#e4f1f8',
      muted: '#8aa1b1',
      success: '#22c55e',
      warning: '#f59e0b',
      danger: '#ef4444',
    },
    light: {
      primary: '#0284c7',
      primaryForeground: '#ffffff',
      background: '#f4f8fb',
      surface: '#ffffff',
      surfaceAlt: '#eaf2f8',
      border: '#d3e1eb',
      text: '#0c1a24',
      muted: '#566c7c',
      success: '#16a34a',
      warning: '#d97706',
      danger: '#dc2626',
    },
  },
  midnight: {
    dark: {
      primary: '#818cf8',
      primaryForeground: '#0b0b1a',
      background: '#0a0b14',
      surface: '#11131f',
      surfaceAlt: '#171a2a',
      border: '#252a40',
      text: '#e7e9f6',
      muted: '#8d92ad',
      success: '#22c55e',
      warning: '#f59e0b',
      danger: '#f43f5e',
    },
    light: {
      primary: '#4f46e5',
      primaryForeground: '#ffffff',
      background: '#f5f6fb',
      surface: '#ffffff',
      surfaceAlt: '#eceef7',
      border: '#d8dbea',
      text: '#111327',
      muted: '#5c6180',
      success: '#16a34a',
      warning: '#d97706',
      danger: '#e11d48',
    },
  },
  ember: {
    dark: {
      primary: '#fb923c',
      primaryForeground: '#1a0d04',
      background: '#100c0a',
      surface: '#181210',
      surfaceAlt: '#211915',
      border: '#33261f',
      text: '#f4ebe6',
      muted: '#a2918a',
      success: '#22c55e',
      warning: '#facc15',
      danger: '#ef4444',
    },
    light: {
      primary: '#ea580c',
      primaryForeground: '#ffffff',
      background: '#fbf7f5',
      surface: '#ffffff',
      surfaceAlt: '#f5ede8',
      border: '#e8dad2',
      text: '#1f130d',
      muted: '#6f5d54',
      success: '#16a34a',
      warning: '#ca8a04',
      danger: '#dc2626',
    },
  },
};

const safeHref = z.string().trim().max(500).refine(isSafeHref, 'Links must be http(s), mailto, # or a path like /login');
const link = z.object({ text: z.string().trim().max(60), href: safeHref });
const blockId = z.string().min(1).max(40);
const text = (max: number) => z.string().max(max).default('');

/** Lucide icon names the landing page and navigation can use. */
export const LANDING_ICONS = [
  'zap', 'shield', 'cpu', 'globe', 'clock', 'headphones', 'database', 'server', 'sparkles', 'gauge', 'lock', 'cloud',
  'rocket', 'heart', 'star', 'users', 'gamepad', 'wrench', 'hard-drive', 'activity', 'message', 'book', 'home', 'link',
] as const;
const icon = z.enum(LANDING_ICONS);

export const landingBlockSchema = z.discriminatedUnion('type', [
  z.object({
    id: blockId,
    type: z.literal('hero'),
    eyebrow: text(60),
    title: z.string().max(140).default('Game servers, minus the hassle'),
    subtitle: text(400),
    primary: link.optional(),
    secondary: link.optional(),
    imageUrl: optionalUrl,
    align: z.enum(['left', 'center']).default('center'),
  }),
  z.object({
    id: blockId,
    type: z.literal('features'),
    title: text(140),
    subtitle: text(400),
    columns: z.union([z.literal(2), z.literal(3), z.literal(4)]).default(3),
    items: z.array(z.object({ icon: icon.default('zap'), title: z.string().max(80), text: z.string().max(400) })).max(12).default([]),
  }),
  z.object({
    id: blockId,
    type: z.literal('pricing'),
    title: text(140),
    subtitle: text(400),
    plans: z
      .array(
        z.object({
          name: z.string().max(60),
          price: z.string().max(30),
          period: text(30),
          description: text(200),
          features: z.array(z.string().max(120)).max(15).default([]),
          cta: link.optional(),
          highlighted: z.boolean().default(false),
        }),
      )
      .max(6)
      .default([]),
  }),
  z.object({
    id: blockId,
    type: z.literal('stats'),
    items: z.array(z.object({ value: z.string().max(30), label: z.string().max(60) })).max(6).default([]),
  }),
  z.object({
    id: blockId,
    type: z.literal('faq'),
    title: text(140),
    items: z.array(z.object({ question: z.string().max(200), answer: z.string().max(2000) })).max(30).default([]),
  }),
  z.object({
    id: blockId,
    type: z.literal('cta'),
    title: z.string().max(140).default(''),
    text: text(400),
    button: link.optional(),
  }),
  z.object({ id: blockId, type: z.literal('text'), title: text(140), body: text(20_000) }),
  z.object({ id: blockId, type: z.literal('image'), url: optionalUrl, alt: text(200), caption: text(200) }),
]);

export type LandingBlock = z.infer<typeof landingBlockSchema>;
export type LandingBlockType = LandingBlock['type'];

const DEFAULT_LANDING: LandingBlock[] = [
  {
    id: 'hero',
    type: 'hero',
    eyebrow: 'Our game servers',
    title: 'Welcome to our servers',
    subtitle: 'The game servers we run for our friends and community. Sign in to start, stop and manage the servers you have access to.',
    primary: { text: 'Sign in', href: '/login' },
    imageUrl: '',
    align: 'center',
  },
  {
    id: 'features',
    type: 'features',
    title: 'What you can do',
    subtitle: '',
    columns: 3,
    items: [
      { icon: 'activity', title: 'Live console', text: 'Start, stop and talk to your server from the browser.' },
      { icon: 'hard-drive', title: 'Files & SFTP', text: 'Edit configs, upload mods and plugins, or connect with any SFTP client.' },
      { icon: 'database', title: 'Backups & schedules', text: 'Back up worlds and automate restarts on a timer.' },
    ],
  },
  {
    id: 'cta',
    type: 'cta',
    title: 'Ready to play?',
    text: 'Ask an admin for an account, then sign in to see your servers.',
    button: { text: 'Sign in', href: '/login' },
  },
];

const navItemSchema = z.object({
  id: blockId,
  label: z.string().trim().min(1).max(40),
  href: safeHref,
  icon: icon.optional(),
  location: z.enum(['header', 'footer']).default('header'),
  visibility: z.enum(['everyone', 'guests', 'users', 'admins']).default('everyone'),
  newTab: z.boolean().default(false),
});

export type NavItem = z.infer<typeof navItemSchema>;

const emailTemplateSchema = (key: EmailTemplateKey) =>
  z
    .object({
      enabled: z.boolean().default(true),
      subject: z.string().trim().min(1).max(200).default(EMAIL_TEMPLATES[key].subject),
      body: z.string().max(20_000).default(EMAIL_TEMPLATES[key].body),
    })
    .prefault({});

/**
 * Every admin-editable setting lives in one of these sections. Each section is stored as a single
 * JSON row in the `Setting` table and merged over its defaults when read, so adding a new field
 * never needs a migration.
 */
export const settingsSections = {
  branding: z.object({
    name: z.string().min(1).max(64).default('Glacier Panel'),
    tagline: z.string().max(160).default('Game servers, minus the hassle.'),
    logoUrl: optionalUrl,
    faviconUrl: optionalUrl,
    loginBackgroundUrl: optionalUrl,
    footerText: z.string().max(300).default(''),
    supportUrl: optionalUrl,
    /** "split" puts the form next to a big brand panel with the background image. */
    loginLayout: z.enum(['centered', 'split']).default('centered'),
    loginHeadline: z.string().max(120).default(''),
  }),
  theme: z.object({
    preset: z.string().default('glacier'),
    defaultMode: z.enum(['dark', 'light', 'system']).default('dark'),
    allowUserToggle: z.boolean().default(true),
    dark: themeColorsSchema.default(THEME_PRESETS.glacier!.dark),
    light: themeColorsSchema.default(THEME_PRESETS.glacier!.light),
    radius: z.number().min(0).max(24).default(10),
    fontFamily: z.string().max(120).default('Inter'),
    monoFontFamily: z.string().max(120).default('JetBrains Mono'),
    density: z.enum(['comfortable', 'compact']).default('comfortable'),
  }),
  customCode: z.object({
    css: z.string().max(100_000).default(''),
    headHtml: z.string().max(50_000).default(''),
  }),
  features: z
    .object(
      Object.fromEntries(Object.keys(FEATURE_FLAGS).map((k) => [k, z.boolean()])) as Record<
        FeatureFlag,
        z.ZodBoolean
      >,
    )
    .partial()
    .transform((value) => ({ ...DEFAULT_FEATURES, ...value })),
  auth: z.object({
    require2fa: z.enum(['none', 'admins', 'everyone']).default('none'),
    /** IPs or CIDR ranges allowed into the admin area and admin API. Empty = anywhere. */
    adminIpAllowlist: z
      .array(z.string().trim().regex(/^[0-9a-fA-F:.]+(\/\d{1,3})?$/, 'Use an IP like 203.0.113.5 or a range like 10.0.0.0/8'))
      .max(50)
      .default([]),
    sessionDays: z.number().int().min(1).max(365).default(30),
    loginMessage: z.string().max(500).default(''),
  }),
  general: z.object({
    maintenanceMode: z.boolean().default(false),
    maintenanceMessage: z.string().max(500).default('We are performing maintenance. Back soon!'),
    defaultLanguage: z.string().default('en'),
    /** IANA timezone schedules run in, e.g. "Europe/Amsterdam". */
    timezone: z
      .string()
      .default('UTC')
      .refine((tz) => {
        try {
          new Intl.DateTimeFormat('en-US', { timeZone: tz });
          return true;
        } catch {
          return false;
        }
      }, 'Unknown timezone'),
  }),
  landing: z.object({
    blocks: z.array(landingBlockSchema).max(40).default(DEFAULT_LANDING),
    /** Show "Sign in" / "Dashboard" in the landing page header. */
    showAuthButtons: z.boolean().default(true),
  }),
  navigation: z.object({
    items: z.array(navItemSchema).max(40).default([]),
  }),
  emailTemplates: z.object({
    welcome: emailTemplateSchema('welcome'),
    passwordReset: emailTemplateSchema('passwordReset'),
    serverCreated: emailTemplateSchema('serverCreated'),
    subuserAdded: emailTemplateSchema('subuserAdded'),
  }),
  localization: z.object({
    /** String key -> replacement text (see DEFAULT_STRINGS). */
    overrides: z
      .record(z.string().max(80), z.string().max(500))
      .default({})
      .refine((o) => Object.keys(o).length <= 500, 'Too many overrides'),
  }),
  dashboard: z.object({
    layout: z.enum(['grid', 'list']).default('grid'),
    allowUserLayout: z.boolean().default(true),
    showResources: z.boolean().default(true),
    showNode: z.boolean().default(true),
    showEgg: z.boolean().default(true),
    /** Markdown banner shown above the server list. */
    banner: z.string().max(2000).default(''),
    bannerTone: z.enum(['primary', 'success', 'warning', 'danger']).default('primary'),
  }),
} as const;

export type SettingsSection = keyof typeof settingsSections;

export const OAUTH_PROVIDERS = ['discord', 'google', 'github'] as const;
export type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];

/** What an API key may do. Reads are GET requests; everything else is a write. */
export const API_KEY_SCOPES = {
  'client:read': 'View your servers, files, backups and settings',
  'client:write': 'Control your servers: power, commands, files, backups…',
  'admin:read': 'View admin data (admins only)',
  'admin:write': 'Change admin data (admins only)',
} as const;
export type ApiKeyScope = keyof typeof API_KEY_SCOPES;

/** Suggested webhook event patterns (any activity event name or `prefix:*` works). */
export const WEBHOOK_EVENT_PRESETS = [
  { pattern: '*', label: 'Everything' },
  { pattern: 'server:power.*', label: 'Server start/stop/restart/kill' },
  { pattern: 'server:install.*', label: 'Installs finished or failed' },
  { pattern: 'server:backup.*', label: 'Backups' },
  { pattern: 'server:schedule.run', label: 'Schedule runs' },
  { pattern: 'server:sftp.login.failed', label: 'Failed SFTP logins' },
  { pattern: 'auth:login.failed', label: 'Failed panel sign-ins' },
  { pattern: 'auth:*', label: 'All sign-in activity' },
  { pattern: 'admin:*', label: 'All admin changes' },
] as const;
export type Settings = { [K in SettingsSection]: z.output<(typeof settingsSections)[K]> };

export const SETTINGS_SECTIONS = Object.keys(settingsSections) as SettingsSection[];

export function isSettingsSection(value: string): value is SettingsSection {
  return value in settingsSections;
}

/** Merge a stored (possibly partial or outdated) section value over its defaults. */
export function parseSection<K extends SettingsSection>(section: K, stored: unknown): Settings[K] {
  const schema = settingsSections[section];
  const result = schema.safeParse(stored ?? {});
  if (result.success) return result.data as Settings[K];
  // Stored data no longer matches the schema (e.g. after an upgrade): fall back to defaults
  // rather than breaking the panel.
  return schema.parse({}) as Settings[K];
}

export function defaultSettings(): Settings {
  return Object.fromEntries(SETTINGS_SECTIONS.map((s) => [s, parseSection(s, {})])) as Settings;
}

/** The subset of settings anyone (including logged-out visitors) may read. */
export interface PublicBranding {
  branding: Settings['branding'];
  theme: Settings['theme'];
  customCode: Settings['customCode'];
  features: Settings['features'];
  auth: Pick<Settings['auth'], 'loginMessage'>;
  general: Pick<Settings['general'], 'maintenanceMode' | 'maintenanceMessage'>;
  landing: Settings['landing'];
  navigation: Settings['navigation'];
  localization: Settings['localization'];
  dashboard: Settings['dashboard'];
  /** Published custom pages that should be linked from the footer. */
  footerPages: { slug: string; title: string }[];
  /** Whether outgoing email works, so "Forgot password?" can be offered. */
  mailEnabled: boolean;
  /** Social login providers that are switched on and configured. */
  oauthProviders: OAuthProvider[];
  needsSetup: boolean;
  version: string;
}
