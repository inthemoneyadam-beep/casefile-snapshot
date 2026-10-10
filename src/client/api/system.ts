/**
 * Typed client for the Settings page's actions: test the connection to Claude, change the passphrase, make a
 * backup now, and the backups kept on the server (listed, each downloadable; owner only). Each action hook takes the
 * page's own onSuccess and onError, which set the page's state and toasts.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';

export interface AiTestResult {
  ok: boolean;
  model: string;
  error?: string;
}

/** POST /api/system/backup (services/backup.ts): the zip, its size, and anything the backup could not include cleanly. */
export interface BackupResult {
  path: string;
  bytes: number;
  warnings: string[];
  /** The file name only (casefile-20261008-141500.zip); a hosted server shows this, never the path. */
  name?: string;
}

/** GET /api/system/backups: one finished backup zip in the backups folder. */
export interface BackupFile {
  name: string;
  bytes: number;
  createdAt: string;
}

export const backupKeys = { list: ['system', 'backups'] as const };

interface Handlers<T> {
  onSuccess: (result: T) => void;
  onError: (err: Error) => void;
}

/** POST /api/ai/test: the connection test. */
export function useTestAiConnection(on: Handlers<AiTestResult>) {
  return useMutation({ mutationFn: () => api.post<AiTestResult>('/api/ai/test'), onSuccess: on.onSuccess, onError: on.onError });
}

/** POST /api/auth/change-passphrase. */
export function useChangePassphrase(on: Handlers<{ ok: boolean }>) {
  return useMutation({
    mutationFn: (body: { current: string; next: string }) => api.post<{ ok: boolean }>('/api/auth/change-passphrase', body),
    onSuccess: on.onSuccess,
    onError: on.onError,
  });
}

/** POST /api/system/backup: a backup now. The list of backups is fetched again after it. */
export function useBackupNow(on: Handlers<BackupResult>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<BackupResult>('/api/system/backup'),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: backupKeys.list });
      on.onSuccess(r);
    },
    onError: on.onError,
  });
}

/** GET /api/system/backups: the backups kept on the server, newest first (owner only: `enabled` false for others). */
export function useBackups(enabled: boolean) {
  return useQuery({ queryKey: backupKeys.list, queryFn: () => api.get<{ items: BackupFile[] }>('/api/system/backups'), enabled, retry: false, staleTime: 15_000 });
}

/** GET /api/system/backups/:name/file: the zip, sent as an attachment under its own name. */
export function backupFileUrl(name: string): string {
  return `/api/system/backups/${encodeURIComponent(name)}/file`;
}
