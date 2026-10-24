import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import clsx from 'clsx';
import { Check, ChevronDown } from 'lucide-react';
import type { LandingBlock } from '@glacier/shared';
import { useAuth } from '../../auth/AuthProvider';
import { useTheme } from '../../theme/ThemeProvider';
import { Markdown, useT } from '../../theme/i18n';
import { Logo } from '../../components/layout';
import { Icon } from './icons';
import { NavItemLink, SiteFooter, useNavItems } from './nav';

type LinkSpec = { text: string; href: string };

function CtaLink({ link, variant = 'primary', className }: { link: LinkSpec; variant?: 'primary' | 'secondary'; className?: string }) {
  const classes = clsx(
    'inline-flex h-11 items-center justify-center rounded-ui px-6 text-sm font-semibold transition',
    variant === 'primary' ? 'bg-primary text-primary-foreground hover:brightness-110' : 'border border-border bg-surface text-text hover:border-muted/60',
    className,
  );
  const internal = link.href.startsWith('/') && !link.href.startsWith('//');
  return internal ? (
    <Link to={link.href} className={classes}>
      {link.text}
    </Link>
  ) : (
    <a href={link.href} className={classes}>
      {link.text}
    </a>
  );
}

function Section({ children, className, id }: { children: ReactNode; className?: string; id?: string }) {
  return (
    <section id={id} className={clsx('mx-auto w-full max-w-6xl px-4 py-16 sm:px-6 sm:py-20', className)}>
      {children}
    </section>
  );
}

