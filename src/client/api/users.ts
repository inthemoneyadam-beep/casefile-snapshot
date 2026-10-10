/**
 * Typed client for /api/auth (status, setup, unlock) and /api/users (people
 * with access, audit log), plus `useMe()`: who is signed in and what their
 * role allows, for hiding write controls.
 */
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, errorMessage } from './client';

export const ROLES = ['owner', 'editor', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export interface SessionUser {
  id: string;
  name: string;
  role: Role;
}

export interface AuthStatusFull {
  initialized: boolean;
  unlocked: boolean;
  unlockedAt: string | null;
  idleMinutes: number;
  /** Set while a running or queued job or an AI call holds the idle lock off: "locks after the current work finishes (...)". */
  idleHeld: string | null;
  session: boolean;
  user: SessionUser | null;
  users: Array<{ id: string; name: string }>;
  lan: { enabled: boolean; host: string; active: boolean; port: number | null } | null;
  /** The Files folder next to the app; null without a session, and always null on a hosted server. */
  filesFolder: string | null;
  /** True when the server runs hosted (on Railway, CASEFILE_HOSTED=1); false on the user's own computer. */
  hosted?: boolean;
  /** Hosted only: setting up and restoring need the setup code (CASEFILE_SETUP_TOKEN). */
  setupTokenRequired?: boolean;
  /** Hosted and the server has no setup code: setting up and restoring are refused until it is set. */
  setupTokenMissing?: boolean;
  /** A restore from a backup: where it stands, or its last outcome (null when none ran since the server started). */
  restore?: RestoreStatus | null;
}

/** GET /api/auth/status `restore`: a restore from a backup in progress, or how the last one ended. */
export interface RestoreStatus {
  state: 'receiving' | 'checking' | 'extracting' | 'done' | 'failed';
  receivedBytes: number;
  totalBytes: number | null;
  files: number;
  totalFiles: number | null;
  /** A plain sentence when it failed. */
  error: string | null;
  at: string;
}

export interface UserRow {
  id: string;
  name: string;
  role: Role;
  disabled: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  hasPassphrase: boolean;
  isMe: boolean;
}

export interface AuditRow {
  id: string;
  at: string;
  userId: string | null;
  userName: string | null;
  action: string;
  entityType: string | null;
  entityId: string | null;
  summary: string | null;
}

export interface SetupInput {
  passphrase: string;
  /** Hosted only: the setup code (CASEFILE_SETUP_TOKEN); ignored on a local copy. */
  setupToken?: string;
  name?: string;
  chiefOfStaff?: { name?: string; passphrase?: string } | null;
  apiKey?: string | null;
  theme?: 'dark' | 'dim' | 'light' | null;
}

export type SetupResult = AuthStatusFull & { chiefOfStaffPersonId: string | null; chiefOfStaffUserId: string | null; filesFolder: string | null };

/** The header the server reads the setup code from (setup also takes `setupToken` in its body). */
export const SETUP_TOKEN_HEADER = 'x-casefile-setup-token';

export const ROLE_HINT: Record<Role, string> = {
  owner: 'Everything, including people with access, the AI key, network access and purging.',
  editor: 'Everything in the case, except security settings, the AI key, other people’s passphrases and purging.',
  viewer: 'Read everything; add calls and messages, to-dos and symptom diary entries.',
};

/**
 * Same query key as useAuthStatus in hooks.ts so the status is fetched once. `pollMs` asks more often while
 * something on the server is under way (a restore from a backup), else once a minute.
 */
export function useAuthFull(pollMs?: number | false) {
  return useQuery({
    queryKey: ['auth'],
    queryFn: () => api.get<AuthStatusFull>('/api/auth/status'),
    refetchInterval: pollMs || 60_000,
    staleTime: 5_000,
    retry: false,
  });
}

export interface Me {
  user: SessionUser | null;
  role: Role | null;
  isOwner: boolean;
  isEditor: boolean;
  isViewer: boolean;
  /** Full write access (owner or editor). Viewers see read-only pages. */
  canWrite: boolean;
  /** Communications, tasks and symptom days: every role may add these. */
  canLog: boolean;
  /** Users, LAN access, AI key, purge: owner only. */
  canManageAccess: boolean;
  lan: AuthStatusFull['lan'];
  filesFolder: string | null;
  /** Running on a hosted server (Railway): no folder import by path, no local network setting. */
  hosted: boolean;
  isLoading: boolean;
}

export function useMe(): Me {
  const q = useAuthFull();
  const user = q.data?.user ?? null;
  const role = user?.role ?? null;
  return {
    user,
    role,
    isOwner: role === 'owner',
    isEditor: role === 'editor',
    isViewer: role === 'viewer',
    canWrite: role === 'owner' || role === 'editor',
    canLog: role !== null,
    canManageAccess: role === 'owner',
    lan: q.data?.lan ?? null,
    filesFolder: q.data?.filesFolder ?? null,
    hosted: q.data?.hosted === true,
    isLoading: q.isPending,
  };
}

/** Mirrors AUDIT_ACTIONS in src/server/services/audit.ts (the Action filter). */
export const AUDIT_ACTIONS = ['login', 'lock', 'setup', 'create', 'update', 'delete', 'purge', 'export', 'settings', 'passphrase', 'user', 'ai'] as const;

export interface AuditFilter {
  /** A user id, '-' for rows with no person (system rows), or empty for everyone. */
  userId?: string;
  action?: string;
  /** Case-insensitive substring over who, action, entity and summary. */
  q?: string;
}

export interface AuditPage {
  items: AuditRow[];
  /** Rows matching the filter, across every page. */
  total: number;
  /** Cursor for the next (older) page, or null on the last page. */
  nextBefore: string | null;
}

export const usersKeys = {
  all: ['users'] as const,
  list: ['users', 'list'] as const,
  audit: (f: AuditFilter, pageSize: number) => ['users', 'audit', f.userId ?? '', f.action ?? '', f.q ?? '', pageSize] as const,
};

export function useUsers(enabled = true) {
  return useQuery({ queryKey: usersKeys.list, queryFn: () => api.get<{ items: UserRow[]; total: number }>('/api/users'), enabled, retry: false, staleTime: 10_000 });
}

/**
 * The audit log, newest first, filtered on the server and paged with the
 * `nextBefore` cursor: fetchNextPage loads the next older page, so no row
 * is out of reach.
 */
export function useAuditLog(filter: AuditFilter, enabled = true, pageSize = 100) {
  return useInfiniteQuery({
    queryKey: usersKeys.audit(filter, pageSize),
    queryFn: ({ pageParam }) => api.get<AuditPage>(`/api/users/audit${api.qs({ limit: pageSize, userId: filter.userId, action: filter.action, q: filter.q, before: pageParam })}`),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextBefore,
    placeholderData: keepPreviousData,
    enabled,
    retry: false,
    staleTime: 10_000,
  });
}

export function useUserMutations() {
  const qc = useQueryClient();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: usersKeys.all });
    void qc.invalidateQueries({ queryKey: ['auth'] });
  };
  const create = useMutation({ mutationFn: (input: { name: string; role: Role; passphrase: string }) => api.post<UserRow>('/api/users', input), onSuccess: refresh });
  const update = useMutation({ mutationFn: ({ id, patch }: { id: string; patch: { name?: string; role?: Role; disabled?: boolean } }) => api.patch<UserRow>(`/api/users/${encodeURIComponent(id)}`, patch), onSuccess: refresh });
  const resetPassphrase = useMutation({ mutationFn: ({ id, passphrase }: { id: string; passphrase: string }) => api.post<{ ok: boolean }>(`/api/users/${encodeURIComponent(id)}/passphrase`, { passphrase }), onSuccess: refresh });
  const remove = useMutation({ mutationFn: (id: string) => api.delete<{ ok: boolean }>(`/api/users/${encodeURIComponent(id)}`), onSuccess: refresh });
  return { create, update, resetPassphrase, remove };
}

