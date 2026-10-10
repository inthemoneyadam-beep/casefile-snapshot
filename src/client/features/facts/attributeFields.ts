/**
 * Turn the per-type zod attribute schemas into a flat field list so the
 * new/edit dialog can render typed inputs without a hand-written form per
 * fact type. Reads zod v4's public `_zod.def` shape.
 */
import { factAttributesByType } from '@shared/schemas/facts';

export interface AttributeField {
  key: string;
  kind: 'string' | 'number' | 'boolean' | 'enum';
  options?: string[];
  nullable: boolean;
  description?: string;
}

interface ZodDefLike {
  type: string;
  innerType?: ZodLike;
  entries?: Record<string, string>;
}
interface ZodLike {
  _zod: { def: ZodDefLike };
  description?: string;
}

function describe(key: string, schema: ZodLike): AttributeField {
  let def = schema._zod.def;
  let nullable = false;
  let description = schema.description;
  while (def.type === 'nullable' || def.type === 'optional') {
    if (def.type === 'nullable') nullable = true;
    const inner = def.innerType;
    if (!inner) break;
    description = description ?? inner.description;
    def = inner._zod.def;
  }
  if (def.type === 'enum') return { key, kind: 'enum', options: Object.values(def.entries ?? {}), nullable, description };
  if (def.type === 'number' || def.type === 'int') return { key, kind: 'number', nullable, description };
  if (def.type === 'boolean') return { key, kind: 'boolean', nullable, description };
  return { key, kind: 'string', nullable, description };
}

const cache = new Map<string, AttributeField[]>();

export function attributeFields(type: string): AttributeField[] {
  const hit = cache.get(type);
  if (hit) return hit;
  const schema = (factAttributesByType as Record<string, { shape: Record<string, unknown> }>)[type];
  const fields: AttributeField[] = schema ? Object.entries(schema.shape).map(([k, v]) => describe(k, v as ZodLike)) : [];
  cache.set(type, fields);
  return fields;
}

/** Form values are strings; '' means null for nullable fields. */
export function attributesToForm(type: string, attrs: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of attributeFields(type)) {
    const v = attrs[f.key];
    out[f.key] = v == null ? '' : typeof v === 'string' ? v : String(v);
  }
  return out;
}

/**
 * The form's fields as attributes. `original`: the attributes being edited. A field the user did not touch keeps its
 * stored value ('' stays '': "no flag printed"; a missing key stays missing), so an unchanged save changes nothing and
 * never marks a detail as edited by the user.
 */
export function formToAttributes(type: string, form: Record<string, string>, original?: Record<string, unknown> | null): Record<string, unknown> {
  const before = original ? attributesToForm(type, original) : null;
  const out: Record<string, unknown> = {};
  for (const f of attributeFields(type)) {
    if (before && original && (form[f.key] ?? '') === (before[f.key] ?? '')) {
      if (Object.prototype.hasOwnProperty.call(original, f.key)) out[f.key] = original[f.key];
      else if (!f.nullable) out[f.key] = f.kind === 'boolean' ? false : f.kind === 'number' ? null : '';
      continue;
    }
    const raw = (form[f.key] ?? '').trim();
    if (raw === '') {
      out[f.key] = f.nullable ? null : f.kind === 'boolean' ? false : f.kind === 'number' ? null : '';
      continue;
    }
    switch (f.kind) {
      case 'number': {
        const n = Number(raw);
        out[f.key] = Number.isFinite(n) ? n : null;
        break;
      }
      case 'boolean':
        out[f.key] = raw === 'true' || raw === '1' || raw === 'yes';
        break;
      default:
        out[f.key] = raw;
    }
  }
  return out;
}
