/**
 * A small, safe Markdown renderer for admin-written content (custom pages, landing page text,
 * email templates). It escapes all HTML in the input and only ever emits a fixed set of tags,
 * so the output can be inserted as HTML. Links and images go through `isSafeHref`.
 *
 * Supported: # headings, paragraphs (single newlines become line breaks), **bold**, *italic*,
 * `code`, ``` fenced code ```, [links](url), ![images](url), - and 1. lists, > quotes, ---, and
 * backslash escapes.
 */

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ESCAPES[c]!);
}

/** Allow http(s), mailto, in-page anchors and same-site paths; reject javascript:, data: etc. */
export function isSafeHref(href: string): boolean {
  // Browsers ignore control characters and whitespace in schemes ("java\tscript:"), so do we.
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  const compact = href.replace(/[\u0000- \u007f]/g, '');
  if (!compact) return false;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(compact);
  if (!scheme) return true;
  return ['http', 'https', 'mailto'].includes(scheme[1]!.toLowerCase());
}

/** Escape Markdown syntax in a value substituted into a template, so it renders literally. */
export function escapeMarkdown(value: string): string {
  return value.replace(/([\\`*_[\]()#>!|-])/g, '\\$1');
}

const PLACEHOLDER = '\u0000';

function renderInline(text: string): string {
  const stash: string[] = [];
  const keep = (html: string) => `${PLACEHOLDER}${stash.push(html) - 1}${PLACEHOLDER}`;

  let s = text
    // Backslash escapes first so escaped characters never become syntax.
    .replace(/\\([\\`*_[\]()#>!|-])/g, (_, c: string) => keep(escapeHtml(c)))
    .replace(/`([^`]+)`/g, (_, code: string) => keep(`<code>${escapeHtml(code)}</code>`));

  s = escapeHtml(s);

  s = s
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (whole, alt: string, src: string) => {
      const url = unescapeAttr(src);
      return /^(https?:\/\/|\/)/i.test(url) && isSafeHref(url) ? keep(`<img src="${escapeHtml(url)}" alt="${alt}">`) : alt;
    })
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label: string, href: string) => {
      const url = unescapeAttr(href);
      if (!isSafeHref(url)) return label;
      const external = /^https?:\/\//i.test(url);
      return keep(`<a href="${escapeHtml(url)}"${external ? ' target="_blank" rel="noopener noreferrer"' : ''}>${label}</a>`);
    })
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');

  return s.replace(new RegExp(`${PLACEHOLDER}(\\d+)${PLACEHOLDER}`, 'g'), (_, i: string) => stash[Number(i)]!);
}

/** Undo escapeHtml on a captured URL so it can be validated and re-escaped exactly once. */
function unescapeAttr(value: string) {
  return value.replace(/&(amp|lt|gt|quot|#39);/g, (_, e: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[e]!);
}

export function renderMarkdown(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;

  const isBlockStart = (line: string) =>
    /^(#{1,6})\s/.test(line) || /^```/.test(line) || /^\s*([-*]|\d+\.)\s+/.test(line) || /^>\s?/.test(line) || /^(-{3,}|\*{3,})\s*$/.test(line);

  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }

    const fence = /^```/.exec(line);
    if (fence) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i]!)) code.push(lines[i++]!);
      i++;
      out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      out.push(`<h${level}>${renderInline(heading[2]!.trim())}</h${level}>`);
      i++;
      continue;
    }

    if (/^(-{3,}|\*{3,})\s*$/.test(line)) {
      out.push('<hr>');
      i++;
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i]!)) quote.push(lines[i++]!.replace(/^>\s?/, ''));
      out.push(`<blockquote><p>${quote.map(renderInline).join('<br>')}</p></blockquote>`);
      continue;
    }

    const list = /^\s*([-*]|\d+\.)\s+/.exec(line);
    if (list) {
      const ordered = /\d/.test(list[1]!);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i]!)) {
        items.push(`<li>${renderInline(lines[i++]!.replace(/^\s*([-*]|\d+\.)\s+/, ''))}</li>`);
      }
      out.push(ordered ? `<ol>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`);
      continue;
    }

    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !(para.length && isBlockStart(lines[i]!))) para.push(lines[i++]!);
    out.push(`<p>${para.map((l) => renderInline(l.trim())).join('<br>')}</p>`);
  }

  return out.join('\n');
}

/** Plain-text version for email clients without HTML: drop the syntax, keep link targets. */
export function markdownToText(markdown: string): string {
  return markdown
    .replace(/\r\n?/g, '\n')
    .replace(/^```.*$/gm, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '$1 ($2)')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/\*([^*\s][^*]*)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^>\s?/gm, '')
    .replace(/\\([\\`*_[\]()#>!|-])/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
