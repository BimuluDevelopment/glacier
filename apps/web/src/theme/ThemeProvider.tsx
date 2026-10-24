import { createContext, useContext, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { defaultSettings, type PublicBranding, type Settings, type ThemeColors } from '@glacier/shared';
import { api } from '../lib/api';

type Mode = 'dark' | 'light';
type ModePreference = Mode | 'system';

interface ThemeContextValue {
  branding: PublicBranding;
  loading: boolean;
  mode: Mode;
  preference: ModePreference;
  setPreference: (mode: ModePreference) => void;
}

const MODE_KEY = 'glacier-theme-mode';
const defaults = defaultSettings();
const FALLBACK: PublicBranding = {
  branding: defaults.branding,
  theme: defaults.theme,
  customCode: defaults.customCode,
  features: defaults.features,
  auth: { loginMessage: '' },
  general: { maintenanceMode: false, maintenanceMessage: '' },
  landing: defaults.landing,
  navigation: defaults.navigation,
  localization: defaults.localization,
  dashboard: defaults.dashboard,
  footerPages: [],
  mailEnabled: false,
  oauthProviders: [],
  needsSetup: false,
  version: '',
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

/** CSS variables for a palette. Also used by the admin theme editor for its live preview. */
export function themeVars(colors: ThemeColors, theme: Pick<Settings['theme'], 'radius' | 'fontFamily' | 'monoFontFamily'>) {
  return {
    '--sl-primary': colors.primary,
    '--sl-primary-foreground': colors.primaryForeground,
    '--sl-background': colors.background,
    '--sl-surface': colors.surface,
    '--sl-surface-alt': colors.surfaceAlt,
    '--sl-border': colors.border,
    '--sl-text': colors.text,
    '--sl-muted': colors.muted,
    '--sl-success': colors.success,
    '--sl-warning': colors.warning,
    '--sl-danger': colors.danger,
    '--sl-radius': `${theme.radius}px`,
    '--sl-font': `'${theme.fontFamily}'`,
    '--sl-mono': `'${theme.monoFontFamily}'`,
  } as CSSProperties & Record<string, string>;
}

const SYSTEM_FONTS = new Set(['system-ui', 'sans-serif', 'serif', 'monospace', 'ui-sans-serif', 'ui-monospace']);

function loadGoogleFont(family: string, id: string) {
  if (!family || SYSTEM_FONTS.has(family)) return;
  const href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, '+')}:wght@400;500;600;700&display=swap`;
  let link = document.getElementById(id) as HTMLLinkElement | null;
  if (!link) {
    link = document.createElement('link');
    link.id = id;
    link.rel = 'stylesheet';
    document.head.appendChild(link);
  }
  if (link.href !== href) link.href = href;
}

function readPreference(): ModePreference | null {
  try {
    const v = localStorage.getItem(MODE_KEY);
    return v === 'dark' || v === 'light' || v === 'system' ? v : null;
  } catch {
    return null;
  }
}

function useSystemMode(): Mode {
  const query = '(prefers-color-scheme: light)';
  const [mode, setMode] = useState<Mode>(() => (window.matchMedia?.(query).matches ? 'light' : 'dark'));
  useEffect(() => {
    const mql = window.matchMedia?.(query);
    if (!mql) return;
    const onChange = () => setMode(mql.matches ? 'light' : 'dark');
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);
  return mode;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const { data, isLoading } = useQuery({
    queryKey: ['branding'],
    queryFn: () => api.get<PublicBranding>('/public/branding'),
    staleTime: 60_000,
  });
  const branding = data ?? FALLBACK;
  const { theme, customCode } = branding;

  const [stored, setStored] = useState<ModePreference | null>(readPreference);
  const systemMode = useSystemMode();
  const preference: ModePreference = theme.allowUserToggle && stored ? stored : theme.defaultMode;
  const mode: Mode = preference === 'system' ? systemMode : preference;

  // Colors, radius, fonts and density.
  useEffect(() => {
    const root = document.documentElement;
    for (const [k, v] of Object.entries(themeVars(theme[mode], theme))) root.style.setProperty(k, v);
    root.style.colorScheme = mode;
    root.dataset.mode = mode;
    root.dataset.density = theme.density;
    loadGoogleFont(theme.fontFamily, 'glacier-font');
    loadGoogleFont(theme.monoFontFamily, 'glacier-font-mono');
  }, [theme, mode]);

  // Title and favicon.
  useEffect(() => {
    document.title = branding.branding.name;
    const icon = document.getElementById('glacier-favicon') as HTMLLinkElement | null;
    if (icon) icon.href = branding.branding.faviconUrl || '/favicon.svg';
  }, [branding.branding.name, branding.branding.faviconUrl]);

  // Admin custom CSS.
  useEffect(() => {
    let style = document.getElementById('glacier-custom-css') as HTMLStyleElement | null;
    if (!style) {
      style = document.createElement('style');
      style.id = 'glacier-custom-css';
      document.head.appendChild(style);
    }
    style.textContent = customCode.css;
  }, [customCode.css]);

  // Admin head HTML (analytics, chat widgets, ...). Scripts are recreated so the browser runs them.
  useEffect(() => {
    if (!customCode.headHtml) return;
    const template = document.createElement('template');
    template.innerHTML = customCode.headHtml;
    const nodes: Node[] = [];
    for (const node of Array.from(template.content.childNodes)) {
      let el: Node = node;
      if (node instanceof HTMLScriptElement) {
        const script = document.createElement('script');
        for (const attr of Array.from(node.attributes)) script.setAttribute(attr.name, attr.value);
        script.textContent = node.textContent;
        el = script;
      }
      document.head.appendChild(el);
      nodes.push(el);
    }
    return () => nodes.forEach((n) => n.parentNode?.removeChild(n));
  }, [customCode.headHtml]);

  const value = useMemo<ThemeContextValue>(
    () => ({
      branding,
      loading: isLoading,
      mode,
      preference,
      setPreference: (p) => {
        setStored(p);
        try {
          localStorage.setItem(MODE_KEY, p);
        } catch {
          // Storage blocked; the choice lasts for this page view.
        }
      },
    }),
    [branding, isLoading, mode, preference],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used inside ThemeProvider');
  return ctx;
}
