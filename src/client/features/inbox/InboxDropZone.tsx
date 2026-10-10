/**
 * The drop area of Check before filing. Handles its own drops (data-own-drop keeps the global overlay away); click,
 * Enter or Space open the page's file picker. Pasting anywhere on the page is handled by the route's window listener.
 * `compact`: one quiet line above the list once uploads are waiting; otherwise a calm box under the empty state.
 */
import { useState, type DragEvent } from 'react';
import { INBOX_NAME } from './words';

export function InboxDropZone({ busy, onFiles, onPick, compact = false }: { busy: boolean; onFiles: (files: File[]) => void; onPick: () => void; compact?: boolean }) {
  const [over, setOver] = useState(false);

  function onDragOver(e: DragEvent<HTMLDivElement>) {
    if (!Array.from(e.dataTransfer.types).includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    if (!over) setOver(true);
  }
  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setOver(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length) onFiles(files);
  }

  const lead = busy ? 'Adding…' : over ? 'Drop to add it here' : compact ? 'Drop files here to check them before filing' : 'Drop files here';
  return (
    <div
      className={`inbox-drop${compact ? ' compact' : ''}${over ? ' over' : ''}`}
      data-own-drop
      tabIndex={0}
      role="button"
      aria-label={`Add files to ${INBOX_NAME}`}
      title="Click (or Enter) to choose files from this computer"
      onDragOver={onDragOver}
      onDragEnter={onDragOver}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target || !e.currentTarget.contains(e.relatedTarget as Node)) setOver(false);
      }}
      onDrop={onDrop}
      onClick={() => !busy && onPick()}
      onKeyDown={(e) => {
        if ((e.key === 'Enter' || e.key === ' ') && !busy) {
          e.preventDefault();
          onPick();
        }
      }}
    >
      <span className="lead">{lead}</span>
      <span className="inbox-drop-hint">{compact ? 'or click to choose them; Ctrl+V pastes anywhere on this page' : 'or click here to choose them. Ctrl+V pastes text or a file anywhere on this page. Nothing is filed until you press File it, and nothing is ever deleted.'}</span>
    </div>
  );
}
