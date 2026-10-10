/** Open/close the consult dock from anywhere (Shell listens). */
export interface DockEvent {
  action: 'open' | 'close' | 'toggle';
  presetKey?: string;
  sessionId?: string;
}

export function dock(action: DockEvent['action'], extra: Omit<DockEvent, 'action'> = {}): void {
  window.dispatchEvent(new CustomEvent<DockEvent>('casefile:dock', { detail: { action, ...extra } }));
}

export function readDockOpen(): boolean {
  try {
    return localStorage.getItem('casefile.dock') === '1';
  } catch {
    return false;
  }
}

export function writeDockOpen(open: boolean): void {
  try {
    localStorage.setItem('casefile.dock', open ? '1' : '0');
  } catch {
    // ignore
  }
}
