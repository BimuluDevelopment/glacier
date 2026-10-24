/**
 * User-facing texts admins can reword from Admin → Localization (e.g. "Servers" → "Instances",
 * or translate the panel). `{name}` placeholders are filled in at render time.
 */
export const DEFAULT_STRINGS = {
  'nav.servers': 'Servers',
  'nav.account': 'Account',
  'nav.admin': 'Admin',
  'nav.signOut': 'Sign out',

  'auth.signIn.title': 'Sign in',
  'auth.signIn.button': 'Sign in',
  'auth.login': 'Email or username',
  'auth.password': 'Password',
  'auth.forgot': 'Forgot password?',
  'auth.newHere': 'New here?',
  'auth.createAccount': 'Create an account',
  'auth.register.title': 'Create your account',
  'auth.register.button': 'Create account',
  'auth.haveAccount': 'Already have an account?',
  'auth.forgot.title': 'Reset your password',
  'auth.forgot.description': "Enter your email and we'll send you a link to choose a new password.",
  'auth.forgot.button': 'Send reset link',
  'auth.forgot.sent': 'If an account uses that email, a reset link is on its way. It expires in one hour.',
  'auth.reset.title': 'Choose a new password',
  'auth.reset.button': 'Save new password',

  'dashboard.title': 'Your servers',
  'dashboard.welcome': 'Welcome back, {name}.',
  'dashboard.search': 'Search servers',
  'dashboard.empty': 'No servers yet',
  'dashboard.emptyHint': 'Servers you own or have been invited to will appear here.',

  'server.tab.console': 'Console',
  'server.tab.files': 'Files',
  'server.tab.databases': 'Databases',
  'server.tab.schedules': 'Schedules',
  'server.tab.users': 'Users',
  'server.tab.backups': 'Backups',
  'server.tab.network': 'Network',
  'server.tab.startup': 'Startup',
  'server.tab.settings': 'Settings',
  'server.tab.activity': 'Activity',
  'server.tab.plugins': 'Plugins & mods',
  'server.tab.players': 'Players',
  'server.tab.proxy': 'Proxy',
  'server.power.start': 'Start',
  'server.power.restart': 'Restart',
  'server.power.stop': 'Stop',
  'server.power.kill': 'Kill',
  'server.console.placeholder': 'Type a command…',
  'server.stats.uptime': 'Uptime',
  'server.stats.cpu': 'CPU',
  'server.stats.memory': 'Memory',
  'server.stats.disk': 'Disk',
  'server.stats.network': 'Network',

  'landing.signIn': 'Sign in',
  'landing.dashboard': 'Go to dashboard',
  'maintenance.title': 'Down for maintenance',
} as const;

export type StringKey = keyof typeof DEFAULT_STRINGS;

export function translate(key: StringKey, overrides: Record<string, string>, vars: Record<string, string | number> = {}): string {
  const template = overrides[key] || DEFAULT_STRINGS[key];
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => (name in vars ? String(vars[name]) : whole));
}

// --- Email templates --------------------------------------------------------------------------------

export const EMAIL_TEMPLATES = {
  welcome: {
    label: 'Welcome',
    description: 'Sent when an account is created (by sign-up or by an admin).',
    variables: ['name', 'username', 'email', 'panelName', 'panelUrl'],
    subject: 'Welcome to {{panelName}}',
    body: `# Welcome, {{name}}!

Your account on **{{panelName}}** is ready. Sign in with your username \`{{username}}\` or your email address.

[Open {{panelName}}]({{panelUrl}})`,
  },
  passwordReset: {
    label: 'Password reset',
    description: 'Sent when someone uses "Forgot password?". The link expires after one hour.',
    variables: ['name', 'panelName', 'resetUrl'],
    subject: 'Reset your {{panelName}} password',
    body: `Hi {{name}},

Someone (hopefully you) asked to reset your password. Use the link below within one hour:

[Choose a new password]({{resetUrl}})

If you didn't ask for this, you can ignore this email; your password stays the same.`,
  },
  serverCreated: {
    label: 'Server created',
    description: 'Sent to the owner when a new server is created for them.',
    variables: ['name', 'serverName', 'serverAddress', 'serverUrl', 'panelName'],
    subject: 'Your server {{serverName}} is being set up',
    body: `Hi {{name}},

Your new server **{{serverName}}** is installing now and will be reachable at \`{{serverAddress}}\` in a few minutes.

[Manage {{serverName}}]({{serverUrl}})`,
  },
  subuserAdded: {
    label: 'Added to a server',
    description: 'Sent when someone gives you access to their server.',
    variables: ['name', 'serverName', 'serverUrl', 'inviter', 'panelName'],
    subject: '{{inviter}} gave you access to {{serverName}}',
    body: `Hi {{name}},

**{{inviter}}** added you to the server **{{serverName}}** on {{panelName}}.

[Open {{serverName}}]({{serverUrl}})`,
  },
} as const;

export type EmailTemplateKey = keyof typeof EMAIL_TEMPLATES;
export const EMAIL_TEMPLATE_KEYS = Object.keys(EMAIL_TEMPLATES) as EmailTemplateKey[];
