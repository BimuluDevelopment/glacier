import { Link } from 'react-router';
import clsx from 'clsx';
import type { NavItem } from '@glacier/shared';
import { useAuth } from '../../auth/AuthProvider';
import { useTheme } from '../../theme/ThemeProvider';
import { Icon } from './icons';

/** Admin-defined navigation items for a location, filtered by who is looking. */
export function useNavItems(location: NavItem['location']) {
  const { branding } = useTheme();
  const { user } = useAuth();
  return branding.navigation.items.filter((item) => {
    if (item.location !== location) return false;
    switch (item.visibility) {
      case 'guests':
        return !user;
      case 'users':
        return Boolean(user);
      case 'admins':
        return Boolean(user?.rootAdmin);
      default:
        return true;
    }
  });
}

/** Internal paths use the router; everything else is a normal link. */
export function NavItemLink({ item, className }: { item: Pick<NavItem, 'href' | 'label' | 'icon' | 'newTab'>; className?: string }) {
  const content = (
    <>
      <Icon name={item.icon} className="size-4" />
      {item.label}
    </>
  );
  const classes = clsx('inline-flex items-center gap-2', className);
  const internal = item.href.startsWith('/') && !item.href.startsWith('//');
  if (internal && !item.newTab) {
    return (
      <Link to={item.href} className={classes}>
        {content}
      </Link>
    );
  }
  return (
    <a href={item.href} className={classes} {...(item.newTab ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>
      {content}
    </a>
  );
}

/** Footer: admin footer links, published pages and the footer text. */
export function SiteFooter({ className }: { className?: string }) {
  const { branding } = useTheme();
  const items = useNavItems('footer');
  const pages = branding.footerPages;
  return (
    <footer className={clsx('mx-auto flex w-full max-w-7xl flex-wrap items-center gap-x-5 gap-y-2 px-4 py-6 text-xs text-muted sm:px-6', className)}>
      <span>
        {branding.branding.footerText || branding.branding.name}
        {branding.version && <span className="ml-2 opacity-60">· Glacier Panel v{branding.version}</span>}
      </span>
      {(items.length > 0 || pages.length > 0) && (
        <nav className="flex flex-wrap gap-x-4 gap-y-1 sm:ml-auto">
          {items.map((item) => (
            <NavItemLink key={item.id} item={item} className="hover:text-text" />
          ))}
          {pages.map((p) => (
            <Link key={p.slug} to={`/p/${p.slug}`} className="hover:text-text">
              {p.title}
            </Link>
          ))}
        </nav>
      )}
    </footer>
  );
}
