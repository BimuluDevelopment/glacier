import { describe, expect, it } from 'vitest';
import { applyToml, applyYaml, tomlValue } from './server/config-files';

const velocity = `# Velocity
config-version = "2.7"
bind = "0.0.0.0:25577"
player-info-forwarding-mode = "NONE"

[servers]
lobby = "127.0.0.1:30066"
factions = "127.0.0.1:30067"
try = [
  "lobby"
]

[forced-hosts]
"lobby.example.com" = ["lobby"]

[advanced]
compression-threshold = 256
`;

describe('applyToml', () => {
  it('sets top-level and table keys, keeping comments and other tables', () => {
    const out = applyToml(velocity, [
      { match: 'player-info-forwarding-mode', replaceWith: 'modern' },
      { match: 'advanced.compression-threshold', replaceWith: '512' },
      { match: 'advanced.haproxy-protocol', replaceWith: 'false' },
    ]);
    expect(out).toContain('# Velocity');
    expect(out).toContain('player-info-forwarding-mode = "modern"');
    expect(out).toContain('compression-threshold = 512');
    expect(out).toContain('haproxy-protocol = false');
    expect(out).toContain('lobby = "127.0.0.1:30066"');
  });

  it('replaces a whole table, including multi-line arrays', () => {
    const out = applyToml(velocity, [
      { match: 'servers', replaceWith: '', value: { survival: 'abc:30000', try: ['survival'] } },
      { match: 'forced-hosts', replaceWith: '', value: { 'play.example.com': ['survival'] } },
    ]);
    expect(out).not.toContain('factions');
    expect(out).not.toContain('lobby');
    expect(out).toContain('[servers]\nsurvival = "abc:30000"\ntry = ["survival"]\n\n[forced-hosts]');
    expect(out).toContain('"play.example.com" = ["survival"]');
    expect(out).toContain('[advanced]\ncompression-threshold = 256');
  });

  it('replaces a multi-line array value without leaving its tail behind', () => {
    const out = applyToml(velocity, [{ match: 'servers.try', replaceWith: '', value: ['factions'] }]);
    expect(out).toContain('try = ["factions"]');
    expect(out).not.toMatch(/^\s*"lobby"\s*$/m);
    expect(out).not.toMatch(/^\]$/m);
  });

  it('adds missing tables', () => {
    expect(applyToml('bind = "x"\n', [{ match: 'query.enabled', replaceWith: 'true' }])).toBe('bind = "x"\n\n[query]\nenabled = true\n');
  });

  it('formats values as TOML', () => {
    expect(tomlValue('a "q" \\ b')).toBe('"a \\"q\\" \\\\ b"');
    expect(tomlValue(['a', 1, true])).toBe('["a", 1, true]');
    expect(tomlValue({ 'a.b': 'c' })).toBe('{ "a.b" = "c" }');
  });
});

describe('applyYaml with structured values', () => {
  it('replaces maps and lists and keeps strings that look like numbers as strings', () => {
    const out = applyYaml('servers:\n  lobby:\n    address: localhost:25565\nlisteners:\n- host: 0.0.0.0:25577\n  priorities:\n  - lobby\n', [
      { match: 'servers', replaceWith: '', value: { hub: { address: 'u:30000', restricted: false } } },
      { match: 'listeners[0].priorities', replaceWith: '', value: ['hub'] },
      { match: 'proxies.velocity.secret', replaceWith: '', value: '12345' },
    ]);
    expect(out).not.toContain('lobby');
    expect(out).toContain('hub:\n    address: u:30000');
    expect(out).toContain('priorities:\n      - hub');
    expect(out).toContain('secret: "12345"');
  });
});
