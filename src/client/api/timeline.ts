import { useQuery } from '@tanstack/react-query';
import { api } from './client';
import type { TimelineBucket, TimelineDensityResponse, TimelineItem as SharedTimelineItem, TimelineResponse as SharedTimelineResponse } from '@shared/timeline';

export type { TimelineKind, TimelineBucket, TimelineZoom, TimelineDensityResponse, TimelineDensityRow } from '@shared/timeline';

/**
 * A timeline item as GET /api/timeline returns it. `overriddenBy` is set on a
 * fact a patient statement takes precedence over (the id of that statement).
 * Declared here until the field moves into the shared TimelineItem.
 */
export type TimelineItem = SharedTimelineItem & { overriddenBy?: string | null };
export type TimelineResponse = Omit<SharedTimelineResponse, 'items'> & { items: TimelineItem[] };

// A type alias (not an interface) so it satisfies api.qs's Record parameter.
export type TimelineParams = {
  from?: string;
  to?: string;
  kinds?: string;
  q?: string;
  personId?: string;
  documentId?: string;
  limit?: number;
  /** With `bucket`: at most this many items per period (overview previews). */
  perBucket?: number;
  bucket?: TimelineBucket;
};

export function useTimeline(params: TimelineParams, enabled = true) {
  return useQuery({
    queryKey: ['timeline', params],
    queryFn: () => api.get<TimelineResponse>(`/api/timeline${api.qs(params)}`),
    enabled,
    staleTime: 15_000,
    placeholderData: (prev) => prev,
  });
}

export function useTimelineDensity(bucket: TimelineBucket, params: Omit<TimelineParams, 'limit' | 'perBucket' | 'bucket'>, enabled = true) {
  return useQuery({
    queryKey: ['timeline', 'density', bucket, params],
    queryFn: () => api.get<TimelineDensityResponse>(`/api/timeline/density${api.qs({ bucket, ...params })}`),
    enabled,
    staleTime: 15_000,
    placeholderData: (prev) => prev,
  });
}
