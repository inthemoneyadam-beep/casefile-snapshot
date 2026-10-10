import { Hono } from 'hono';
import { z } from 'zod';
import { listTimeline, timelineDensity, type TimelineFilter } from '../services/timeline';
import { isTimelineKind, type TimelineKind } from '../../shared/timeline';
import { badRequest } from '../util/errors';

const partial = z
  .string()
  .trim()
  .regex(/^\d{4}(-\d{2}(-\d{2})?)?$/, 'expected YYYY, YYYY-MM or YYYY-MM-DD')
  .optional();

const filterQuery = z.object({
  from: partial,
  to: partial,
  kinds: z.string().optional(),
  q: z.string().max(200).optional(),
  personId: z.string().max(64).optional(),
  documentId: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(20000).optional(),
});

const bucketEnum = z.enum(['year', 'month', 'day']);

/** The list also takes `perBucket` + `bucket`: at most N items per period (overview previews). */
const listQuery = filterQuery.extend({
  perBucket: z.coerce.number().int().min(1).max(100).optional(),
  bucket: bucketEnum.optional(),
});

const densityQuery = filterQuery.extend({ bucket: bucketEnum.default('month') });

function parseKinds(s: string | undefined): TimelineKind[] | null {
  if (!s) return null;
  const parts = s.split(',').map((k) => k.trim()).filter(Boolean);
  if (!parts.length) return null;
  const bad = parts.filter((k) => !isTimelineKind(k));
  if (bad.length) throw badRequest(`unknown timeline kind ${bad.join(', ')}`);
  return parts as TimelineKind[];
}

function toFilter(q: z.infer<typeof filterQuery>): TimelineFilter {
  return {
    from: q.from || null,
    to: q.to || null,
    kinds: parseKinds(q.kinds),
    q: q.q || null,
    personId: q.personId || null,
    documentId: q.documentId || null,
    limit: q.limit ?? null,
  };
}

export const timelineRoutes = new Hono()
  .get('/', (c) => {
    const parsed = listQuery.safeParse(c.req.query());
    if (!parsed.success) throw badRequest(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    const { perBucket, bucket, ...rest } = parsed.data;
    return c.json(listTimeline({ ...toFilter(rest), perBucket: perBucket ?? null, bucket: bucket ?? null }));
  })
  .get('/density', (c) => {
    const parsed = densityQuery.safeParse(c.req.query());
    if (!parsed.success) throw badRequest(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    const { bucket, ...rest } = parsed.data;
    return c.json(timelineDensity(bucket, toFilter(rest)));
  });
