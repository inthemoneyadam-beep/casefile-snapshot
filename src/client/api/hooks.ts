import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import type { Settings } from '@shared/constants';

export interface AuthStatus {
  initialized: boolean;
  unlocked: boolean;
  unlockedAt: string | null;
  idleMinutes: number;
  /** Set while running work holds the idle lock off: "locks after the current work finishes (...)". */
  idleHeld?: string | null;
  session: boolean;
  /** Present once slice S's multi-user auth is active (see src/client/api/users.ts for the full shape). */
  user?: { id: string; name: string; role: 'owner' | 'editor' | 'viewer' } | null;
  users?: Array<{ id: string; name: string; role: string }>;
  lan?: { enabled: boolean; host: string; active: boolean; port: number | null } | null;
  filesFolder?: string | null;
}

export function useAuthStatus() {
  return useQuery({
    queryKey: ['auth'],
    queryFn: () => api.get<AuthStatus>('/api/auth/status'),
    refetchInterval: 60_000,
    staleTime: 5_000,
    retry: false,
  });
}

export type PublicSettings = Omit<Settings, 'ai.apiKey'> & { 'ai.apiKeySet': boolean; 'ai.apiKeySource': 'env' | 'settings' | 'none' };

export function useSettings() {
  return useQuery({ queryKey: ['settings'], queryFn: () => api.get<PublicSettings>('/api/settings'), staleTime: 30_000 });
}

export function useUpdateSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<Settings>) => api.patch<PublicSettings>('/api/settings', patch),
    onSuccess: (data) => qc.setQueryData(['settings'], data),
  });
}

export interface JobRow {
  id: string;
  type: string;
  lane: string;
  status: string;
  priority: number;
  attempts: number;
  progress: number;
  progressText: string | null;
  error: string | null;
  documentId: string | null;
  /** The document's title, when the job works on one (GET /api/jobs adds it). */
  documentTitle?: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export function useActiveJobs() {
  return useQuery({
    queryKey: ['jobs', 'active'],
    queryFn: () => api.get<{ items: JobRow[] }>('/api/jobs?active=1'),
    refetchInterval: (q) => ((q.state.data?.items.length ?? 0) > 0 ? 1500 : 6000),
  });
}

export interface SystemInfo {
  app: string;
  dataDir: string;
  backupsDir: string;
  dbBytes: number;
  counts: Record<string, number>;
}

export function useSystemInfo() {
  return useQuery({ queryKey: ['system', 'info'], queryFn: () => api.get<SystemInfo>('/api/system/info'), staleTime: 15_000 });
}
