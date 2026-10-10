/**
 * The /labs URL search params, validated by the route's validateSearch. `id`
 * is any entry id: a lab_results id, `fact:<factId>`, a part of a line that
 * held several tests (`<row or fact id>#<index>`), or `analyteKey::specimen`
 * for a test in the By test view. Plain TypeScript so tests can import it.
 */
import { z } from 'zod';

export const LABS_VIEWS = ['panels', 'documents', 'results'] as const;
export type LabsView = (typeof LABS_VIEWS)[number];

export const labsSearchSchema = z.object({
  id: z.string().optional().catch(undefined),
  // An older "analytes" link falls back to the default (panels) through catch.
  view: z.enum(LABS_VIEWS).optional().catch(undefined),
  analyteKey: z.string().optional().catch(undefined),
  specimen: z.string().optional().catch(undefined),
  flag: z.string().optional().catch(undefined),
  q: z.string().optional().catch(undefined),
  from: z.string().optional().catch(undefined),
  to: z.string().optional().catch(undefined),
  overlay: z.enum(['1']).optional().catch(undefined),
});
export type LabsSearch = z.infer<typeof labsSearchSchema>;

/** The view a link opens when it names none: a test (`key::specimen`) opens By test, a single value All values. */
export function defaultLabsView(id: string | null | undefined): LabsView {
  return id && !id.includes('::') ? 'results' : 'panels';
}
