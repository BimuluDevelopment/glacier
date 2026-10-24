import { describe, expect, it } from 'vitest';
import { PathMatcher } from './glob';

describe('PathMatcher', () => {
  it('matches basenames anywhere when the pattern has no slash', () => {
    const m = new PathMatcher(['*.log', 'server.jar']);
    expect(m.matches('latest.log')).toBe(true);
    expect(m.matches('logs/2026/latest.log')).toBe(true);
    expect(m.matches('/server.jar')).toBe(true);
    expect(m.matches('plugins/server.jar.bak')).toBe(false);
  });

  it('anchors patterns with a slash to the root', () => {
    const m = new PathMatcher(['/plugins/*.jar']);
    expect(m.matches('plugins/a.jar')).toBe(true);
    expect(m.matches('other/plugins/a.jar')).toBe(false);
    expect(m.matches('plugins/sub/a.jar')).toBe(false);
  });

  it('treats a trailing slash as a directory and everything in it', () => {
    const m = new PathMatcher(['cache/']);
    expect(m.matches('cache/x/y.bin')).toBe(true);
    expect(m.matches('cache')).toBe(false);
    expect(m.matches('world/cache/region.mca')).toBe(true);
  });

  it('supports ** and negation', () => {
    const m = new PathMatcher(['logs/**', '!logs/keep.log']);
    expect(m.matches('logs/a/b.log')).toBe(true);
    expect(m.matches('logs/keep.log')).toBe(false);
    expect(new PathMatcher(['**/node_modules/']).matches('bot/node_modules/x/index.js')).toBe(true);
  });

  it('ignores comments and blank lines, and matches directories by prefix', () => {
    const m = new PathMatcher(['# comment', '', 'world_nether']);
    expect(m.empty).toBe(false);
    expect(m.matches('world_nether/level.dat')).toBe(true);
    expect(m.matches('world/level.dat')).toBe(false);
    expect(new PathMatcher(['  ', '#x']).empty).toBe(true);
  });
});
