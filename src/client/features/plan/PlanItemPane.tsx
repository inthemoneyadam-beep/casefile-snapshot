/**
 * Right pane of the Plan page's Framework, Checklist and Timeline tabs: one item of the plan. Where it stands on the
 * checklist (done, skipped, doesn't apply, by whom and when), who and when as the plan says, the condition, what a
 * person changed beside the plan's wording ("As written: ..."), the passages it came from (found on the page or not),
 * its branches or the items under it, a linked to-do, and an item of the earlier plan that looks the same.
 */
import { Link } from '@tanstack/react-router';
import type { ActionBarProps } from '../../ui/ActionBar';
import { DetailHeader, DetailPane, type KeyFact } from '../../ui/DetailPane';
import { Section } from '../../ui/PageHeader';
import { Tag, TaskStatusTag } from '../../ui/StatusTag';
import { Button } from '../../ui/Button';
import { DateText } from '../../ui/DateText';
import type { PlanItem } from '../../api/plans';
import { planItemStatusWords } from '@shared/plan';
import { STATUS_BUTTON_WORDS, STATUS_KEYS, asWrittenLines, doneWords, itemLine, statusTone, whenWords } from './words';

export interface PlanItemPaneProps {
  item: PlanItem;
  byId: Map<string, PlanItem>;
  canWrite: boolean;
  busy: boolean;
  onStatus: (status: 'done' | 'skipped' | 'not_applicable') => void;
  onEdit: () => void;
  onTodo: () => void;
  onShowOriginal: (citationIndex: number) => void;
  onSelect: (id: string) => void;
  onMarkSame: () => void;
}

/** The pane's actions: the status buttons for an item to check off, then Edit, Make a to-do and the original. */
export function itemActions(it: PlanItem, p: Omit<PlanItemPaneProps, 'item' | 'byId'>): ActionBarProps {
  const show = it.citations.length ? { label: 'Show in the original', onClick: () => p.onShowOriginal(0), shortcut: 'o', title: 'The passage of the plan this item came from, marked' } : null;
  if (!p.canWrite) return { secondary: [show] };
  const edit = { label: 'Edit', onClick: p.onEdit, shortcut: 'e', disabled: p.busy, title: 'Change the words, who or when; the plan’s own wording is kept beside them' };
  const todo = it.task ? null : { label: 'Make a to-do', onClick: p.onTodo, shortcut: 't', disabled: p.busy, title: 'Put it on the To-do list, linked to this item' };
  if (!it.actionable) return { secondary: [edit, todo], more: [show] };
  if (it.status === 'open') {
    return {
      primary: { label: STATUS_BUTTON_WORDS.done, onClick: () => p.onStatus('done'), shortcut: STATUS_KEYS.done, disabled: p.busy, title: 'Mark it done' },
      secondary: [
        { label: STATUS_BUTTON_WORDS.skipped, onClick: () => p.onStatus('skipped'), shortcut: STATUS_KEYS.skipped, disabled: p.busy, title: 'It was not done, on purpose' },
        { label: STATUS_BUTTON_WORDS.not_applicable, onClick: () => p.onStatus('not_applicable'), shortcut: STATUS_KEYS.not_applicable, disabled: p.busy, title: 'It does not apply this time' },
      ],
      more: [edit, todo, show],
    };
  }
  const key = it.status === 'done' ? 'done' : it.status === 'skipped' ? 'skipped' : 'not_applicable';
  return {
    secondary: [{ label: 'Back to do', onClick: () => p.onStatus(key), shortcut: STATUS_KEYS[key], disabled: p.busy, title: 'It still needs doing' }, edit],
    more: [todo, show],
  };
}

function facts(it: PlanItem, byId: Map<string, PlanItem>): KeyFact[] {
  const out: KeyFact[] = [];
  if (it.owner) out.push({ label: 'Who', value: it.owner });
  const when = whenWords(it);
  if (when) out.push({ label: 'When', value: it.due && it.dueText ? <span>{it.dueText} <span className="muted">(<DateText iso={it.due} precision={it.duePrecision} />)</span></span> : when });
  if (it.condition) out.push({ label: 'When it applies', value: it.condition, wide: true });
  const parent = it.parentId ? byId.get(it.parentId) : undefined;
  if (parent) out.push({ label: parent.kind === 'decision' ? 'Branch of' : 'Under', value: parent.title, wide: true });
  if (it.task) {
    out.push({
      label: 'To-do',
      wide: true,
      value: (
        <span>
          <Link to="/tasks" search={{ id: it.task.id }}>
            {it.task.title}
          </Link>{' '}
          <TaskStatusTag status={it.task.status} />
        </span>
      ),
    });
  }
  return out;
}

