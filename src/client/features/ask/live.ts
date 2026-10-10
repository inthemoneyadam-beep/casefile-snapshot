/**
 * Live state for answers being generated, shared by the /ask page and the
 * dock: one SSE stream per message id, buffered thinking/text/tools/charts,
 * and the prefill mailbox for `casefile:ask-prefill` events (kept in a module
 * so an event fired before the dock mounts is not lost). This module is
 * loaded by the Shell through ConsultDock, so the listeners exist app-wide.
 */
import { useSyncExternalStore } from 'react';
import { ApiError } from '../../api/client';
import { streamAskMessage } from '../../api/ask';
import type { AskEvent, AskMessageFull, AskPrefill, AskStatus } from '@shared/ask';
import type { ChartSpec } from '@shared/chart';

export interface LiveMessage {
  id: string;
  status: AskStatus | string;
  note?: string;
  thinking: string;
  text: string;
  tools: Array<{ name: string; summary: string; error?: boolean }>;
  charts: ChartSpec[];
  startedAt: number;
  finished: boolean;
  error?: string;
  message?: AskMessageFull;
}

const live = new Map<string, LiveMessage>();
const subs = new Set<() => void>();
let version = 0;
let scheduled = false;

function emit(): void {
  if (scheduled) return;
  scheduled = true;
  const flush = () => {
    scheduled = false;
    version++;
    subs.forEach((s) => s());
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(flush);
  else setTimeout(flush, 16);
}

function subscribeStore(cb: () => void): () => void {
  subs.add(cb);
  return () => void subs.delete(cb);
}

export function useLiveVersion(): number {
  return useSyncExternalStore(subscribeStore, () => version, () => version);
}

export function useLive(id: string | null | undefined): LiveMessage | undefined {
  useLiveVersion();
  return id ? live.get(id) : undefined;
}

export function getLive(id: string): LiveMessage | undefined {
  return live.get(id);
}

function apply(st: LiveMessage, ev: AskEvent): void {
  switch (ev.type) {
    case 'status':
      st.status = ev.status;
      st.note = ev.note;
      break;
    case 'thinking':
      st.thinking += ev.delta;
      break;
    case 'text':
      st.text += ev.delta;
      break;
    case 'tool':
      st.tools.push({ name: ev.name, summary: ev.summary, error: ev.error });
      st.note = `${ev.name} done`;
      break;
    case 'chart':
      st.charts[ev.n - 1] = ev.chart;
      break;
    case 'done':
      st.finished = true;
      st.message = ev.message;
      st.status = (ev.message.meta as { status?: string }).status ?? 'done';
      break;
    case 'error':
      st.finished = true;
      st.error = ev.error;
      st.message = ev.message;
      st.status = 'error';
      break;
  }
}

/** Follow a message's stream (idempotent per id). Replays buffered content first, then live deltas. */
export function startStream(id: string): void {
  if (live.has(id)) return;
  const st: LiveMessage = { id, status: 'running', note: 'connecting', thinking: '', text: '', tools: [], charts: [], startedAt: Date.now(), finished: false };
  live.set(id, st);
  emit();
  void (async () => {
    try {
      for await (const ev of streamAskMessage(id)) {
        if (!ev || typeof ev !== 'object') continue;
        apply(st, ev);
        emit();
        if (st.finished) break;
      }
      if (!st.finished) {
        st.finished = true;
        st.error = 'The stream ended before the answer finished; reload to see what was saved.';
      }
    } catch (err) {
      st.finished = true;
      st.error =
        err instanceof ApiError && err.status === 403
          ? 'You do not have access to follow this answer live; it appears here once it finishes.'
          : err instanceof Error
            ? err.message
            : String(err);
    }
    emit();
  })();
}

export function forgetLive(id: string): void {
  if (live.delete(id)) emit();
}

// ---------------------------------------------------------------------------
// Prefill mailbox and session memory
// ---------------------------------------------------------------------------

export const PREFILL_EVENT = 'casefile:ask-prefill';
export const NEW_SESSION_EVENT = 'casefile:ask-new-session';
const SESSION_KEY = 'casefile.ask.session';

let pending: AskPrefill | null = null;
let prefillVersion = 0;
const prefillSubs = new Set<() => void>();

if (typeof window !== 'undefined') {
  window.addEventListener(PREFILL_EVENT, (e) => {
    const d = (e as CustomEvent<AskPrefill>).detail;
    if (!d || typeof d !== 'object') return;
    pending = { text: typeof d.text === 'string' ? d.text : '', mode: d.mode, encounterId: d.encounterId, personId: d.personId, presetKey: d.presetKey, send: d.send === true };
    prefillVersion++;
    prefillSubs.forEach((s) => s());
  });
}

export function usePrefillVersion(): number {
  return useSyncExternalStore(
    (cb) => {
      prefillSubs.add(cb);
      return () => void prefillSubs.delete(cb);
    },
    () => prefillVersion,
    () => prefillVersion,
  );
}

/** Take the pending prefill (once). */
export function takePrefill(): AskPrefill | null {
  const p = pending;
  pending = null;
  return p;
}

export function readStoredSession(): string | null {
  try {
    return localStorage.getItem(SESSION_KEY) || null;
  } catch {
    return null;
  }
}

export function writeStoredSession(id: string | null): void {
  try {
    if (id) localStorage.setItem(SESSION_KEY, id);
    else localStorage.removeItem(SESSION_KEY);
  } catch {
    // ignore
  }
}

export function requestNewSession(): void {
  writeStoredSession(null);
  window.dispatchEvent(new CustomEvent(NEW_SESSION_EVENT));
}

export function prefill(p: AskPrefill): void {
  window.dispatchEvent(new CustomEvent<AskPrefill>(PREFILL_EVENT, { detail: p }));
}

/** Elapsed time as "2m14s" / "0m05s" / "1h02m". */
export function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h}h${String(m).padStart(2, '0')}m`;
  return `${m}m${String(sec).padStart(2, '0')}s`;
}

export function fmtTokens(n: number | undefined | null): string {
  if (!n) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k`;
  return String(n);
}

export function fmtUsd(n: number | undefined | null): string {
  if (!n) return '$0.00';
  return n < 0.01 ? '<$0.01' : `$${n.toFixed(2)}`;
}
