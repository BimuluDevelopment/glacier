import { describe, expect, it } from 'vitest';
import { escapeMarkdown, isSafeHref, markdownToText, parseSection, renderMarkdown, settingsSections, translate } from './index';

describe('renderMarkdown', () => {
  it('renders the supported syntax', () => {
    const html = renderMarkdown('# Title\n\nHello **world** and *you*, run `say hi`.\nNew line\n\n- one\n- two\n\n1. first\n\n> quote\n\n---\n\n```\n<b>code</b>\n```');
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<p>Hello <strong>world</strong> and <em>you</em>, run <code>say hi</code>.<br>New line</p>');
    expect(html).toContain('<ul><li>one</li><li>two</li></ul>');
    expect(html).toContain('<ol><li>first</li></ol>');
    expect(html).toContain('<blockquote><p>quote</p></blockquote>');
    expect(html).toContain('<hr>');
    expect(html).toContain('<pre><code>&lt;b&gt;code&lt;/b&gt;</code></pre>');
  });

  it('renders safe links and images', () => {
    expect(renderMarkdown('[Docs](https://example.com/a?b=1&c=2)')).toBe(
      '<p><a href="https://example.com/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">Docs</a></p>',
    );
    expect(renderMarkdown('[Login](/login)')).toBe('<p><a href="/login">Login</a></p>');
    expect(renderMarkdown('![Logo](https://cdn.example.com/x.png)')).toBe('<p><img src="https://cdn.example.com/x.png" alt="Logo"></p>');
  });

  it('never emits raw HTML or dangerous URLs', () => {
    const attacks = [
      '<script>alert(1)</script>',
      '<img src=x onerror=alert(1)>',
      '[x](javascript:alert(1))',
      '[x](JaVaScRiPt:alert(1))',
      '[x](java\tscript:alert(1))',
      '[x](data:text/html;base64,PHNjcmlwdD4=)',
      '![x](javascript:alert(1))',
      '[x](https://ok.com"onmouseover="alert(1))',
      '**<svg onload=alert(1)>**',
    ];
    const allowedTags = new Set(['p', 'br', 'strong', 'em', 'code', 'pre', 'a', 'img', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'hr']);
    const allowedAttrs = new Set(['href', 'src', 'alt', 'target', 'rel']);
    for (const attack of attacks) {
      const html = renderMarkdown(attack);
      // Every real tag is on the allow-list and only carries allow-listed, quoted attributes.
      for (const [, tag, attrs] of html.matchAll(/<\/?([a-z0-9]+)([^>]*)>/gi)) {
        expect(allowedTags.has(tag!.toLowerCase()), `${attack} -> ${html}`).toBe(true);
        for (const [, name] of attrs!.matchAll(/\s([a-z-]+)=/gi)) expect(allowedAttrs.has(name!.toLowerCase()), `${attack} -> ${html}`).toBe(true);
      }
      expect(html).not.toMatch(/(href|src)="\s*(javascript|data|vbscript)/i);
    }
  });

  it('treats escaped and substituted values literally', () => {
    const name = '**[evil](https://x.com)**';
    expect(renderMarkdown(`Hi ${escapeMarkdown(name)}`)).toBe('<p>Hi **[evil](https://x.com)**</p>');
  });

  it('produces readable plain text', () => {
    expect(markdownToText('# Hi\n\n**Bold** [link](https://x.com)')).toBe('Hi\n\nBold link (https://x.com)');
  });
});

describe('isSafeHref', () => {
  it('allows web, mail, anchors and paths only', () => {
    for (const ok of ['https://a.com', 'http://a.com', 'mailto:a@b.c', '/login', '#pricing', 'docs/page']) expect(isSafeHref(ok)).toBe(true);
    for (const bad of ['javascript:alert(1)', ' javascript:x', 'vbscript:x', 'data:text/html,x', 'file:///etc/passwd', '']) expect(isSafeHref(bad)).toBe(false);
  });
});

describe('M4 settings', () => {
  it('ships a default landing page and email templates', () => {
    const landing = parseSection('landing', {});
    expect(landing.blocks.map((b) => b.type)).toEqual(['hero', 'features', 'cta']);
    const templates = parseSection('emailTemplates', { passwordReset: { subject: 'Custom' } });
    expect(templates.passwordReset.subject).toBe('Custom');
    expect(templates.passwordReset.body).toContain('{{resetUrl}}');
    expect(templates.welcome.enabled).toBe(true);
  });

  it('rejects unsafe links in landing blocks and navigation', () => {
    const bad = settingsSections.landing.safeParse({ blocks: [{ id: 'a', type: 'cta', title: 'x', button: { text: 'go', href: 'javascript:alert(1)' } }] });
    expect(bad.success).toBe(false);
    const nav = settingsSections.navigation.safeParse({ items: [{ id: 'n', label: 'Status', href: 'https://status.example.com', location: 'footer' }] });
    expect(nav.success).toBe(true);
  });

  it('translates with overrides and placeholders', () => {
    expect(translate('dashboard.welcome', {}, { name: 'Ada' })).toBe('Welcome back, Ada.');
    expect(translate('nav.servers', { 'nav.servers': 'Instances' })).toBe('Instances');
  });
});
