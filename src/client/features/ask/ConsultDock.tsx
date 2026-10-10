/**
 * The consult dock: the master-clinician conversation beside any screen.
 * Mounted by the Shell when open (ctrl+.). Remembers the current session in
 * localStorage, honours a presetKey passed with dock('open', { presetKey }),
 * and consumes `casefile:ask-prefill` events through the live.ts mailbox.
 *
 * Because the Shell imports this module at startup, the app-wide consult
 * commands are registered here at import time.
 */
import { useEffect, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { registerCommand } from '../../app/commands';
import { dock } from '../../app/dock';
import { isEditable } from '../../app/shortcuts';
import { useAskSessions } from '../../api/ask';
import { Button } from '../../ui/Button';
import { ConsultPanel, type ConsultPanelHandle } from './ConsultPanel';
import { NEW_SESSION_EVENT, prefill, readStoredSession, requestNewSession, writeStoredSession } from './live';
import './ask.css';

/** On the Ask page its own "New conversation" and "Ask with Master clinician" stand in for the panel's, so each shows once. */
const offTheAskPage = () => typeof location === 'undefined' || !(location.pathname === '/ask' || location.pathname.startsWith('/ask/'));

registerCommand({ id: 'ask.open', title: 'Ask the clinician', group: 'Ask', keywords: 'consult clinician dock question case', shortcut: 'ctrl+.', run: () => dock('open') });
registerCommand({
  id: 'ask.new-session',
  title: 'New conversation with the clinician',
  group: 'Ask',
  keywords: 'ask clinician reset conversation consult session',
  when: offTheAskPage,
  run: () => {
    requestNewSession();
    dock('open');
  },
});
registerCommand({ id: 'ask.master', title: 'Ask with Master clinician', group: 'Ask', keywords: 'deep fable max effort whole case', when: offTheAskPage, run: () => dock('open', { presetKey: 'master' }) });
registerCommand({
  id: 'ask.search',
  title: 'Ask the clinician to find something in the records',
  group: 'Ask',
  keywords: 'find where mentioned lookup directory search',
  run: () => {
    dock('open', { presetKey: 'quick' });
    prefill({ text: '', mode: 'search' });
  },
});

export function ConsultDock({ onClose, presetKey }: { onClose: () => void; presetKey?: string | null }) {
  const [sessionId, setSessionId] = useState<string | null>(() => readStoredSession());
  const sessions = useAskSessions();
  const panel = useRef<ConsultPanelHandle>(null);

  const changeSession = (id: string | null) => {
    writeStoredSession(id);
    setSessionId(id);
  };
  useEffect(() => {
    const onNew = () => setSessionId(null);
    window.addEventListener(NEW_SESSION_EVENT, onNew);
    return () => window.removeEventListener(NEW_SESSION_EVENT, onNew);
  }, []);
  // A remembered session that no longer exists is dropped.
  useEffect(() => {
    if (sessionId && sessions.data && !sessions.data.items.some((s) => s.id === sessionId)) changeSession(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions.data, sessionId]);

  const items = sessions.data?.items ?? [];

  return (
    <div
      className="dock-body"
      onKeyDown={(e) => {
        if (isEditable(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
        if (e.key === '[' || e.key === ']') {
          e.preventDefault();
          panel.current?.moveSlider(e.key === ']' ? 1 : -1);
        }
      }}
    >
      <div className="dock-head">
        <span className="serif">Clinician</span>
        <select aria-label="Conversation" value={sessionId ?? ''} onChange={(e) => changeSession(e.target.value || null)} className="dock-session">
          <option value="">New conversation</option>
          {items.map((s) => (
            <option key={s.id} value={s.id}>
              {s.title}
            </option>
          ))}
        </select>
        <Button size="sm" variant="ghost" onClick={() => panel.current?.newSession()} title="Start a new conversation (the question box gets the cursor)">
          New
        </Button>
        <Link to="/ask" search={{ session: sessionId ?? undefined }} className="btn ghost sm" title="Open this conversation on the Ask the clinician page">
          Full page
        </Link>
        <Button size="sm" variant="ghost" onClick={onClose} title="Close the clinician panel (ctrl+.)">
          Close
        </Button>
      </div>
      <ConsultPanel ref={panel} compact sessionId={sessionId} onSessionChange={changeSession} presetKey={presetKey} />
    </div>
  );
}
