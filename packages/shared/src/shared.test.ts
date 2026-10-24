import { describe, expect, it } from 'vitest';
import {
  ALL_SERVER_PERMISSIONS,
  DEFAULT_FEATURES,
  defaultSettings,
  hasPermission,
  parsePortList,
  parseSection,
} from './index';

describe('settings', () => {
  it('produces complete defaults for every section', () => {
    const s = defaultSettings();
    expect(s.branding.name).toBe('Glacier Panel');
    expect(s.theme.dark.primary).toMatch(/^#/);
    expect(s.features).toEqual(DEFAULT_FEATURES);
  });

  it('merges partial stored values over defaults', () => {
    const branding = parseSection('branding', { name: 'Acme Hosting' });
    expect(branding.name).toBe('Acme Hosting');
    expect(branding.tagline).toBeTruthy();
    const features = parseSection('features', { registration: true });
    expect(features.registration).toBe(true);
    expect(features.plugins).toBe(DEFAULT_FEATURES.plugins);
  });

  it('falls back to defaults when stored data is invalid', () => {
    const theme = parseSection('theme', { radius: 'huge' });
    expect(theme.radius).toBe(10);
  });
});

describe('permissions', () => {
  it('lists group.key permissions and honours the wildcard', () => {
    expect(ALL_SERVER_PERMISSIONS).toContain('control.console');
    expect(ALL_SERVER_PERMISSIONS).toContain('database.view-password');
    expect(hasPermission(['*'], 'file.delete')).toBe(true);
    expect(hasPermission(['file.read'], 'file.delete')).toBe(false);
  });
});

describe('parsePortList', () => {
  it('parses single ports and ranges', () => {
    expect(parsePortList('25565, 25570-25572,25565')).toEqual([25565, 25570, 25571, 25572]);
  });

  it('rejects bad input', () => {
    expect(() => parsePortList('80')).toThrow();
    expect(() => parsePortList('30000-29999')).toThrow();
    expect(() => parsePortList('abc')).toThrow();
    expect(() => parsePortList('2000-9000')).toThrow();
  });
});
