/**
 * /api/tasks — tasks, reminders, the daily plan, and the iCalendar export.
 * Business logic is in services/tasks.ts; this file parses requests and
 * shapes responses. Static paths come before /:id.
 */
import { Hono, type Context } from 'hono';
import {
  completeTask,
  createTask,
  dailyPlan,
  deleteTask,
  getTask,
  listTasks,
  reopenTask,
  snoozeTask,
  taskCalendar,
  taskCounts,
  tasksCalendar,
  tasksFromFollowUps,
  tasksFromGaps,
  updateTask,
} from '../services/tasks';
import { badRequest } from '../util/errors';

/** JSON body or 400; the services validate the shape with zod. */
async function body(c: Context): Promise<unknown> {
  const b = await c.req.json().catch(() => undefined);
  if (b === undefined || b === null || typeof b !== 'object') throw badRequest('expected a JSON object body');
  return b;
}

async function optionalBody(c: Context): Promise<unknown> {
  const b = await c.req.json().catch(() => ({}));
  return b && typeof b === 'object' ? b : {};
}

function calendar(c: Context, text: string, filename: string) {
  return c.body(text, 200, {
    'content-type': 'text/calendar; charset=utf-8',
    'content-disposition': `attachment; filename="${filename}"`,
    'cache-control': 'no-store',
  });
}

export const tasksRoutes = new Hono()
  .get('/', (c) => {
    const items = listTasks(c.req.query());
    return c.json({ items, total: items.length });
  })
  .get('/counts', (c) => c.json(taskCounts()))
  .get('/ics', (c) => calendar(c, tasksCalendar(c.req.query()), 'casefile-tasks.ics'))
  .get('/daily-plan', (c) => c.json(dailyPlan(c.req.query('date'))))
  .post('/from-follow-ups', (c) => {
    const r = tasksFromFollowUps();
    return c.json({ ...r, total: r.created.length });
  })
  .post('/from-gaps', (c) => {
    const r = tasksFromGaps();
    return c.json({ ...r, total: r.created.length });
  })
  .post('/', async (c) => c.json(createTask(await body(c)), 201))
  .get('/:id', (c) => c.json(getTask(c.req.param('id'))))
  .get('/:id/ics', (c) => calendar(c, taskCalendar(c.req.param('id')), `casefile-task-${c.req.param('id')}.ics`))
  .patch('/:id', async (c) => c.json(updateTask(c.req.param('id'), await body(c))))
  .delete('/:id', (c) => {
    deleteTask(c.req.param('id'));
    return c.json({ ok: true });
  })
  .post('/:id/done', (c) => c.json(completeTask(c.req.param('id'))))
  .post('/:id/reopen', (c) => c.json(reopenTask(c.req.param('id'))))
  .post('/:id/snooze', async (c) => c.json(snoozeTask(c.req.param('id'), await optionalBody(c))));