/** POST /api/auth/setup. A setup code is sent in the body and in its header (the server takes either). */
export function setupCase(input: SetupInput): Promise<SetupResult> {
  const code = input.setupToken?.trim() || undefined;
  return api.post<SetupResult>('/api/auth/setup', { ...input, setupToken: code }, code ? { headers: { [SETUP_TOKEN_HEADER]: code } } : undefined);
}

export function unlockAs(passphrase: string, userId?: string | null): Promise<AuthStatusFull> {
  return api.post<AuthStatusFull>('/api/auth/unlock', { passphrase, userId: userId ?? undefined });
}

export interface ImportFolderResult {
  imported: number;
  duplicates: number;
  skipped: Array<{ file: string; reason: string }>;
}

/**
 * Folder import (slice P). Returns null when the route does not exist in
 * this build, so callers can show the path to use later instead.
 */
export async function importFolder(folder: string): Promise<ImportFolderResult | null> {
  try {
    return await api.post<ImportFolderResult>('/api/documents/import-folder', { path: folder, recursive: true });
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

export function errorText(err: unknown, fallback = 'Something went wrong.'): string {
  if (err instanceof ApiError) {
    const body = err.body as { detail?: string } | null;
    if (body && typeof body === 'object' && typeof body.detail === 'string') return `${err.message}: ${body.detail}`;
    return err.message;
  }
  return errorMessage(err, fallback);
}
