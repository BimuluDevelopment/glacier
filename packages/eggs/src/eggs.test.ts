import { describe, expect, it } from 'vitest';
import { BUNDLED_EGGS, buildConfigFiles, parseEgg, resolveTemplate, toPtdl, validateVariable } from './index';

describe('parseEgg', () => {
  it('parses every bundled egg', () => {
    for (const { egg } of BUNDLED_EGGS) {
      const def = parseEgg(egg);
      expect(def.name).toBe(egg.name);
      expect(Object.keys(def.dockerImages).length).toBeGreaterThan(0);
    }
  });

  it('accepts Pterodactyl-style JSON-encoded config blocks and numeric booleans', () => {
    const def = parseEgg({
      meta: { version: 'PTDL_v1' },
      name: 'Legacy',
      image: 'quay.io/legacy:latest',
      startup: './run',
      config: {
        files: '{"a.properties":{"parser":"properties","find":{"port":"{{server.build.default.port}}"}}}',
        startup: '{"done":["ready","started"]}',
        stop: 'quit',
      },
      scripts: { installation: { script: 'echo hi\r\n', container: 'alpine', entrypoint: 'ash' } },
      variables: [{ name: 'X', env_variable: 'X', default_value: 5, user_viewable: 1, user_editable: 0, rules: ['required', 'integer'] }],
    });
    expect(def.dockerImages).toEqual({ Default: 'quay.io/legacy:latest' });
    expect(def.config.startupDone).toEqual(['ready', 'started']);
    expect(def.install.script).toBe('echo hi\n');
    expect(def.variables[0]).toMatchObject({ defaultValue: '5', userViewable: true, userEditable: false, rules: 'required|integer' });
  });

  it('round-trips through PTDL_v2 export', () => {
    const original = parseEgg(BUNDLED_EGGS[0]!.egg);
    const again = parseEgg(toPtdl(original));
    expect(again).toEqual(original);
  });

  it('rejects garbage with readable issues', () => {
    expect(() => parseEgg('{nope')).toThrow(/not valid JSON/);
    expect(() => parseEgg({ meta: { version: 'PTDL_v2' } })).toThrow(/not a valid/);
  });
});

describe('templates', () => {
  const ctx = { ip: '0.0.0.0', port: 25565, memory: 2048, env: { MINECRAFT_EULA: 'true' } };

  it('resolves server and env placeholders, leaving daemon ones', () => {
    expect(resolveTemplate('{{server.build.default.port}}', ctx)).toBe('25565');
    expect(resolveTemplate('{{ server.build.env.MINECRAFT_EULA }}', ctx)).toBe('true');
    expect(resolveTemplate('{{config.docker.interface}}', ctx)).toBe('{{config.docker.interface}}');
  });

  it('builds daemon config files and drops unsupported parsers', () => {
    const files = buildConfigFiles(
      { 'server.properties': { parser: 'properties', find: { 'server-port': '{{server.build.default.port}}' } }, 'x.xml': { parser: 'xml', find: {} } },
      ctx,
    );
    expect(files).toEqual([{ file: 'server.properties', parser: 'properties', replace: [{ match: 'server-port', replaceWith: '25565' }] }]);
  });
});

describe('validateVariable', () => {
  it('applies Laravel-style rules', () => {
    expect(validateVariable('', 'required|string')).toMatch(/required/);
    expect(validateVariable('', 'nullable|string')).toBeNull();
    expect(validateVariable('abc', 'required|integer')).toMatch(/whole number/);
    expect(validateVariable('5', 'required|integer|between:1,10')).toBeNull();
    expect(validateVariable('maybe', 'required|in:true,false')).toMatch(/one of/);
    expect(validateVariable('server.jar', 'required|regex:/^([\\w\\d._-]+)(\\.jar)$/')).toBeNull();
    expect(validateVariable('server.zip', 'required|regex:/^([\\w\\d._-]+)(\\.jar)$/')).toMatch(/format/);
    expect(validateVariable('toolongvalue', 'string|max:5')).toMatch(/at most 5/);
  });
});
