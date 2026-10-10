/**
 * After too many wrong tries the server answers 429 with how long to wait (unlock, setup, restore). `block(err)`
 * takes such an answer and returns true; until the wait is over `waiting` is true and `message` says how long is
 * left, counting down, so the form disables its button and shows one plain line.
 */
import { useCallback, useEffect, useState } from 'react';
import { throttleSeconds, waitWords } from './restoreWords';

export function useThrottle(): { waiting: boolean; message: string | null; block: (err: unknown) => boolean } {
  const [until, setUntil] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (until == null) return;
    const tick = () => {
      const t = Date.now();
      setNow(t);
      if (t >= until) setUntil(null);
    };
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [until]);

  const block = useCallback((err: unknown) => {
    const s = throttleSeconds(err);
    if (s == null) return false;
    const t = Date.now();
    setNow(t);
    setUntil(t + s * 1000);
    return true;
  }, []);

  const left = until == null ? 0 : Math.max(0, (until - now) / 1000);
  return { waiting: left > 0, message: left > 0 ? waitWords(left) : null, block };
}
