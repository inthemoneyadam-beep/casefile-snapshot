/**
 * Typed client for /api/export: packet rows, the builder's options, and the
 * mutations. Query keys start with 'export' so one invalidation refreshes
 * the list and the detail together.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, LOCK_EVENT } from './client';
import type { TimelineKind } from '@shared/timeline';

export type FactScope = string[] | 'confirmed' | 'all' | 'none';
export type FindingScope = string[] | 'confirmed' | 'all' | 'none';

export interface PacketConfig {
  title: string;
  recipient?: string | null;
  purpose?: string | null;
  documentIds: string[];
  factIds?: FactScope;
  factsFromPacketDocumentsOnly?: boolean;
  findingIds?: FindingScope;
  timeline?: { from?: string | null; to?: string | null; kinds?: TimelineKind[] | null } | null;
  includeEmergencyCard: boolean;
  includeRecordsIndex: boolean;
  includeMedications: boolean;
  includeLabs: string[];
  coverSummary?: string | null;
  /** The Care team summary page (2026-10-09). */
  includeCareTeam?: boolean;
}

export interface PacketAppended {
  n: number;
  documentId: string;
  title: string;
  pages: number;
  startPage: number | null;
  how: 'pdf' | 'image' | 'text' | 'failed';
  error?: string;
}

export interface PacketResult {
  format: 'pdf' | 'html';
  browser: string | null;
  htmlPages: number | null;
  appended: PacketAppended[];
  note: string | null;
  durationMs: number;
}

export interface PacketRow {
  id: string;
  title: string;
  configJson: string;
  storageKey: string | null;
  sizeBytes: number | null;
  pageCount: number | null;
  status: string;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
  config: PacketConfig;
  result: PacketResult | null;
  note: string | null;
  recipient: string | null;
  format: 'pdf' | 'html' | null;
  documentCount: number;
}

export interface PacketJob {
  id: string;
  status: string;
  progress: number;
  progressText: string | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface PacketDetail extends PacketRow {
  job: PacketJob | null;
}

export interface AnalyteOption {
  analyteKey: string;
  analyte: string;
  specimens: string[];
  count: number;
  unit: string | null;
  lastDate: string | null;
}

export interface ExportOptions {
  browser: string | null;
  analytes: AnalyteOption[];
  counts: { documents: number; factsConfirmed: number; factsAll: number; findingsConfirmed: number; findingsAll: number; medications: number; intolerances: number; hardStops: number; records: number };
  timelineRange: { min: string | null; max: string | null };
  patient: { name: string; dob: string; bloodType: string; emergencyContacts: string; summary: string };
}

export const exportKeys = {
  all: ['export'] as const,
  list: ['export', 'list'] as const,
  detail: (id: string) => ['export', 'detail', id] as const,
  options: ['export', 'options'] as const,
};

export const ACTIVE_PACKET = new Set(['queued', 'running']);

export function usePackets() {
  return useQuery({
    queryKey: exportKeys.list,
    queryFn: () => api.get<{ items: PacketRow[] }>('/api/export/packets'),
    refetchInterval: (q) => (q.state.data?.items.some((p) => ACTIVE_PACKET.has(p.status)) ? 2000 : false),
    placeholderData: (prev) => prev,
  });
}

export function usePacket(id: string | null | undefined) {
  return useQuery({
    queryKey: exportKeys.detail(id ?? ''),
    queryFn: () => api.get<PacketDetail>(`/api/export/packets/${encodeURIComponent(id!)}`),
    enabled: Boolean(id),
    refetchInterval: (q) => {
      const d = q.state.data;
      return d && (ACTIVE_PACKET.has(d.status) || (d.job && ACTIVE_PACKET.has(d.job.status))) ? 1200 : false;
    },
  });
}

export function useExportOptions() {
  return useQuery({ queryKey: exportKeys.options, queryFn: () => api.get<ExportOptions>('/api/export/options'), staleTime: 15_000 });
}

export function packetFileUrl(id: string, download = false): string {
  return `/api/export/packets/${encodeURIComponent(id)}/file${download ? '?download=1' : ''}`;
}

/**
 * The packet HTML for an iframe `srcdoc` or a preview tab; nothing is
 * generated or stored. Always a POST: the config (document ids, purpose,
 * cover summary) can exceed a URL's header limit and must not land in the
 * browser history.
 */
export async function fetchPreviewHtml(config: PacketConfig): Promise<string> {
  const res = await fetch('/api/export/preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(config), credentials: 'same-origin' });
  if (res.status === 423 || res.status === 401) window.dispatchEvent(new CustomEvent(LOCK_EVENT));
  const text = await res.text();
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      // A 403 carries the role in `error` and the explanation in `detail`.
      const j = JSON.parse(text) as { error?: string; detail?: string };
      if (j.detail) msg = j.detail;
      else if (j.error) msg = j.error;
    } catch {
      // not json
    }
    throw new Error(msg);
  }
  return text;
}

export function useExportMutations() {
  const qc = useQueryClient();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: exportKeys.all });
    void qc.invalidateQueries({ queryKey: ['jobs'] });
  };
  const create = useMutation({
    mutationFn: (config: PacketConfig) => api.post<{ packet: PacketDetail; job: { id: string; status: string } }>('/api/export/packets', config),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete<{ ok: boolean }>(`/api/export/packets/${encodeURIComponent(id)}`),
    onSuccess: refresh,
  });
  return { create, remove };
}
