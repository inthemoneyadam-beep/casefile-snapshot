import type { z } from 'zod';

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'HttpError';
  }
}

export const notFound = (what = 'Not found') => new HttpError(404, what);
export const badRequest = (msg: string) => new HttpError(400, msg);
export const conflict = (msg: string) => new HttpError(409, msg);

/**
 * A zod error as one line, the text every 400 from validation gives: "path: message" for each issue, joined by "; ".
 * An issue on the whole value names `fallback` ("body", "query", "value" or "input") instead of a path.
 */
export function zodIssues(error: z.ZodError, fallback = 'body'): string {
  return error.issues.map((i) => `${i.path.join('.') || fallback}: ${i.message}`).join('; ');
}

/** `schema` parsed, or a 400 with the zodIssues text. */
export function parseOrThrow<T>(schema: z.ZodType<T>, raw: unknown, fallback = 'body'): T {
  const r = schema.safeParse(raw);
  if (!r.success) throw badRequest(zodIssues(r.error, fallback));
  return r.data;
}
