import { useCallback, useMemo } from 'react';
import clsx from 'clsx';
import { renderMarkdown, translate, type StringKey } from '@glacier/shared';
import { useTheme } from './ThemeProvider';

/** `t('dashboard.welcome', { name })`, honouring the admin's text overrides. */
export function useT() {
  const { branding } = useTheme();
  const overrides = branding.localization.overrides;
  return useCallback((key: StringKey, vars?: Record<string, string | number>) => translate(key, overrides, vars), [overrides]);
}

/**
 * Admin-written Markdown. `renderMarkdown` escapes all input HTML and only emits a fixed tag set
 * with vetted links, which is what makes dangerouslySetInnerHTML safe here.
 */
export function Markdown({ source, className }: { source: string; className?: string }) {
  const html = useMemo(() => renderMarkdown(source), [source]);
  return <div className={clsx('sl-prose', className)} dangerouslySetInnerHTML={{ __html: html }} />;
}
