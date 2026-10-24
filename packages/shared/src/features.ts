/**
 * Panel modules an administrator can switch on or off. Disabled modules are hidden in the UI and
 * their API routes respond with 404. `ready: false` marks modules on the roadmap that are not
 * built yet; the admin UI shows them as upcoming instead of offering a switch that does nothing.
 */
export const FEATURE_FLAGS = {
  registration: { label: 'Public registration', description: 'Let visitors create their own accounts.', default: false, ready: true },
  landingPage: { label: 'Landing page', description: 'Show the customizable landing page to visitors at /.', default: false, ready: true },
  announcements: { label: 'Announcements', description: 'Show admin announcements on the dashboard.', default: true, ready: true },
  plugins: { label: 'Plugin & mod installer', description: 'Browse and install from Modrinth, Hangar and CurseForge.', default: true, ready: true },
  subdomains: { label: 'Subdomains', description: 'Let users attach Cloudflare subdomains to servers (configure under Settings).', default: false, ready: true },
  networks: { label: 'Proxy networks', description: 'Velocity, BungeeCord and Waterfall servers get a Proxy tab for adding and linking backend servers.', default: true, ready: true },
  passkeys: { label: 'Passkeys', description: 'Sign in with Face ID, Windows Hello, a phone or a security key.', default: true, ready: true },
  oauth: { label: 'Social login', description: 'Discord, Google and GitHub sign-in (configure under Security).', default: false, ready: true },
} as const;

export type FeatureFlag = keyof typeof FEATURE_FLAGS;

export const DEFAULT_FEATURES = Object.fromEntries(
  Object.entries(FEATURE_FLAGS).map(([key, def]) => [key, def.default]),
) as Record<FeatureFlag, boolean>;
