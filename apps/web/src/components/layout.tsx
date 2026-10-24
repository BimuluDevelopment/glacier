import { useState, type ReactNode } from 'react';
import { Link, NavLink, Outlet } from 'react-router';
import clsx from 'clsx';
import {
  Activity,
  Boxes,
  Compass,
  Database,
  Egg,
  FileText,
  Languages,
  LayoutDashboard,
  LayoutTemplate,
  Mail,
  Megaphone,
  ShieldCheck,
  Webhook,
  LogOut,
  MapPin,
  Menu,
  Moon,
  Palette,
  Server,
  Settings,
  Shield,
  Sun,
  User,
  Users,
} from 'lucide-react';
import { useAuth } from '../auth/AuthProvider';
import { useTheme } from '../theme/ThemeProvider';
import { useT } from '../theme/i18n';
import { NavItemLink, SiteFooter, useNavItems } from '../features/landing/nav';

export function Logo({ className }: { className?: string }) {
  const { branding } = useTheme();
  return (
    <Link to="/" className={clsx('flex items-center gap-2.5 font-semibold tracking-tight', className)}>
      {branding.branding.logoUrl ? (
        <img src={branding.branding.logoUrl} alt="" className="h-8 w-auto" />
      ) : (
        <img src="/favicon.svg" alt="" className="size-8" />
      )}
      <span className="text-lg">{branding.branding.name}</span>
    </Link>
  );
}

function ModeToggle() {
  const { mode, setPreference, branding } = useTheme();
  if (!branding.theme.allowUserToggle) return null;
  return (
    <button
      className="rounded-ui p-2 text-muted hover:bg-surface-alt hover:text-text"
      onClick={() => setPreference(mode === 'dark' ? 'light' : 'dark')}
      aria-label={`Switch to ${mode === 'dark' ? 'light' : 'dark'} mode`}
      title="Toggle light/dark"
    >
      {mode === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </button>
  );
}

function TopLink({ to, icon, children, end }: { to: string; icon: ReactNode; children: ReactNode; end?: boolean }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        clsx(
          'flex items-center gap-2 rounded-ui px-3 py-2 text-sm font-medium transition',
          isActive ? 'bg-surface-alt text-text' : 'text-muted hover:text-text',
        )
      }
    >
      {icon}
      {children}
    </NavLink>
  );
}

export function AppShell() {
  const { user, logout } = useAuth();
  const t = useT();
  const extra = useNavItems('header');
  const [open, setOpen] = useState(false);
  const links = (
    <>
      <TopLink to="/" end icon={<LayoutDashboard className="size-4" />}>
        {t('nav.servers')}
      </TopLink>
      <TopLink to="/account" icon={<User className="size-4" />}>
        {t('nav.account')}
      </TopLink>
      {user?.rootAdmin && (
        <TopLink to="/admin" icon={<Shield className="size-4" />}>
          {t('nav.admin')}
        </TopLink>
      )}
      {extra.map((item) => (
        <NavItemLink key={item.id} item={item} className="rounded-ui px-3 py-2 text-sm font-medium text-muted transition hover:text-text" />
      ))}
    </>
  );

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-30 border-b border-border bg-bg/85 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-7xl items-center gap-4 px-4 sm:px-6">
          <Logo />
          <nav className="ml-6 hidden items-center gap-1 md:flex">{links}</nav>
          <div className="ml-auto flex items-center gap-1">
            <ModeToggle />
            <span className="hidden px-2 text-sm text-muted sm:inline">{user?.username}</span>
            <button className="rounded-ui p-2 text-muted hover:bg-surface-alt hover:text-text" onClick={() => void logout()} title={t('nav.signOut')} aria-label={t('nav.signOut')}>
              <LogOut className="size-4" />
            </button>
            <button className="rounded-ui p-2 text-muted md:hidden" onClick={() => setOpen((o) => !o)} aria-label="Menu">
              <Menu className="size-5" />
            </button>
          </div>
        </div>
        {open && (
          <nav className="flex flex-col gap-1 border-t border-border px-4 py-3 md:hidden" onClick={() => setOpen(false)}>
            {links}
          </nav>
        )}
      </header>
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-8 sm:px-6">
        <Outlet />
      </main>
      <SiteFooter />
    </div>
  );
}

