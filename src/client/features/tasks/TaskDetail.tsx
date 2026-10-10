import { Link } from '@tanstack/react-router';
import { todayIso } from '@shared/dates';
import { Tag } from '../../ui/StatusTag';
import { DateText, DateTimeText } from '../../ui/DateText';
import { DetailHeader, DetailPane, type KeyFact } from '../../ui/DetailPane';
import { Section } from '../../ui/PageHeader';
import type { ActionBarProps } from '../../ui/ActionBar';
import type { Task } from '../../api/tasks';
import { PRIORITY_TONE, SOURCE_LONG, dueWords, isOpenTask, reminderWords, taskOwnerWords, taskStatusWords } from './words';

export interface TaskDetailProps {
  task: Task;
  busy?: boolean;
  onToggleDone: () => void;
  onSnooze: (days: number) => void;
  onEdit: () => void;
  onOpenSource: () => void;
  onDelete: () => void;
  onCalendar: () => void;
}

/**
 * The pane's actions. To do: Mark done (the one main action), Snooze a week and Edit; under More where it came from
 * (also the link under "Came from"), a one-day snooze, the calendar and Delete. Done: Reopen and Edit.
 */
export function taskActions(t: Pick<Task, 'status' | 'sourceHref' | 'dueAt'>, p: Omit<TaskDetailProps, 'task'>): ActionBarProps {
  const open = isOpenTask(t);
  const source = t.sourceHref ? { label: 'Open where it came from', onClick: p.onOpenSource, shortcut: 'o', disabled: p.busy, title: 'The call, appointment, document or detail this to-do came from' } : null;
  const calendar = t.dueAt ? { label: 'Export to my calendar', onClick: p.onCalendar, disabled: p.busy, title: 'Saves a calendar file of this to-do, to open in your calendar app' } : null;
  const del = { label: 'Delete…', onClick: p.onDelete, shortcut: 'Delete', danger: true, disabled: p.busy, title: 'Hide this to-do (asks first; it is not erased)' };
  const edit = { label: 'Edit', onClick: p.onEdit, shortcut: 'e', disabled: p.busy, title: 'Change what, who, when or the reminder' };
  if (open)
    return {
      primary: { label: 'Mark done', onClick: p.onToggleDone, shortcut: 'x', disabled: p.busy },
      secondary: [{ label: 'Snooze a week', onClick: () => p.onSnooze(7), shortcut: 'z', disabled: p.busy, title: 'Move the due date 7 days later' }, edit],
      more: [source, { label: 'Snooze a day', onClick: () => p.onSnooze(1), disabled: p.busy, title: 'Move the due date to tomorrow' }, calendar, 'separator', del],
    };
  return {
    secondary: [{ label: 'Reopen', onClick: p.onToggleDone, shortcut: 'x', disabled: p.busy, title: 'It is not done after all' }, edit],
    more: [source, calendar, 'separator', del],
  };
}

/** Who, when and where from: only what is filled in. */
export function taskFacts(t: Task): KeyFact[] {
  const out: KeyFact[] = [];
  out.push({
    label: 'Who',
    value:
      t.ownerPersonId ? (
        <Link to="/people" search={{ id: t.ownerPersonId }}>
          {taskOwnerWords(t)}
        </Link>
      ) : (
        taskOwnerWords(t)
      ),
  });
  if (t.dueAt) out.push({ label: 'Due', value: <DateText iso={t.dueAt} />, mono: true });
  const reminder = reminderWords(t.remindAt);
  if (reminder) out.push({ label: 'Reminder', value: reminder, mono: true });
  if (t.completedAt) out.push({ label: t.status === 'cancelled' ? 'Cancelled' : 'Done', value: <DateTimeText iso={t.completedAt} />, mono: true });
  // A manual to-do can still carry a source: "Make a to-do" on a consult answer stores the answer's id.
  if (t.sourceType !== 'manual' || t.sourceId) {
    const kind = t.sourceType === 'manual' ? null : SOURCE_LONG[t.sourceType] ?? t.sourceType.replace(/_/g, ' ');
    const name = t.sourceTitle ?? (kind ? null : 'Where it came from');
    out.push({
      label: 'Came from',
      wide: true,
      value: t.sourceHref ? (
        // sourceHref is a page held as a string, so the router cannot type it: the cast stays.
        <Link to={t.sourceHref as never}>
          {kind ? <span className="muted">{kind}{name ? ': ' : ''}</span> : null}
          {name}
        </Link>
      ) : (
        <span>
          {kind ?? 'Not on file any more'}
          {name && kind ? `: ${name}` : ''}
        </span>
      ),
    });
  }
  return out;
}

/**
 * Right pane of /tasks: one to-do. Eyebrow, the title, one status line (when
 * it is due, where it stands, its priority), the actions, who owes it, when,
 * and where it came from, then the detail.
 */
export function TaskDetail(props: TaskDetailProps) {
  const { task } = props;
  const open = isOpenTask(task);
  const due = dueWords(task.dueAt, todayIso(), open);
  return (
    <DetailPane label="To-do">
      <DetailHeader
        eyebrow={<span>To-do</span>}
        title={task.title}
        status={[
          task.dueAt ? (
            <span key="due">
              due <DateText iso={task.dueAt} />
            </span>
          ) : (
            'No due date'
          ),
          due && due !== 'due today' && due !== 'due tomorrow' && !task.overdue ? due.replace(/^due /, '') : null,
          task.overdue ? (
            <Tag key="overdue" tone="bad">
              {due && /overdue/.test(due) ? due : 'overdue'}
            </Tag>
          ) : due === 'due today' || due === 'due tomorrow' ? (
            <Tag key="soon" tone="warn">
              {due}
            </Tag>
          ) : null,
          <Tag key="status" tone={open ? (task.status === 'in_progress' ? 'info' : 'neutral') : task.status === 'done' ? 'ok' : 'ash'}>
            {taskStatusWords(task.status)}
          </Tag>,
          task.priority === 'high' || task.priority === 'urgent' ? (
            <Tag key="prio" tone={PRIORITY_TONE[task.priority]}>
              {task.priority}
            </Tag>
          ) : null,
        ]}
        actions={taskActions(task, props)}
        facts={taskFacts(task)}
      />
      {task.detail ? (
        <Section title="Detail">
          <div className="tk-detail-text">{task.detail}</div>
        </Section>
      ) : null}
      <p className="tk-stamp">
        Added <DateTimeText iso={task.createdAt} />
        {task.updatedAt && task.updatedAt.slice(0, 16) !== task.createdAt.slice(0, 16) ? (
          <>
            {' '}
            · changed <DateTimeText iso={task.updatedAt} />
          </>
        ) : null}
      </p>
    </DetailPane>
  );
}
