import {
  SETTINGS_SECTIONS,
  parseSection,
  settingsSections,
  type Settings,
  type SettingsSection,
} from '@glacier/shared';
import { prisma } from '../../db';
import { unprocessable } from '../../lib/errors';

// Settings are read on nearly every request, so keep them in memory. The panel runs as a single
// process; when it is scaled out this moves to Redis pub/sub invalidation.
let cache: Settings | null = null;

export async function getSettings(): Promise<Settings> {
  if (cache) return cache;
  const rows = await prisma.setting.findMany();
  const stored = new Map(rows.map((r) => [r.key, r.value]));
  cache = Object.fromEntries(SETTINGS_SECTIONS.map((s) => [s, parseSection(s, stored.get(s))])) as Settings;
  return cache;
}

export async function getSection<K extends SettingsSection>(section: K): Promise<Settings[K]> {
  return (await getSettings())[section];
}

/** Merge `patch` over the current section value, validate the result and store it. */
export async function updateSection<K extends SettingsSection>(section: K, patch: unknown): Promise<Settings[K]> {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
    throw unprocessable('Settings must be an object');
  }
  const current = await getSection(section);
  const result = settingsSections[section].safeParse({ ...current, ...patch });
  if (!result.success) {
    throw unprocessable(
      'Some settings are invalid',
      result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  const value = result.data as Settings[K];
  await prisma.setting.upsert({
    where: { key: section },
    create: { key: section, value: value as object },
    update: { value: value as object },
  });
  cache = null;
  return value;
}

export function clearSettingsCache() {
  cache = null;
}
