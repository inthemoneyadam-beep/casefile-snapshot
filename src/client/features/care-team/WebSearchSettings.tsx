/**
 * Web search settings (2026-10-09, the user's request 6; lead's corrections), shown in Settings (AI) and, the scope alone,
 * on the Care team page (Find candidates):
 *   Search scope       "Find doctors" (the default): the web search tool keeps to doctor-finding sites, the
 *                      licensing boards of the states a search names, the sites of the people on your list, and the
 *                      hospital and university sites below (the tool's own allowed_domains, at most 64). "Open": any site.
 *   Licensing boards   a small table: state, site, checked (a person opened it and confirmed it is the board).
 *   Hospital and university sites   one per line, empty to start.
 *   Searches per run, and the tool version (Advanced): 20250305 unless asked otherwise.
 * Every change writes straight to PATCH /api/settings; viewers read.
 */
import { useEffect, useState } from 'react';
import { ApiError } from '../../api/client';
import { useSettings, useUpdateSettings } from '../../api/hooks';
import { useMe } from '../../api/users';
import { Button } from '../../ui/Button';
import { Field, Input, Select, Textarea } from '../../ui/Field';
import { Segmented } from '../../ui/Toolbar';
import { useToast } from '../../ui/Toast';
import { FIND_DOCTORS_SITES, MAX_ALLOWED_DOMAINS, SEARCH_SCOPES, SEARCH_SCOPE_HINTS, SEARCH_SCOPE_WORDS, plainHost, readSearchScope, type LicensingBoard, type SearchScope } from '@shared/web-domains';
import { US_STATES } from '@shared/care-team';
import './care-team.css';

function useSave() {
  const update = useUpdateSettings();
  const toast = useToast();
  return {
    pending: update.isPending,
    save: (patch: Record<string, unknown>, ok = 'Saved.') =>
      update.mutate(patch as never, {
        onSuccess: () => toast(ok, 'ok'),
        onError: (err) => toast(err instanceof ApiError ? err.message : 'Could not save.', 'bad'),
      }),
  };
}

/** The scope switch: Find doctors or Open, with what it means. */
export function ScopeSwitch({ compact }: { compact?: boolean }) {
  const s = useSettings();
  const me = useMe();
  const { save, pending } = useSave();
  const scope: SearchScope = readSearchScope(s.data?.['careTeam.searchScope']);
  return (
    <div className="ct-scope">
      <Segmented
        label="Search scope"
        value={scope}
        onChange={(v) => v !== scope && me.canWrite && !pending && save({ 'careTeam.searchScope': v }, `Search scope: ${SEARCH_SCOPE_WORDS[v]}.`)}
        options={SEARCH_SCOPES.map((v) => ({ value: v, label: SEARCH_SCOPE_WORDS[v], title: SEARCH_SCOPE_HINTS[v], disabled: !me.canWrite && v !== scope }))}
      />
      {compact ? null : <p className="muted small">{SEARCH_SCOPE_HINTS[scope]}</p>}
    </div>
  );
}

/** One board row being edited. */
interface BoardDraft {
  state: string;
  host: string;
  name: string;
  checked: boolean;
}

/** The boards as typed, cleaned for saving, or what is wrong in words. */
export function cleanBoards(rows: readonly BoardDraft[]): { boards: LicensingBoard[]; problem: string | null } {
  const boards: LicensingBoard[] = [];
  for (const r of rows) {
    if (!r.state.trim() && !r.host.trim()) continue;
    const state = r.state.trim().toUpperCase();
    if (!US_STATES[state]) return { boards: [], problem: `"${r.state}" is not a state code (e.g. OH).` };
    const host = plainHost(r.host);
    if (!host) return { boards: [], problem: `"${r.host}" is not a plain site name (e.g. med.ohio.gov).` };
    boards.push({ state, host, name: r.name.trim() || null, checked: r.checked });
  }
  return { boards, problem: null };
}

/** The hospital and university sites as typed (one per line), cleaned, or what is wrong in words. */
export function cleanSites(text: string): { sites: string[]; problem: string | null } {
  const sites: string[] = [];
  for (const line of text.split(/[\n,]/).map((l) => l.trim()).filter(Boolean)) {
    const h = plainHost(line);
    if (!h) return { sites: [], problem: `"${line}" is not a plain site name (e.g. example-hospital.org).` };
    if (!sites.includes(h)) sites.push(h);
  }
  if (sites.length > MAX_ALLOWED_DOMAINS) return { sites: [], problem: `At most ${MAX_ALLOWED_DOMAINS} sites.` };
  return { sites, problem: null };
}

