/**
 * Typed client for /api/ai/calls: the log of every request to Claude (the AI log page). One key, ['ai','calls'],
 * which the page refreshes, and so do Settings' connection test and a finished answer in Ask.
 */
import { useQuery } from '@tanstack/react-query';
import { api } from './client';

export const aiKeys = {
  calls: ['ai', 'calls'] as const,
};

export interface AiCall {
  id: string;
  createdAt: string;
  purpose: string;
  model: string;
  jobId: string | null;
  documentIdsJson: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedUsd: number;
  durationMs: number;
  status: string;
  error: string | null;
  requestSummary: string | null;
  stopReason: string | null;
}

export interface AiCallTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedUsd: number;
}

/** Up to 1,000 requests with the totals, refreshed every 10 s while the page is open. */
export function useAiCalls() {
  return useQuery({
    queryKey: aiKeys.calls,
    queryFn: () => api.get<{ items: AiCall[]; totals: AiCallTotals }>('/api/ai/calls?limit=1000'),
    refetchInterval: 10_000,
  });
}
