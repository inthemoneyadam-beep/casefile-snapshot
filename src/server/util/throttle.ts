/**
 * Passphrase throttling for the hosted server (unlock, setup and restore; src/server/auth.ts). Failures are counted
 * per client address over a sliding window, and across all clients with a higher global cap (the per-address count
 * can be dodged by a forged X-Forwarded-For hop or many addresses; the global cap cannot). While either is full the
 * request is answered 429 before any passphrase is checked. A success clears that address's failures.
 * In memory only: a restart (which also locks the case) starts the counts again.
 */
export interface ThrottleOptions {
  /** Failures one address may have inside the window. */
  perClient: number;
  /** Failures all addresses together may have inside the window. */
  global: number;
  windowMs: number;
}

export const DEFAULT_THROTTLE: ThrottleOptions = { perClient: 5, global: 30, windowMs: 15 * 60_000 };

export interface ThrottleVerdict {
  ok: boolean;
  /** Seconds until a try is allowed again (0 when ok). */
  retryAfterSeconds: number;
  /** Which limit is full. */
  scope: 'client' | 'global' | null;
}

export class Throttle {
  private readonly byClient = new Map<string, number[]>();
  private all: number[] = [];

  constructor(private readonly opts: ThrottleOptions = DEFAULT_THROTTLE) {}

  private prune(list: number[], now: number): number[] {
    const from = now - this.opts.windowMs;
    let i = 0;
    while (i < list.length && list[i] <= from) i++;
    return i ? list.slice(i) : list;
  }

  /** Whether `client` may try now. */
  check(client: string, now = Date.now()): ThrottleVerdict {
    this.all = this.prune(this.all, now);
    const mine = this.prune(this.byClient.get(client) ?? [], now);
    if (mine.length) this.byClient.set(client, mine);
    else this.byClient.delete(client);
    if (mine.length >= this.opts.perClient) {
      const until = mine[mine.length - this.opts.perClient] + this.opts.windowMs;
      return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((until - now) / 1000)), scope: 'client' };
    }
    if (this.all.length >= this.opts.global) {
      const until = this.all[this.all.length - this.opts.global] + this.opts.windowMs;
      return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((until - now) / 1000)), scope: 'global' };
    }
    return { ok: true, retryAfterSeconds: 0, scope: null };
  }

  failure(client: string, now = Date.now()): { client: number; global: number } {
    const mine = this.prune(this.byClient.get(client) ?? [], now);
    mine.push(now);
    this.byClient.set(client, mine);
    this.all = this.prune(this.all, now);
    this.all.push(now);
    // Bounded memory under a flood of forged addresses: the oldest addresses go first.
    if (this.byClient.size > 10_000) {
      const first = this.byClient.keys().next().value;
      if (first !== undefined) this.byClient.delete(first);
    }
    return { client: mine.length, global: this.all.length };
  }

  success(client: string): void {
    this.byClient.delete(client);
  }

  reset(): void {
    this.byClient.clear();
    this.all = [];
  }
}

/** "Wait 12 minutes" / "Wait 40 seconds". */
export function waitWords(seconds: number): string {
  if (seconds >= 90) {
    const m = Math.ceil(seconds / 60);
    return `Wait ${m} minutes`;
  }
  return `Wait ${seconds} second${seconds === 1 ? '' : 's'}`;
}