export function WebSearchSettings() {
  const s = useSettings();
  const me = useMe();
  const toast = useToast();
  const { save, pending } = useSave();
  const readOnly = !me.canWrite;
  const data = s.data;
  const [boards, setBoards] = useState<BoardDraft[]>([]);
  const [sites, setSites] = useState('');
  useEffect(() => {
    if (!data) return;
    const list = (data['careTeam.licensingBoards'] ?? []) as LicensingBoard[];
    setBoards(list.map((b) => ({ state: b.state, host: b.host, name: b.name ?? '', checked: Boolean(b.checked) })));
    setSites(((data['careTeam.hospitalSites'] ?? []) as string[]).join('\n'));
  }, [data]);
  if (!data) return null;
  const caps = (data['ai.webSearch.maxPerRun'] ?? { ask: 5, findCandidates: 10 }) as { ask: number; findCandidates: number };
  const version = data['ai.webSearch.toolVersion'] ?? '20250305';

  function saveBoards() {
    const { boards: clean, problem } = cleanBoards(boards);
    if (problem) return toast(problem, 'bad');
    save({ 'careTeam.licensingBoards': clean }, 'Licensing boards saved.');
  }
  function saveSites() {
    const { sites: clean, problem } = cleanSites(sites);
    if (problem) return toast(problem, 'bad');
    setSites(clean.join('\n'));
    save({ 'careTeam.hospitalSites': clean }, 'Hospital and university sites saved.');
  }
  const setBoard = (i: number, patch: Partial<BoardDraft>) => setBoards((xs) => xs.map((b, n) => (n === i ? { ...b, ...patch } : b)));

  return (
    <div className="stack" id="settings-web-search">
      <div className="settings-subhead">Web search</div>
      <p className="muted small">Off until you use it: Find candidates on the Care team page, or "Search the web" under a question. Only search words go out, never your name, date of birth, record numbers or words from your records.</p>
      <ScopeSwitch />
      <p className="muted small">Find doctors always allows {FIND_DOCTORS_SITES.join(', ')}; then the boards below for the states a search names; then the websites of the people on your Care team list; then your hospital and university sites. At most {MAX_ALLOWED_DOMAINS} sites per search: the rest is left out, and the search says so.</p>

      <Field label="Licensing boards" hint="A state's board site is allowed when a search names the state. Tick Checked once you have opened it and seen it is the board.">
        <table className="ct-boards">
          <thead>
            <tr>
              <th>State</th>
              <th>Site</th>
              <th>Board</th>
              <th>Checked</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {boards.map((b, i) => (
              <tr key={i}>
                <td>
                  <Input aria-label="State" value={b.state} onChange={(e) => setBoard(i, { state: e.target.value })} disabled={readOnly} className="ct-board-state" />
                </td>
                <td>
                  <Input aria-label="Site" value={b.host} onChange={(e) => setBoard(i, { host: e.target.value })} disabled={readOnly} />
                </td>
                <td>
                  <Input aria-label="Board" value={b.name} onChange={(e) => setBoard(i, { name: e.target.value })} disabled={readOnly} />
                </td>
                <td>
                  <label className="settings-check">
                    <input type="checkbox" checked={b.checked} onChange={(e) => setBoard(i, { checked: e.target.checked })} disabled={readOnly} />
                    {b.checked ? 'Checked' : 'Not yet'}
                  </label>
                </td>
                <td>
                  {readOnly ? null : (
                    <Button size="sm" variant="ghost" onClick={() => setBoards((xs) => xs.filter((_, n) => n !== i))}>
                      Remove
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Field>
      {readOnly ? null : (
        <div className="row wrap">
          <Button size="sm" onClick={() => setBoards((xs) => [...xs, { state: '', host: '', name: '', checked: false }])}>
            Add a board
          </Button>
          <Button size="sm" variant="accent" onClick={saveBoards} disabled={pending}>
            Save the boards
          </Button>
        </div>
      )}

      <Field label="Hospital and university sites" hint="One per line, e.g. example-hospital.org. Each covers its subdomains. Find doctors allows them.">
        <Textarea rows={4} value={sites} onChange={(e) => setSites(e.target.value)} disabled={readOnly} />
      </Field>
      {readOnly ? null : (
        <div className="row wrap">
          <Button size="sm" variant="accent" onClick={saveSites} disabled={pending}>
            Save the sites
          </Button>
        </div>
      )}

      <div className="form settings-form">
        <Field inline label="Most searches, one question" hint="Ask: the clinician's searches in one answer.">
          <Select aria-label="Most searches, one question" value={String(caps.ask)} options={[1, 2, 3, 5, 8, 10, 15, 20].map((n) => ({ value: String(n), label: String(n) }))} onChange={(e) => save({ 'ai.webSearch.maxPerRun': { ...caps, ask: Number(e.target.value) } })} disabled={readOnly} className="settings-select short" />
        </Field>
        <Field inline label="Most searches, Find candidates" hint="One Find candidates run.">
          <Select aria-label="Most searches, Find candidates" value={String(caps.findCandidates)} options={[1, 3, 5, 10, 15, 20, 30].map((n) => ({ value: String(n), label: String(n) }))} onChange={(e) => save({ 'ai.webSearch.maxPerRun': { ...caps, findCandidates: Number(e.target.value) } })} disabled={readOnly} className="settings-select short" />
        </Field>
        <Field inline label="Web search version" hint="The 2025 version is the one whose answers CaseFile is built and tested for. The 2026 version filters results with code first; Haiku models always use the 2025 one.">
          <Select aria-label="Web search version" value={version} options={[{ value: '20250305', label: '2025 (standard)' }, { value: '20260209', label: '2026 (filters with code)' }]} onChange={(e) => save({ 'ai.webSearch.toolVersion': e.target.value })} disabled={readOnly} className="settings-select" />
        </Field>
      </div>
    </div>
  );
}
