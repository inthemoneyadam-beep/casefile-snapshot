/**
 * Idle lock support. The server resets its idle timer on every write, but on
 * a read only when the browser says a person touched the keyboard, mouse,
 * wheel or screen within the last minute (header `x-casefile-active: 1`,
 * see countsAsActivity in src/server/auth.ts). The shell polls job status
 * every few seconds; without this those polls would keep an unattended case
 * unlocked for as long as the tab stays on screen.
 *
 * installActivityTracking() is called once from main.tsx. It listens for
 * input passively and adds the header to same-origin /api requests made
 * through the global fetch (api/client.ts and streamPost both use it), so
 * no caller has to remember it.
 */
import { ACTIVITY_HEADER, inputIsRecent, isApiUrl } from '../../shared/activity';

export { ACTIVITY_HEADER, isApiUrl };

const INPUT_EVENTS = ['keydown', 'pointerdown', 'pointermove', 'wheel', 'touchstart'] as const;

type FetchFn = typeof fetch;
type FetchInput = Parameters<FetchFn>[0];

/** The parts of `window` this module uses. */
interface ActivityHost {
  addEventListener(type: string, listener: () => void, options: { capture: boolean; passive: boolean }): void;
  fetch: FetchFn;
  location: { href: string };
}

let lastInputAt = 0;
let installed = false;

export function markInput(now = Date.now()): void {
  lastInputAt = now;
}

/** True when a person gave input within the activity window. */
export function recentInput(now = Date.now()): boolean {
  return inputIsRecent(lastInputAt, now);
}

export function installActivityTracking(host: ActivityHost = globalThis as unknown as ActivityHost): void {
  if (installed) return;
  installed = true;
  // Opening or reloading the app is itself something a person did.
  markInput();
  const onInput = () => markInput();
  for (const type of INPUT_EVENTS) host.addEventListener(type, onInput, { capture: true, passive: true });
  const original = host.fetch.bind(host);
  host.fetch = ((input: FetchInput, init?: Parameters<FetchFn>[1]) => {
    if (!recentInput() || !isApiUrl(input, host.location.href)) return original(input, init);
    const headers = new Headers(init?.headers);
    headers.set(ACTIVITY_HEADER, '1');
    return original(input, { ...init, headers });
  }) as FetchFn;
}