function SectionHeading({ title, subtitle }: { title?: string; subtitle?: string }) {
  if (!title && !subtitle) return null;
  return (
    <div className="mx-auto mb-10 max-w-2xl text-center">
      {title && <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">{title}</h2>}
      {subtitle && <p className="mt-3 text-base text-muted">{subtitle}</p>}
    </div>
  );
}

function FaqItem({ question, answer }: { question: string; answer: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b border-border">
      <button className="flex w-full items-center justify-between gap-4 py-4 text-left font-medium" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {question}
        <ChevronDown className={clsx('size-4 shrink-0 text-muted transition', open && 'rotate-180')} />
      </button>
      {open && <Markdown source={answer} className="pb-4 text-sm text-muted" />}
    </div>
  );
}

export function BlockView({ block }: { block: LandingBlock }) {
  switch (block.type) {
    case 'hero': {
      const center = block.align === 'center';
      return (
        <Section id={block.id} className="pt-20 sm:pt-28">
          <div className={clsx('grid items-center gap-12', block.imageUrl && !center && 'lg:grid-cols-2')}>
            <div className={clsx(center && 'mx-auto max-w-3xl text-center')}>
              {block.eyebrow && (
                <span className="mb-5 inline-block rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-xs font-semibold uppercase tracking-wider text-primary">
                  {block.eyebrow}
                </span>
              )}
              <h1 className="text-4xl font-bold tracking-tight text-balance sm:text-6xl">{block.title}</h1>
              {block.subtitle && <p className="mt-5 text-lg text-muted text-pretty">{block.subtitle}</p>}
              {(block.primary || block.secondary) && (
                <div className={clsx('mt-8 flex flex-wrap gap-3', center && 'justify-center')}>
                  {block.primary?.text && <CtaLink link={block.primary} />}
                  {block.secondary?.text && <CtaLink link={block.secondary} variant="secondary" />}
                </div>
              )}
            </div>
            {block.imageUrl && (
              <img src={block.imageUrl} alt="" className={clsx('w-full rounded-ui border border-border shadow-2xl', center && 'mx-auto mt-4 max-w-4xl')} />
            )}
          </div>
        </Section>
      );
    }
    case 'features':
      return (
        <Section id={block.id}>
          <SectionHeading title={block.title} subtitle={block.subtitle} />
          <div className={clsx('grid gap-5 sm:grid-cols-2', block.columns === 3 && 'lg:grid-cols-3', block.columns === 4 && 'lg:grid-cols-4')}>
            {block.items.map((item, i) => (
              <div key={i} className="rounded-ui border border-border bg-surface p-6">
                <div className="mb-4 flex size-11 items-center justify-center rounded-ui bg-primary/12 text-primary">
                  <Icon name={item.icon} className="size-5" />
                </div>
                <h3 className="font-semibold">{item.title}</h3>
                <p className="mt-2 text-sm text-muted">{item.text}</p>
              </div>
            ))}
          </div>
        </Section>
      );
    case 'pricing':
      return (
        <Section id={block.id}>
          <SectionHeading title={block.title} subtitle={block.subtitle} />
          <div className="flex flex-wrap justify-center gap-5">
            {block.plans.map((plan, i) => (
              <div
                key={i}
                className={clsx(
                  'flex w-full max-w-xs flex-col rounded-ui border bg-surface p-6',
                  plan.highlighted ? 'border-primary shadow-xl shadow-primary/10 ring-1 ring-primary' : 'border-border',
                )}
              >
                <div className="flex items-center justify-between">
                  <h3 className="font-semibold">{plan.name}</h3>
                  {plan.highlighted && <span className="rounded-full bg-primary px-2 py-0.5 text-xs font-semibold text-primary-foreground">Popular</span>}
                </div>
                {plan.description && <p className="mt-1 text-sm text-muted">{plan.description}</p>}
                <p className="mt-5">
                  <span className="text-4xl font-bold tracking-tight">{plan.price}</span>
                  {plan.period && <span className="text-sm text-muted"> {plan.period}</span>}
                </p>
                <ul className="mt-5 flex flex-1 flex-col gap-2 text-sm">
                  {plan.features.map((f, j) => (
                    <li key={j} className="flex gap-2">
                      <Check className="mt-0.5 size-4 shrink-0 text-primary" />
                      {f}
                    </li>
                  ))}
                </ul>
                {plan.cta?.text && <CtaLink link={plan.cta} variant={plan.highlighted ? 'primary' : 'secondary'} className="mt-6 w-full" />}
              </div>
            ))}
          </div>
        </Section>
      );
    case 'stats':
      return (
        <Section id={block.id} className="py-10 sm:py-12">
          <div className="grid grid-cols-2 gap-6 rounded-ui border border-border bg-surface px-6 py-8 text-center sm:grid-cols-3 lg:grid-flow-col lg:grid-cols-none">
            {block.items.map((s, i) => (
              <div key={i}>
                <div className="text-3xl font-bold tracking-tight text-primary">{s.value}</div>
                <div className="mt-1 text-sm text-muted">{s.label}</div>
              </div>
            ))}
          </div>
        </Section>
      );
    case 'faq':
      return (
        <Section id={block.id}>
          <SectionHeading title={block.title} />
          <div className="mx-auto max-w-3xl border-t border-border">
            {block.items.map((item, i) => (
              <FaqItem key={i} question={item.question} answer={item.answer} />
            ))}
          </div>
        </Section>
      );
    case 'cta':
      return (
        <Section id={block.id}>
          <div className="rounded-ui border border-primary/30 bg-gradient-to-br from-primary/15 via-surface to-surface px-6 py-14 text-center">
            {block.title && <h2 className="text-3xl font-bold tracking-tight">{block.title}</h2>}
            {block.text && <p className="mx-auto mt-3 max-w-xl text-muted">{block.text}</p>}
            {block.button?.text && <CtaLink link={block.button} className="mt-7" />}
          </div>
        </Section>
      );
    case 'text':
      return (
        <Section id={block.id}>
          <div className="mx-auto max-w-3xl">
            {block.title && <h2 className="mb-6 text-3xl font-bold tracking-tight">{block.title}</h2>}
            <Markdown source={block.body} />
          </div>
        </Section>
      );
    case 'image':
      return block.url ? (
        <Section id={block.id} className="py-10">
          <figure>
            <img src={block.url} alt={block.alt} className="mx-auto w-full max-w-5xl rounded-ui border border-border" />
            {block.caption && <figcaption className="mt-3 text-center text-sm text-muted">{block.caption}</figcaption>}
          </figure>
        </Section>
      ) : null;
  }
}

/** Header + footer used by the landing page and public custom pages. */
export function PublicShell({ children, showAuth = true }: { children: ReactNode; showAuth?: boolean }) {
  const { user } = useAuth();
  const t = useT();
  const items = useNavItems('header');
  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-30 border-b border-border/60 bg-bg/80 backdrop-blur">
        <div className="mx-auto flex h-16 w-full max-w-6xl items-center gap-6 px-4 sm:px-6">
          <Logo />
          <nav className="hidden items-center gap-5 text-sm md:flex">
            {items.map((item) => (
              <NavItemLink key={item.id} item={item} className="text-muted hover:text-text" />
            ))}
          </nav>
          {showAuth && (
            <div className="ml-auto">
              {user ? (
                <CtaLink link={{ text: t('landing.dashboard'), href: '/' }} className="h-9 px-4" />
              ) : (
                <CtaLink link={{ text: t('landing.signIn'), href: '/login' }} variant="secondary" className="h-9 px-4" />
              )}
            </div>
          )}
        </div>
      </header>
      <main className="flex-1">{children}</main>
      <SiteFooter className="max-w-6xl border-t border-border/60" />
    </div>
  );
}

export function LandingPage({ blocks }: { blocks?: LandingBlock[] }) {
  const { branding } = useTheme();
  const list = blocks ?? branding.landing.blocks;
  return (
    <PublicShell showAuth={branding.landing.showAuthButtons}>
      {list.map((block) => (
        <BlockView key={block.id} block={block} />
      ))}
    </PublicShell>
  );
}
