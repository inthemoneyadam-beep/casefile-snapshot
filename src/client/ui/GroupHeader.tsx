/**
 * A group header outside a table (a list of cards, a timeline day, a stack of
 * scans): the group's name in the sans, semibold, and how many it holds.
 * Inside a GroupedList the list draws its own group rows the same way.
 *
 *   <GroupHeader title="CSF basic" count={9} noun={['test', 'tests']} />
 *   <GroupHeader title="2024-03-18" count={4} sub />
 */
import type { ReactNode } from 'react';

/** "9 tests", "1 test", or the bare number without a noun. */
export function countWords(count: number, noun?: string | readonly [string, string]): string {
  if (!noun) return String(count);
  const [one, many] = typeof noun === 'string' ? [noun, `${noun}s`] : noun;
  return `${count} ${count === 1 ? one : many}`;
}

export function GroupHeader({ title, count, noun, sub, actions, id }: { title: ReactNode; count?: number | null; noun?: string | readonly [string, string]; sub?: boolean; actions?: ReactNode; id?: string }) {
  return (
    <div className={sub ? 'group-title sub' : 'group-title'} id={id}>
      <span role="heading" aria-level={sub ? 4 : 3}>
        {title}
      </span>
      {count != null ? <span className="group-count">{countWords(count, noun)}</span> : null}
      {actions ? (
        <>
          <span className="grow" />
          {actions}
        </>
      ) : null}
    </div>
  );
}
