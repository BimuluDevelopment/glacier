import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '@glacier/shared';
import { fillTemplate } from './service';

describe('fillTemplate', () => {
  it('escapes user-controlled values so they cannot add links or formatting', () => {
    const body = fillTemplate('Hi {{name}}, [open]({{serverUrl}})', {
      name: '[click me](https://evil.example) **now**',
      serverUrl: 'https://panel.example.com/server/abcd1234',
    });
    const html = renderMarkdown(body);
    expect(html).not.toContain('evil.example"');
    expect(html).toContain('[click me](https://evil.example) **now**');
    expect(html).toContain('<a href="https://panel.example.com/server/abcd1234"');
  });

  it('leaves unknown placeholders alone and can skip escaping for subjects', () => {
    expect(fillTemplate('{{unknown}} {{name}}', { name: 'a*b' })).toBe('{{unknown}} a\\*b');
    expect(fillTemplate('Welcome {{name}}', { name: 'a*b' }, false)).toBe('Welcome a*b');
  });
});
