/**
 * Small browser helpers the pages shared by copying (sweep 2026-10-07): whether a dialog is open, the synthetic `j`
 * that moves a list on after an action, and whether a drag carries files.
 */

/** True while a dialog is open, so a page's own keys stand down; false outside a browser. */
export function dialogOpen(): boolean {
  return typeof document !== 'undefined' && Boolean(document.querySelector('dialog[open]'));
}

/**
 * Move the list table inside `container` to its next row after acting on the current one: the table's own `j`
 * (a keydown on its .table-wrap), so the sort and filter the user chose are kept. Nothing happens without a table.
 */
export function moveToNextRow(container: ParentNode | null | undefined): void {
  const wrap = container?.querySelector<HTMLElement>('.table-wrap');
  if (!wrap) return;
  wrap.focus();
  wrap.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true }));
}

/** True when a drag carries files (not text or a link). Takes a DOM or a React drag event. */
export function hasFiles(e: { dataTransfer?: DataTransfer | null }): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes('Files');
}
