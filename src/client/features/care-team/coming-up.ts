/**
 * Home, "Coming up" (2026-10-09, the user's request 6; lead's correction 4): the open to-dos linked to a Care team
 * candidate (with the candidate's name and the due date) and the next booked flare-test call ("Flare-test call with
 * <name>, <day time>"). Selecting either opens the candidate. Merged into Home's own list (features/home/words.ts
 * comingUp): a care-team to-do already there by its due date is shown once, as the care-team line.
 */
import type { ComingUpItem } from '../home/words';
import type { CareComingUp } from '../../api/care-team';

export const CARE_TODO_KIND = 'Care team follow-up';
export const CARE_CALL_KIND = 'Flare-test call';

/** Home's items with the care team's added, in date order (no date last). */
export function withCareTeam(items: readonly ComingUpItem[], care: CareComingUp | null | undefined): ComingUpItem[] {
  if (!care) return [...items];
  const taskIds = new Set(care.tasks.map((t) => `t-${t.id}`));
  const added: ComingUpItem[] = [
    ...care.tasks.map((t) => ({
      id: `ct-${t.id}`,
      date: t.dueAt,
      precision: 'day',
      what: t.title,
      who: t.candidateName,
      kind: CARE_TODO_KIND,
      to: '/care-team',
      search: { id: t.candidateId },
      late: t.overdue ? 'overdue' : null,
    })),
    ...(care.nextCall
      ? [
          {
            id: `cc-${care.nextCall.candidateId}`,
            date: care.nextCall.at.value,
            precision: care.nextCall.at.precision,
            what: care.nextCall.words,
            who: '',
            kind: CARE_CALL_KIND,
            to: '/care-team',
            search: { id: care.nextCall.candidateId },
            late: null,
          },
        ]
      : []),
  ];
  return [...items.filter((x) => !taskIds.has(x.id)), ...added].sort((a, b) => (a.date ?? '9999').localeCompare(b.date ?? '9999'));
}