export function PlanItemPane(props: PlanItemPaneProps) {
  const { item: it, byId } = props;
  const parent = it.parentId ? byId.get(it.parentId) : undefined;
  const children = it.childIds.map((id) => byId.get(id)).filter((x): x is PlanItem => Boolean(x));
  const asWritten = asWrittenLines(it);
  const done = doneWords(it);
  return (
    <DetailPane label="Plan item">
      <DetailHeader
        eyebrow={
          <span>
            {it.kindWords}
            {it.sectionTitle ? <span className="muted"> · {it.sectionTitle}</span> : null}
          </span>
        }
        title={itemLine(it, parent?.kind)}
        status={[
          it.actionable ? (
            <Tag key="s" tone={statusTone(it.status)}>
              {planItemStatusWords(it.status)}
            </Tag>
          ) : (
            <span key="s" className="muted">
              not something to check off
            </span>
          ),
          done ? (
            <span key="d" className="muted">
              {done}
            </span>
          ) : null,
          it.userFields.length ? (
            <Tag key="e" tone="info" title="You changed this item; the plan’s own wording is kept below">
              changed by you
            </Tag>
          ) : null,
        ]}
        actions={itemActions(it, props)}
        facts={facts(it, byId)}
      />
      {asWritten.length ? (
        <div className="plan-as-written">
          {asWritten.map((l) => (
            <p key={l}>{l}</p>
          ))}
        </div>
      ) : null}
      {it.detail ? (
        <Section title="From the plan">
          <p className="plan-detail-text">{it.detail}</p>
        </Section>
      ) : null}
      {it.note ? (
        <Section title="Note">
          <p className="plan-detail-text">{it.note}</p>
        </Section>
      ) : null}
      {it.looksLike && it.status === 'open' ? (
        <Section title="In the earlier plan">
          <p className="plan-detail-text">
            Looks the same as “{it.looksLike.title}”, {planItemStatusWords(it.looksLike.status)}
            {it.looksLike.doneAt ? ` ${it.looksLike.doneAt.slice(0, 10)}` : ''}
            {it.looksLike.doneBy ? ` by ${it.looksLike.doneBy}` : ''}.
          </p>
          {props.canWrite ? (
            <div className="row">
              <Button size="sm" variant="accent" onClick={props.onMarkSame} disabled={props.busy} shortcut="m">
                Mark it the same
              </Button>
            </div>
          ) : null}
        </Section>
      ) : null}
      {it.carriedFrom ? (
        <p className="muted small plan-carried">
          Marked from the earlier plan{it.carriedFrom.title ? `: “${it.carriedFrom.title}”` : ''}
          {it.carriedFrom.note ? `. Its note: ${it.carriedFrom.note}` : ''}.
        </p>
      ) : null}
      {children.length ? (
        <Section title={it.kind === 'decision' ? 'Branches' : 'Under this'} count={children.length}>
          <ul className="plan-children">
            {children.map((c) => (
              <li key={c.id}>
                <button type="button" className="plan-link" onClick={() => props.onSelect(c.id)}>
                  {itemLine(c, it.kind)}
                </button>
                {c.actionable ? (
                  <span className="muted small"> · {planItemStatusWords(c.status)}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      <Section title="Where the plan says it" count={it.citations.length || undefined}>
        {it.citations.length ? (
          <ul className="plan-cites">
            {it.citations.map((c, i) => (
              <li key={i}>
                <span className="mono small">p.{c.page}</span> <span className="plan-quote">“{c.quote}”</span>{' '}
                {c.verified ? (
                  <Tag tone="ok" title="The quote was found on that page">
                    found on the page
                  </Tag>
                ) : (
                  <Tag tone="warn" title="The quote was not found on that page word for word; it is kept and marked">
                    not found on the page
                  </Tag>
                )}{' '}
                <Button size="sm" variant="ghost" onClick={() => props.onShowOriginal(i)}>
                  Show
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted small">Claude gave no passage for this item.</p>
        )}
      </Section>
    </DetailPane>
  );
}
