import { eq } from 'drizzle-orm';
import { db, schema } from '../db';
import { DEFAULT_SETTINGS, type SettingKey, type Settings } from '../../shared/constants';

let cache: Partial<Settings> | null = null;

export function clearSettingsCache(): void {
  cache = null;
}

function load(): Partial<Settings> {
  if (cache) return cache;
  const rows = db().select().from(schema.settings).all();
  const out: Partial<Settings> = {};
  for (const r of rows) {
    try {
      const v: unknown = JSON.parse(r.valueJson);
      // No setting is ever null; a null stored before PATCH validated values reads as the default.
      if (v !== null) (out as Record<string, unknown>)[r.key] = v;
    } catch {
      // ignore corrupt row
    }
  }
  cache = out;
  return out;
}

export function getSetting<K extends SettingKey>(key: K): Settings[K] {
  const v = load()[key];
  return (v === undefined ? DEFAULT_SETTINGS[key] : v) as Settings[K];
}

export function getAllSettings(): Settings {
  return { ...DEFAULT_SETTINGS, ...load() } as Settings;
}

/** Everything except secrets, for the client. */
export function getPublicSettings(): Omit<Settings, 'ai.apiKey'> & { 'ai.apiKeySet': boolean; 'ai.apiKeySource': 'env' | 'settings' | 'none' } {
  const all = getAllSettings();
  const { 'ai.apiKey': apiKey, ...rest } = all;
  const envKey = process.env.ANTHROPIC_API_KEY;
  return {
    ...rest,
    'ai.apiKeySet': Boolean(envKey || apiKey),
    'ai.apiKeySource': envKey ? 'env' : apiKey ? 'settings' : 'none',
  };
}

export function setSetting<K extends SettingKey>(key: K, value: Settings[K]): void {
  const valueJson = JSON.stringify(value);
  db()
    .insert(schema.settings)
    .values({ key, valueJson, updatedAt: new Date().toISOString() })
    .onConflictDoUpdate({ target: schema.settings.key, set: { valueJson, updatedAt: new Date().toISOString() } })
    .run();
  cache = null;
}

export function deleteSetting(key: SettingKey): void {
  db().delete(schema.settings).where(eq(schema.settings.key, key)).run();
  cache = null;
}
