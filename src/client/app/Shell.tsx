import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Link, useRouterState } from '@tanstack/react-router';
import { NAV, NAV_GROUPS } from './nav';
import { useActiveJobs, useSettings } from '../api/hooks';
import { useMe } from '../api/users';
import { APP_NAME } from '@shared/constants';
import { openPalette } from './commands';
import { dock, readDockOpen, writeDockOpen, type DockEvent } from './dock';
import { ConsultDock } from '../features/ask/ConsultDock';
import { GlobalDropZone } from '../features/inbox/GlobalDropZone';
import { AccessLine } from '../features/users/AccessLine';
import { usePendingCounts } from '../api/filing';
import { AddDocumentsButton } from '../features/filing/Filing';

/** What a background job is doing, in plain words. */
const JOB_WORDS: Record<string, string> = {
  ingest_document: 'reading a document',
  reingest_document: 're-reading a document',
  triage_document: 'naming and sorting a document',
  extract_facts: 'pulling details out of a document',
  resume_extraction: 'reading the rest of a document',
  read_notes: 'reading your notes',
  segment_document: 'finding the visits and sections in a document',
  rules_after_ingest: 'checking across the records',
  crossref: 'checking the records against each other',
  export_packet: 'building a packet',
  self_check: 'checking a document against itself',
};

/** The progress text without the document's title in front (the status bar names the document once). */
export function progressWithoutTitle(progressText: string | null | undefined, title: string | null | undefined): string {
  const text = progressText ?? '';
  if (!title) return text;
  const short = title.replace(/\s+/g, ' ').slice(0, 60);
  return text.startsWith(`${short}: `) ? text.slice(short.length + 2) : text;
}

/** How tall the "More below" bar is: what it covers counts as out of view. */
const MORE_BAR_PX = 30;

/**
 * The sidebar's entries out of view below its bottom edge (a short window hides Tools and the footer buttons): their
 * names, read again on scroll, resize, an appearance change (Large type) and a page change.
 */
export function useOutOfViewBelow(navRef: RefObject<HTMLElement | null>, key: unknown): string[] {
  const [names, setNames] = useState<string[]>([]);
  useEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    let frame = 0;
    const read = () => {
      frame = 0;
      const atEnd = nav.scrollTop + nav.clientHeight >= nav.scrollHeight - 2;
      const limit = nav.getBoundingClientRect().bottom - MORE_BAR_PX;
      const next = atEnd
        ? []
        : Array.from(nav.querySelectorAll<HTMLElement>('a[href], .nav-foot button'))
            .filter((el) => el.getBoundingClientRect().bottom > limit)
            .map((el) => (el.textContent ?? '').replace(/\d+\+?$/, '').trim())
            .filter(Boolean);
      setNames((prev) => (prev.join('|') === next.join('|') ? prev : next));
    };
    const soon = () => {
      if (!frame) frame = requestAnimationFrame(read);
    };
    read();
    nav.addEventListener('scroll', soon, { passive: true });
    window.addEventListener('casefile:appearance', soon);
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(soon);
    ro?.observe(nav);
    return () => {
      nav.removeEventListener('scroll', soon);
      window.removeEventListener('casefile:appearance', soon);
      ro?.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [navRef, key]);
  return names;
}

