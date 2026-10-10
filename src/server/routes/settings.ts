import { Hono } from 'hono';
import { z } from 'zod';
import { getPublicSettings, setSetting } from '../services/settings';
import { DEFAULT_SETTINGS, type SettingKey } from '../../shared/constants';
import { parseSettingValue } from '../../shared/schemas/settings';
import { badRequest } from '../util/errors';

const settable = new Set<string>(Object.keys(DEFAULT_SETTINGS));

export const settingsRoutes = new Hono()
  .get('/', (c) => c.json(getPublicSettings()))
  .patch('/', async (c) => {
    const body = z.record(z.string(), z.unknown()).safeParse(await c.req.json().catch(() => null));
    if (!body.success) throw badRequest('expected an object of settings');
    // Validate every key first (src/shared/schemas/settings.ts), so a bad
    // value never leaves the request half applied.
    const changes: Array<[SettingKey, unknown]> = [];
    for (const [k, v] of Object.entries(body.data)) {
      if (!settable.has(k)) throw badRequest(`unknown setting ${k}`);
      const parsed = parseSettingValue(k as SettingKey, v);
      if (!parsed.ok) throw badRequest(parsed.error);
      changes.push([k as SettingKey, parsed.value]);
    }
    for (const [k, v] of changes) setSetting(k, v as never);
    return c.json(getPublicSettings());
  });