const adminNav: { group: string; items: { to: string; label: string; icon: typeof Activity; end?: boolean }[] }[] = [
  {
    group: 'Panel',
    items: [
      { to: '/admin', label: 'Overview', icon: LayoutDashboard, end: true },
      { to: '/admin/settings', label: 'Settings', icon: Settings },
      { to: '/admin/users', label: 'Users', icon: Users },
      { to: '/admin/security', label: 'Security', icon: ShieldCheck },
      { to: '/admin/announcements', label: 'Announcements', icon: Megaphone },
      { to: '/admin/webhooks', label: 'Webhooks', icon: Webhook },
      { to: '/admin/activity', label: 'Activity', icon: Activity },
    ],
  },
  {
    group: 'Customize',
    items: [
      { to: '/admin/appearance', label: 'Appearance', icon: Palette },
      { to: '/admin/landing', label: 'Landing page', icon: LayoutTemplate },
      { to: '/admin/navigation', label: 'Navigation', icon: Compass },
      { to: '/admin/pages', label: 'Pages', icon: FileText },
      { to: '/admin/email', label: 'Email', icon: Mail },
      { to: '/admin/localization', label: 'Localization', icon: Languages },
    ],
  },
  {
    group: 'Infrastructure',
    items: [
      { to: '/admin/servers', label: 'Servers', icon: Server },
      { to: '/admin/templates', label: 'Templates', icon: LayoutTemplate },
      { to: '/admin/nodes', label: 'Nodes', icon: Boxes },
      { to: '/admin/locations', label: 'Locations', icon: MapPin },
      { to: '/admin/database-hosts', label: 'Databases', icon: Database },
      { to: '/admin/eggs', label: 'Eggs', icon: Egg },
    ],
  },
];

export function AdminShell() {
  return (
    <div className="flex flex-col gap-6 lg:flex-row">
      <aside className="lg:w-52 lg:shrink-0">
        <nav className="flex gap-1 overflow-x-auto pb-1 lg:sticky lg:top-24 lg:flex-col lg:overflow-visible">
          {adminNav.map(({ group, items }) => (
            <div key={group} className="contents lg:block lg:pb-4">
              <p className="hidden px-3 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted/70 lg:block">{group}</p>
              {items.map(({ to, label, icon: Icon, end }) => (
                <NavLink
                  key={to}
                  to={to}
                  end={end}
                  className={({ isActive }) =>
                    clsx(
                      'flex shrink-0 items-center gap-2.5 rounded-ui px-3 py-2 text-sm font-medium transition',
                      isActive ? 'bg-primary/12 text-primary' : 'text-muted hover:bg-surface-alt hover:text-text',
                    )
                  }
                >
                  <Icon className="size-4" />
                  {label}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
      </aside>
      <div className="min-w-0 flex-1">
        <Outlet />
      </div>
    </div>
  );
}

/** Centered card layout for login, register and the setup wizard. */
/** CSS background with a dark overlay. The URL is JSON-quoted so it can't break out of url(). */
function backgroundStyle(url: string, overlay: number) {
  return url ? { backgroundImage: `linear-gradient(rgba(0,0,0,${overlay}), rgba(0,0,0,${overlay})), url(${JSON.stringify(url)})` } : undefined;
}

export function AuthLayout({ children, title, subtitle }: { children: ReactNode; title: string; subtitle?: ReactNode }) {
  const { branding } = useTheme();
  const { loginBackgroundUrl: bg, loginLayout, loginHeadline, tagline } = branding.branding;
  const card = (
    <div className="rounded-ui border border-border bg-surface p-6 shadow-xl">
      <h1 className="text-lg font-semibold">{title}</h1>
      {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
      <div className="mt-5">{children}</div>
    </div>
  );

  if (loginLayout === 'split') {
    return (
      <div className="grid min-h-screen lg:grid-cols-[1.1fr_1fr]">
        <aside
          className="relative hidden flex-col justify-between overflow-hidden bg-cover bg-center p-10 text-white lg:flex"
          style={backgroundStyle(bg, 0.45) ?? { background: 'linear-gradient(135deg, var(--sl-primary), var(--sl-surface-alt))' }}
        >
          <Logo className="text-white" />
          <div className="max-w-md">
            <p className="text-4xl font-bold leading-tight tracking-tight text-balance">{loginHeadline || branding.branding.name}</p>
            {tagline && <p className="mt-4 text-lg opacity-85">{tagline}</p>}
          </div>
          <SiteFooter className="px-0 py-0 text-white/70" />
        </aside>
        <main className="flex items-center justify-center px-4 py-12">
          <div className="w-full max-w-sm">
            <div className="mb-8 lg:hidden">
              <Logo />
            </div>
            {card}
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-cover bg-center" style={backgroundStyle(bg, 0.55)}>
      <div className="flex flex-1 items-center justify-center px-4 py-12">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex flex-col items-center gap-3 text-center">
            <Logo />
            {loginHeadline && <p className="text-xl font-semibold">{loginHeadline}</p>}
            {tagline && <p className="text-sm text-muted">{tagline}</p>}
          </div>
          {card}
        </div>
      </div>
      <SiteFooter className="justify-center" />
    </div>
  );
}
