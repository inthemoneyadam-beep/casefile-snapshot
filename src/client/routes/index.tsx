/**
 * Home: where the case stands today, in the order you act on it.
 *
 *   Never give            the substances never to give (when any), first
 *   Waiting for you       full width: each line with its one button; then, calm
 *                         and apart, what is only for your information
 *   Coming up | Recently added   side by side (stacked in a narrow window)
 *   Ask the clinician     a question box; the clinician opens beside the page
 *   Add documents         a slim strip (drop anywhere on the window, or choose)
 *
 * The page has no header button: "Add documents" is in the sidebar and in the
 * strip, and every waiting line carries its own action. Keys: j / k move the
 * focus through the rows and their buttons (Enter opens or presses), Esc
 * leaves them; / goes to the question box; n chooses documents to add.
 */
import { useRef } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useRegisterCommands } from '../app/commands';
import { useBindings } from '../app/shortcuts';
import { useMe } from '../api/users';
import { PageHeader } from '../ui/PageHeader';
import { ToolbarKeys } from '../ui/Toolbar';
import { ASK_BOX_ID, AskBox, ComingUpSection, DropStrip, NeverGive, RecentSection, WaitingSection, todayOf, useToday } from '../features/home/HomeSections';
import { nextRow } from '../features/home/words';
import '../features/home/home.css';

export const Route = createFileRoute('/')({ component: Home });

function longDate(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(`${iso}T12:00:00`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

/** The rows (and the buttons in them) that j / k move through, in page order; only those on screen. */
function homeRows(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLElement>('[data-home-row]')).filter((el) => !(el as HTMLButtonElement).disabled && el.offsetParent !== null);
}

function Home() {
  const today = useToday();
  const canWrite = useMe().canWrite;
  const body = useRef<HTMLDivElement>(null);

  function move(delta: number) {
    const rows = homeRows(body.current);
    const at = rows.indexOf(document.activeElement as HTMLElement);
    const next = nextRow(rows.length, at, delta);
    if (next >= 0) {
      rows[next].focus();
      rows[next].scrollIntoView({ block: 'nearest' });
    }
  }
  const focusAsk = () => document.getElementById(ASK_BOX_ID)?.focus();
  const chooseFiles = () => body.current?.querySelector<HTMLButtonElement>('.home-drop .btn')?.click();
  const inRows = () => Boolean(document.activeElement && body.current?.contains(document.activeElement) && (document.activeElement as HTMLElement).hasAttribute('data-home-row'));

  useBindings(
    [
      { keys: 'j', description: 'Next item on Home', group: 'Lists', run: () => move(1) },
      { keys: 'k', description: 'Previous item on Home', group: 'Lists', run: () => move(-1) },
      { keys: 'esc', description: 'Leave the list', group: 'Lists', when: inRows, run: () => (document.activeElement as HTMLElement | null)?.blur() },
      { keys: '/', description: 'Write a question to the clinician', group: 'Page', run: focusAsk },
      ...(canWrite ? [{ keys: 'n', description: 'Add documents (choose files)', group: 'Page', run: chooseFiles }] : []),
    ],
    [canWrite],
  );
  useRegisterCommands(
    [
      { id: 'home.ask', title: 'Home: write a question to the clinician', group: 'Page', keywords: 'ask clinician question consult', shortcut: '/', run: focusAsk },
      ...(canWrite ? [{ id: 'home.add', title: 'Home: add documents', group: 'Page', keywords: 'upload files pdf scan', shortcut: 'n', run: chooseFiles }] : []),
    ],
    [canWrite],
  );

  const t = today.data;
  return (
    <div className="page home-page">
      <PageHeader
        title="Home"
        meta={t ? longDate(t.date) : null}
        intro="What needs you, what is coming up and what was added last. Ask the clinician anything about the case."
        actions={<ToolbarKeys items={[['j/k', 'move'], ['enter', 'open'], ['/', 'ask'], canWrite ? ['n', 'add documents'] : null]} />}
      />
      <div className="page-body home" ref={body}>
        <NeverGive items={t?.hardStops ?? []} />
        <WaitingSection />
        <div className="home-cols">
          <ComingUpSection today={today} />
          <RecentSection today={todayOf(t)} />
        </div>
        <AskBox />
        <DropStrip />
      </div>
    </div>
  );
}
