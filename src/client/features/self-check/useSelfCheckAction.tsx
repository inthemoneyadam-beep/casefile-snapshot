/**
 * "Check it against itself" for one document (2026-10-09): the More entry, its key (a), its palette command and the
 * dialog that shows the cost first. Used by the document pane (Documents) and the full-page document view.
 */
import { useState, type ReactNode } from 'react';
import type { Action } from '../../ui/Menu';
import { useBindings } from '../../app/shortcuts';
import { useRegisterCommands } from '../../app/commands';
import { CheckDialog } from './CheckDialog';
import { SELF_CHECK_KEY, SELF_CHECK_LABEL, SELF_CHECK_TITLE } from './words';

export function useSelfCheckAction(documentId: string, opts: { enabled: boolean; keys?: boolean }): { item: Action | null; dialog: ReactNode; open: () => void } {
  const [open, setOpen] = useState(false);
  const can = opts.enabled;
  const keys = opts.keys ?? true;
  const openIt = () => {
    if (can) setOpen(true);
  };
  useBindings(keys ? [{ keys: SELF_CHECK_KEY, description: `${SELF_CHECK_LABEL}: lab flags and contradictions in this document (shows the cost first)`, group: 'Documents', when: () => can && !open, run: openIt }] : [], [documentId, can, open, keys]);
  useRegisterCommands(
    [{ id: 'documents.selfCheck', title: `Documents: ${SELF_CHECK_LABEL.toLowerCase()} (lab flags, contradictions; cost shown first)`, group: 'Documents', shortcut: keys ? SELF_CHECK_KEY : undefined, keywords: 'self check contradiction contradicts flag wrong low high itself onboarding facility', when: () => can, run: openIt }],
    [documentId, can, keys],
  );
  return {
    item: can ? { label: `${SELF_CHECK_LABEL}…`, onClick: openIt, shortcut: keys ? SELF_CHECK_KEY : undefined, title: SELF_CHECK_TITLE } : null,
    dialog: open ? <CheckDialog open={open} onClose={() => setOpen(false)} documentIds={[documentId]} /> : null,
    open: openIt,
  };
}