export function Shell({ children }: { children: ReactNode }) {
  const jobs = useActiveJobs();
  const settings = useSettings();
  const me = useMe();
  const pending = usePendingCounts().data;
  const active = jobs.data?.items ?? [];
  const running = active.filter((j) => j.status === 'running');
  const queued = active.filter((j) => j.status === 'queued');
  const aiOff = settings.data && !settings.data['ai.enabled'];
  const [dockOpen, setDockOpen] = useState<boolean>(() => readDockOpen());
  const [dockPreset, setDockPreset] = useState<string | null>(null);
  const navRef = useRef<HTMLElement>(null);
  const path = useRouterState({ select: (s) => s.location.pathname });
  const below = useOutOfViewBelow(navRef, path);

  // The page that is open is always in view in the sidebar, even when the window is short.
  useEffect(() => {
    navRef.current?.querySelector<HTMLElement>('a.active')?.scrollIntoView({ block: 'center' });
  }, [path]);

  useEffect(() => {
    const onDock = (e: Event) => {
      const d = (e as CustomEvent<DockEvent>).detail;
      const next = d.action === 'toggle' ? !dockOpen : d.action === 'open';
      writeDockOpen(next);
      setDockOpen(next);
      // A presetKey applies only to the opening that passed it; closing forgets it,
      // so a later plain open does not re-apply the last preset.
      setDockPreset(next ? (d.presetKey ?? null) : null);
    };
    window.addEventListener('casefile:dock', onDock);
    return () => window.removeEventListener('casefile:dock', onDock);
  }, [dockOpen]);

  return (
    <div className="shell" data-dock={dockOpen ? 'open' : 'closed'}>
      <nav className="nav" aria-label="Main" ref={navRef}>
        <div className="nav-brand">
          {APP_NAME}
          <small>{me.hosted ? 'Private: on your Railway server' : 'Private: stays on this computer'}</small>
        </div>
        <div className="nav-add">
          <AddDocumentsButton />
        </div>
        {NAV_GROUPS.map((g) => (
          <div key={g || 'top'}>
            {g ? (
              <div className="nav-group" role="heading" aria-level={2}>
                {g}
              </div>
            ) : null}
            {NAV.filter((n) => n.group === g).map((n) => {
              // Yellow counts: only what needs the user (documents not sorted yet, a source for a disagreement, uploads, findings).
              const count = n.pending && pending ? pending[n.pending] : 0;
              const words = `${count} ${n.pendingWords ?? 'waiting for you'}`;
              return (
                <Link
                  key={n.to}
                  to={n.to}
                  title={`${n.hint}${count ? ` ${words}.` : ''} (Keyboard: ${n.chord})`}
                  activeOptions={{ exact: n.to === '/' }}
                  activeProps={{ className: 'active' }}
                  className={count ? 'has-pending' : undefined}
                >
                  <span>{n.label}</span>
                  {count ? (
                    <span className="nav-count" aria-label={words}>
                      {count > 999 ? '999+' : count}
                    </span>
                  ) : null}
                </Link>
              );
            })}
          </div>
        ))}
        <div className="nav-spacer" />
        <div className="nav-foot">
          <button type="button" className="btn ghost sm" onClick={() => dock('toggle')} title="Open the clinician beside any page (keyboard: ctrl and .)">
            {dockOpen ? 'Hide the clinician panel' : 'Clinician beside this page'}
          </button>
          <button type="button" className="btn ghost sm" onClick={() => openPalette()} title="Jump to any page or action by typing (keyboard: ctrl and k)">
            Find a page or action
          </button>
          <button type="button" className="btn ghost sm" onClick={() => window.dispatchEvent(new KeyboardEvent('keydown', { key: '?' }))} title="Optional: every keyboard shortcut (keyboard: ?)">
            Keyboard shortcuts
          </button>
          <AccessLine />
        </div>
        {below.length ? (
          // A short window hides the last entries: say so, and scroll to them (the mouse wheel does the same).
          <button
            type="button"
            className="nav-more"
            title={`Out of view: ${below.join(', ')}`}
            onClick={() => navRef.current?.scrollTo({ top: navRef.current.scrollHeight, behavior: 'smooth' })}
          >
            More below ({below.length})
          </button>
        ) : null}
      </nav>
      <main className="main">{children}</main>
      <div className="statusbar">
        <span>
          {running.length ? (
            <>
              <span className="busy">Claude is {JOB_WORDS[running[0].type] ?? 'working'}</span>
              {running[0].documentTitle ? `: ${running[0].documentTitle}` : ''}
              {running.length > 1 ? `; ${running.length} things at once` : ''}
              {queued.length ? `, ${queued.length} more waiting` : ''}
            </>
          ) : queued.length ? (
            // With Claude switched off nothing starts "shortly"; the note on the right says why.
            aiOff ? `${queued.length} thing${queued.length === 1 ? '' : 's'} waiting` : `Claude will start on ${queued.length} thing${queued.length === 1 ? '' : 's'} shortly`
          ) : (
            'Claude is not working on anything'
          )}
        </span>
        {running[0] ? (
          <span className="truncate" style={{ maxWidth: 420 }}>
            {progressWithoutTitle(running[0].progressText, running[0].documentTitle)}
            {running[0].progress > 0 && running[0].progress < 1 ? ` ${Math.round(running[0].progress * 100)}%` : ''}
          </span>
        ) : null}
        <span className="grow" />
        {aiOff ? <span className="busy">Claude is switched off in Settings</span> : null}
        {me.hosted ? null : <span className={me.lan?.active ? 'busy' : undefined}>{me.lan?.active ? 'open to other devices at home' : 'this computer only'}</span>}
      </div>
      {dockOpen ? (
        <aside className="dock" aria-label="Consult">
          <ConsultDock onClose={() => dock('close')} presetKey={dockPreset} />
        </aside>
      ) : null}
      <GlobalDropZone />
    </div>
  );
}
