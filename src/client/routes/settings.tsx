/**
 * /settings — one scrollable page, in the order a person needs it: Appearance first, Patient
 * details, Lock and passphrase, People with access (and the audit log), Backups, AI (the key and a test), and
 * Advanced (models, thinking effort, pages read at a time, how much Claude carries on reading by itself, local network
 * access), folded away until opened.
 * "Go to:" in the toolbar jumps to a section. Every control writes straight to PATCH /api/settings; appearance
 * changes apply at once through applyAppearance. Controls follow the role policy (DECISIONS, slice S): viewers read
 * this page and keep appearance on this computer only; editors change everything except the AI key and the lock
 * settings (owner only). Never a model id on screen: models by name (features/settings/words.ts).
 */
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { api, ApiError, LOCK_EVENT } from '../api/client';
import { aiKeys } from '../api/ai';
import { useBackupNow, useChangePassphrase, useTestAiConnection, type BackupResult } from '../api/system';
import { useSettings, useSystemInfo, useUpdateSettings, type PublicSettings } from '../api/hooks';
import { errorText, useAuthFull, useMe } from '../api/users';
import { applyAppearance, readAppearance, type Appearance, type Theme } from '../app/theme';
import { useRegisterCommands } from '../app/commands';
import { useBindings } from '../app/shortcuts';
import { Button } from '../ui/Button';
import { KeyFacts } from '../ui/DetailPane';
import { Field, Input, Select, Textarea } from '../ui/Field';
import { Loading, PageHeader, Section } from '../ui/PageHeader';
import { FilterGroup, Segmented, Toolbar } from '../ui/Toolbar';
import { useToast } from '../ui/Toast';
import { MODEL_CHOICES, type Settings } from '@shared/constants';
import { ToolbarKeys } from '../ui/Toolbar';
import { UsersSection } from '../features/settings/UsersSection';
import { NetworkSettings } from '../features/settings/NetworkSection';
import { BackupList, downloadBackup } from '../features/settings/BackupList';
import { BACKUP_WORDS, EFFORT_WORDS, backupSavedWords, countWords, fmtBytes, modelWords } from '../features/settings/words';
import '../features/settings/settings.css';
import { useCheckAgain } from '../api/patient-check';
import { RecordNumbersField, cleanNumbers } from '../features/patient-check/RecordNumbersField';
import { splitNames, sweepWords } from '../features/patient-check/words';
import { WebSearchSettings } from '../features/care-team/WebSearchSettings';
import type { RecordNumber } from '@shared/patient-identity';

export const Route = createFileRoute('/settings')({ component: SettingsPage });

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const EFFORT_OPTIONS = EFFORTS.map((e) => ({ value: e, label: EFFORT_WORDS[e] ?? e }));
const SECTIONS = [
  ['appearance', 'Appearance'],
  ['patient', 'Patient details'],
  ['lock', 'Lock'],
  ['access', 'People with access'],
  ['backups', 'Backups'],
  ['ai', 'AI'],
  ['advanced', 'Advanced'],
] as const;
type SectionId = (typeof SECTIONS)[number][0];
const ADVANCED_KEY = 'casefile.settings.advancedOpen';

const INTRO = 'How CaseFile looks, the patient details printed on the emergency card and packets, the lock, who has access, backups and Claude. Everything here is kept inside the encrypted case.';

/**
 * A refusal or failure as one readable line. A role refusal (403 with
 * `{ error: <role>, role, detail }`) names the role and why; anything else
 * reads as errorText does.
 */
function failText(err: unknown, fallback: string): string {
  if (err instanceof ApiError && err.status === 403) {
    const body = err.body as { role?: unknown; detail?: unknown } | null;
    if (body && typeof body === 'object' && typeof body.role === 'string') {
      return `Not allowed for the ${body.role} role${typeof body.detail === 'string' ? `: ${body.detail}` : ''}.`;
    }
  }
  if (err instanceof ApiError || err instanceof Error) return errorText(err);
  return fallback;
}

/** A test's failure in words: no key, a key that was not accepted, switched off; else the reason as given. */
function testFailWords(error: string | undefined): string {
  const e = error ?? '';
  if (/NoApiKey|no anthropic api key/i.test(e)) return 'No API key is set yet. Enter one above.';
  if (/401|authentication|invalid api key|x-api-key/i.test(e)) return 'The API key was not accepted. Check it and save it again.';
  if (/switched off|AiDisabled|ai\.enabled/i.test(e)) return 'Claude is switched off above.';
  if (/429|rate limit|overloaded|529/i.test(e)) return 'Claude is busy right now. Try again in a minute.';
  if (/credit|billing|402/i.test(e)) return 'The Anthropic account is out of credit.';
  return e || 'No reply.';
}

const VIEWER_NOTE = 'Viewers can read these settings; the owner or an editor changes them.';
const OWNER_NOTE = 'Only the owner can change this.';

function readAdvancedOpen(): boolean {
  try {
    return localStorage.getItem(ADVANCED_KEY) === '1';
  } catch {
    return false;
  }
}

/** A number field that commits on blur or Enter, never on every keystroke. */
function NumberSetting({ value, onCommit, min, max, step = 1, width = 110, disabled, label }: { value: number; onCommit: (n: number) => void; min?: number; max?: number; step?: number; width?: number; disabled?: boolean; label?: string }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => {
    const n = Number(text);
    if (!Number.isFinite(n) || n === value) {
      setText(String(value));
      return;
    }
    const clamped = Math.max(min ?? -Infinity, Math.min(max ?? Infinity, n));
    onCommit(clamped);
  };
  return (
    <Input
      type="number"
      className="mono"
      value={text}
      min={min}
      max={max}
      step={step}
      style={{ width }}
      disabled={disabled}
      aria-label={label}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        }
      }}
    />
  );
}

function SettingsPage() {
  const settings = useSettings();
  const update = useUpdateSettings();
  const info = useSystemInfo();
  const toast = useToast();
  const qc = useQueryClient();
  const s = settings.data;
  const me = useMe();
  // A role that is still loading disables nothing; the server decides anyway.
  const readOnly = me.isViewer;
  const ownerOnly = me.role !== null && !me.isOwner;

  const patch = useCallback(
    (p: Partial<Settings>, okText?: string, onDone?: () => void) => {
      update.mutate(p, {
        onSuccess: () => {
          if (okText) toast(okText, 'ok');
          onDone?.();
        },
        onError: (err) => toast(failText(err, 'Could not save the setting.'), 'bad'),
      });
    },
    [update, toast],
  );

  // --- AI ------------------------------------------------------------------
  const [apiKey, setApiKey] = useState('');
  const saveKey = (e: FormEvent) => {
    e.preventDefault();
    const v = apiKey.trim();
    if (!v) return;
    update.mutate(
      { 'ai.apiKey': v },
      {
        onSuccess: () => {
          setApiKey('');
          toast('API key stored in the encrypted settings.', 'ok');
        },
        onError: (err) => toast(failText(err, 'Could not store the key.'), 'bad'),
      },
    );
  };
  const [testResult, setTestResult] = useState<{ ok: boolean; model: string; error?: string } | null>(null);
  const test = useTestAiConnection({
    onSuccess: (r) => {
      setTestResult(r);
      void qc.invalidateQueries({ queryKey: aiKeys.calls });
    },
    onError: (err) => setTestResult({ ok: false, model: '', error: failText(err, String(err)) }),
  });
  const runTest = useCallback(() => {
    if (readOnly) return toast('Viewers cannot test the connection to Claude.', 'bad');
    if (!test.isPending) test.mutate();
  }, [test, readOnly, toast]);
  const toggleAi = useCallback(() => {
    if (!s) return;
    if (readOnly) return toast(VIEWER_NOTE, 'bad');
    const next = !s['ai.enabled'];
    patch({ 'ai.enabled': next }, next ? 'Claude switched on.' : 'Claude switched off. Nothing leaves this computer.');
  }, [s, patch, readOnly, toast]);

  // --- Lock ----------------------------------------------------------------
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [passError, setPassError] = useState<string | null>(null);
  const changePass = useChangePassphrase({
    onSuccess: () => {
      setCur('');
      setNext('');
      setConfirm('');
      setPassError(null);
      toast('Passphrase changed. The case and its files are unchanged; only the lock on them was redone.', 'ok');
    },
    onError: (err) => setPassError(failText(err, 'Could not change the passphrase.')),
  });
  const submitPass = (e: FormEvent) => {
    e.preventDefault();
    setPassError(null);
    if (next.length < 8) return setPassError('Use at least 8 characters.');
    if (next !== confirm) return setPassError('The two new passphrases do not match.');
    changePass.mutate({ current: cur, next });
  };
  const lockNow = useCallback(() => {
    void api.post('/api/auth/lock').finally(() => window.dispatchEvent(new CustomEvent(LOCK_EVENT)));
  }, []);
  // The idle lock the server actually applies (GET /api/auth/status). The
  // server treats a stored 0 as "off" (auth.ts idleMinutesSetting) and the
  // settings schema accepts it, but this field deliberately stays min 1: the
  // page never switches the lock off (fail-secure, DECISIONS 2026-10-05 review
  // sweep). The hint reports the effective value when it differs from the
  // stored one, and says when running work is holding the lock off.
  const authStatus = useAuthFull();
  const effectiveIdle = authStatus.data?.idleMinutes ?? null;
  const idleHeld = authStatus.data?.idleHeld ?? null;
  const idleHint = (stored: number) =>
    [
      'Minutes with no keyboard or mouse before the case locks itself (1 to 1440). Work that is still running, such as Claude reading a document, holds it off until it finishes.',
      effectiveIdle != null && effectiveIdle !== stored ? (effectiveIdle > 0 ? `Right now it locks after ${effectiveIdle} idle minutes.` : 'The automatic lock is off right now.') : null,
      idleHeld ? `Right now it ${idleHeld}.` : null,
      ownerOnly ? OWNER_NOTE : null,
    ]
      .filter(Boolean)
      .join(' ');
  const commitIdle = (n: number) => patch({ 'lock.idleMinutes': Math.max(1, Math.round(n)) }, 'Automatic lock updated.', () => void qc.invalidateQueries({ queryKey: ['auth'] }));

  // --- Appearance ------------------------------------------------------------
  const [appearance, setAppearance] = useState<Appearance>(() => readAppearance());
  useEffect(() => {
    const on = (e: Event) => setAppearance((e as CustomEvent<Appearance>).detail);
    window.addEventListener('casefile:appearance', on);
    return () => window.removeEventListener('casefile:appearance', on);
  }, []);
  const setLook = (p: Partial<Appearance>) => {
    const a = { ...readAppearance(), ...p };
    applyAppearance(a);
    const sp: Partial<Settings> = {};
    if (p.theme !== undefined) sp['ui.theme'] = p.theme;
    if (p.largeType !== undefined) sp['ui.largeType'] = p.largeType;
    if (p.reducedContrast !== undefined) sp['ui.reducedContrast'] = p.reducedContrast;
    // Viewers may not write settings: their appearance stays on this computer.
    if (!readOnly && Object.keys(sp).length) patch(sp);
  };

  // --- Patient -------------------------------------------------------------
  // The name, date of birth, other first names, someone often confused with the patient and the patient's record numbers are also what
  // every document is checked against (the wrong-patient guard, 2026-10-09): saving a change checks them all again.
  const [patient, setPatient] = useState({ name: '', dob: '', bloodType: '', emergencyContacts: '', summary: '', otherFirstNames: '', confusedWith: '', recordNumbers: [] as RecordNumber[] });
  const patientLoaded = useRef(false);
  useEffect(() => {
    if (!s || patientLoaded.current) return;
    patientLoaded.current = true;
    setPatient({
      name: s['patient.name'],
      dob: s['patient.dob'],
      bloodType: s['patient.bloodType'],
      emergencyContacts: s['patient.emergencyContacts'],
      summary: s['patient.summary'],
      otherFirstNames: (s['patient.otherFirstNames'] ?? []).join(', '),
      confusedWith: (s['patient.confusedWith'] ?? []).join(', '),
      recordNumbers: s['patient.recordNumbers'] ?? [],
    });
  }, [s]);
  const checkAgain = useCheckAgain();
  const identityOf = (x: { name: string; dob: string; otherFirstNames: string[]; confusedWith: string[]; recordNumbers: RecordNumber[] }) => JSON.stringify([x.name.trim(), x.dob.trim(), x.otherFirstNames, x.confusedWith, cleanNumbers(x.recordNumbers)]);
  const identityNow = identityOf({ ...patient, otherFirstNames: splitNames(patient.otherFirstNames), confusedWith: splitNames(patient.confusedWith) });
  const identitySaved = s ? identityOf({ name: s['patient.name'], dob: s['patient.dob'], otherFirstNames: s['patient.otherFirstNames'] ?? [], confusedWith: s['patient.confusedWith'] ?? [], recordNumbers: s['patient.recordNumbers'] ?? [] }) : '';
  const patientDirty =
    Boolean(s) && (identityNow !== identitySaved || patient.bloodType !== s!['patient.bloodType'] || patient.emergencyContacts !== s!['patient.emergencyContacts'] || patient.summary !== s!['patient.summary']);
  const savePatient = (e?: FormEvent) => {
    e?.preventDefault();
    if (readOnly) return;
    const identityChanged = identityNow !== identitySaved;
    patch(
      {
        'patient.name': patient.name.trim(),
        'patient.dob': patient.dob.trim(),
        'patient.bloodType': patient.bloodType.trim(),
        'patient.emergencyContacts': patient.emergencyContacts,
        'patient.summary': patient.summary,
        'patient.otherFirstNames': splitNames(patient.otherFirstNames),
        'patient.confusedWith': splitNames(patient.confusedWith),
        'patient.recordNumbers': cleanNumbers(patient.recordNumbers),
      },
      identityChanged ? 'Patient details saved. Checking every document against them…' : 'Patient details saved.',
      () => {
        if (identityChanged) checkAgain.mutate(undefined, { onSuccess: (r) => toast(sweepWords(r), r.held || r.unheld || r.missing.length ? 'info' : 'ok'), onError: (err) => toast(failText(err, 'Could not check the documents.'), 'bad') });
      },
    );
  };

  // --- Backups ---------------------------------------------------------------
  const [backup, setBackup] = useState<BackupResult | null>(null);
  const backupNow = useBackupNow({
    onSuccess: (r) => {
      const warnings = Array.isArray(r.warnings) ? r.warnings : [];
      setBackup({ ...r, warnings });
      toast(backupSavedWords(r, warnings.length, me.hosted), warnings.length ? 'bad' : 'ok');
    },
    onError: (err) => toast(failText(err, 'The backup did not work.'), 'bad'),
  });
  const runBackup = useCallback(() => {
    if (readOnly) return toast('Viewers cannot make a backup.', 'bad');
    if (!backupNow.isPending) backupNow.mutate();
  }, [backupNow, readOnly, toast]);

  // --- Sections and Advanced -------------------------------------------------
  const [advancedOpen, setAdvancedOpenState] = useState<boolean>(() => readAdvancedOpen());
  const setAdvancedOpen = useCallback((open: boolean) => {
    setAdvancedOpenState(open);
    try {
      localStorage.setItem(ADVANCED_KEY, open ? '1' : '0');
    } catch {
      // the choice is only a convenience
    }
  }, []);
  const jump = useCallback(
    (id: SectionId) => {
      if (id === 'advanced') setAdvancedOpen(true);
      setTimeout(() => document.getElementById(`settings-${id}`)?.scrollIntoView({ block: 'start', behavior: 'instant' as ScrollBehavior }), 0);
    },
    [setAdvancedOpen],
  );

  // --- Keys and commands ---------------------------------------------------
  useBindings(
    [
      { keys: 't', description: 'Test the connection to Claude', group: 'Page', run: runTest },
      { keys: 'b', description: 'Back up now', group: 'Page', run: runBackup },
    ],
    [runTest, runBackup],
  );
  useRegisterCommands(
    [
      { id: 'settings.test-ai', title: 'Test the connection to Claude', group: 'Page', shortcut: 't', keywords: 'ai test key', run: runTest },
      { id: 'settings.backup', title: 'Back up now', group: 'Page', shortcut: 'b', keywords: 'backup zip', run: runBackup },
      { id: 'settings.lock', title: 'Lock now', group: 'Page', shortcut: 'ctrl+shift+x', run: lockNow },
      { id: 'settings.toggle-ai', title: s?.['ai.enabled'] ? 'Switch Claude off' : 'Switch Claude on', group: 'Page', keywords: 'ai enabled off switch toggle', run: toggleAi },
      { id: 'settings.advanced', title: advancedOpen ? 'Settings: hide the advanced settings' : 'Settings: show the advanced settings', group: 'Page', keywords: 'models effort network advanced', run: () => (advancedOpen ? setAdvancedOpen(false) : jump('advanced')) },
      ...SECTIONS.map(([id, label]) => ({ id: `settings.go.${id}`, title: `Settings: go to ${label}`, group: 'Page', keywords: 'jump section', run: () => jump(id) })),
    ],
    [runTest, runBackup, lockNow, toggleAi, s?.['ai.enabled'], advancedOpen, jump, setAdvancedOpen],
  );

  const keyLine = (st: PublicSettings) =>
    st['ai.apiKeySource'] === 'env'
      ? 'A key is set on this computer (the ANTHROPIC_API_KEY setting). It is used instead of a stored key.'
      : st['ai.apiKeySource'] === 'settings'
        ? 'A key is stored in the encrypted settings.'
        : 'No key yet. Claude’s actions are blocked until one is entered here; everything else works without one.';

  return (
    <div className="page">
      <PageHeader title="Settings" intro={INTRO} actions={{ secondary: [{ label: 'Lock now', onClick: lockNow, shortcut: 'ctrl+shift+x', title: 'Close the case now; it opens again with a passphrase' }] }} />
      <Toolbar label="Sections">
        <FilterGroup label="Go to" className="settings-goto">
          {SECTIONS.map(([id, label]) => (
            <Button key={id} size="sm" onClick={() => jump(id)}>
              {label}
            </Button>
          ))}
        </FilterGroup>
        <ToolbarKeys
          items={[
            ['b', 'back up'],
            ['t', 'test Claude'],
            ['ctrl+shift+x', 'lock'],
            ['v t', 'theme'],
            ['v b', 'large type'],
            ['v r', 'contrast'],
            me.isOwner ? ['a', 'add a person'] : null,
          ]}
        />
      </Toolbar>
      <div className="page-body settings-body">
        {settings.isPending ? (
          <Loading>Loading settings…</Loading>
        ) : settings.isError || !s ? (
          <div className="notice bad">Could not load the settings.</div>
        ) : (
          <div className="settings-sections">
            <Section title="Appearance" id="settings-appearance" intro={readOnly ? 'Changes apply at once, on this computer only.' : 'Changes apply at once. Theme, large type and contrast also have keys that work on every page.'}>
              <div className="form settings-form">
                <Field inline label="Theme" hint="Dark is easiest on the eyes; dim is darker still.">
                  <Segmented<Theme>
                    ariaLabel="Theme"
                    value={appearance.theme}
                    onChange={(t) => setLook({ theme: t })}
                    options={[
                      { value: 'dark', label: 'Dark' },
                      { value: 'dim', label: 'Dim' },
                      { value: 'light', label: 'Light' },
                    ]}
                  />
                </Field>
                <Field inline label="Type size">
                  <label className="settings-check">
                    <input type="checkbox" checked={appearance.largeType} onChange={(e) => setLook({ largeType: e.target.checked })} />
                    Large type
                  </label>
                </Field>
                <Field inline label="Contrast" hint="Softer text and lines, for days when the screen feels too bright.">
                  <label className="settings-check">
                    <input type="checkbox" checked={appearance.reducedContrast} onChange={(e) => setLook({ reducedContrast: e.target.checked })} />
                    Reduced contrast
                  </label>
                </Field>
                <Field inline label="Keyboard" hint="The keys work either way; press ? on any page for the whole list.">
                  <label className="settings-check">
                    <input type="checkbox" checked={appearance.keyHints} onChange={(e) => setLook({ keyHints: e.target.checked })} />
                    Show the keys on buttons and toolbars
                  </label>
                </Field>
              </div>
            </Section>

            <Section
              title="Patient details"
              id="settings-patient"
              intro={`Printed on the emergency card and on a packet’s cover page. Every document is checked against your name, date of birth and record numbers, so someone else’s record is held back.${readOnly ? ` ${VIEWER_NOTE}` : ''}`}
            >
              <form className="form settings-form" onSubmit={savePatient}>
                <Field inline label="Name">
                  <Input value={patient.name} onChange={(e) => setPatient({ ...patient, name: e.target.value })} className="settings-input" readOnly={readOnly} />
                </Field>
                <Field inline label="Date of birth" hint="As you want it printed, e.g. 1985-01-01.">
                  <Input value={patient.dob} onChange={(e) => setPatient({ ...patient, dob: e.target.value })} className="settings-input short mono" readOnly={readOnly} placeholder="e.g. 1985-01-01" />
                </Field>
                <Field inline label="Other first names I go by" hint="A legal name or a nickname, with commas between. These never count as someone else's name.">
                  <Input value={patient.otherFirstNames} onChange={(e) => setPatient({ ...patient, otherFirstNames: e.target.value })} className="settings-input" readOnly={readOnly} placeholder="e.g. Robin" />
                </Field>
                <Field inline label="Someone often confused with me" hint="First names only, such as a twin. A document with one of these is held back as May be someone else's record.">
                  <Input value={patient.confusedWith} onChange={(e) => setPatient({ ...patient, confusedWith: e.target.value })} className="settings-input" readOnly={readOnly} />
                </Field>
                <Field inline label="My record numbers" hint="Each hospital gives its own number (MRN). Another number from the same place holds a document back.">
                  <RecordNumbersField value={patient.recordNumbers} onChange={(recordNumbers) => setPatient({ ...patient, recordNumbers })} readOnly={readOnly} />
                </Field>
                <Field inline label="Blood type">
                  <Input value={patient.bloodType} onChange={(e) => setPatient({ ...patient, bloodType: e.target.value })} className="settings-input tiny mono" placeholder="e.g. O+" readOnly={readOnly} />
                </Field>
                <Field inline label="Emergency contacts" hint="One per line: name, relationship, phone.">
                  <Textarea rows={4} value={patient.emergencyContacts} onChange={(e) => setPatient({ ...patient, emergencyContacts: e.target.value })} readOnly={readOnly} />
                </Field>
                <Field inline label="Summary" hint="One paragraph a stranger in an emergency department should read first.">
                  <Textarea rows={5} value={patient.summary} onChange={(e) => setPatient({ ...patient, summary: e.target.value })} readOnly={readOnly} />
                </Field>
                <div className="form-actions">
                  <Button type="submit" variant="accent" disabled={readOnly || !patientDirty || update.isPending}>
                    Save patient details
                  </Button>
                  {patientDirty ? <span className="settings-unsaved">Not saved yet</span> : null}
                </div>
              </form>
            </Section>

            <Section title="Lock and passphrase" id="settings-lock" intro="The case locks itself when nobody uses it: the database closes and the key is forgotten until a passphrase is entered. Lock now is at the top of this page.">
              <div className="form settings-form">
                <Field inline label="Lock after" hint={idleHint(s['lock.idleMinutes'])}>
                  <div className="row">
                    <NumberSetting value={s['lock.idleMinutes']} min={1} max={1440} onCommit={commitIdle} disabled={ownerOnly} label="Minutes before the case locks itself" />
                    <span className="muted">minutes with nothing happening</span>
                  </div>
                </Field>
              </div>
              <form className="form settings-form" onSubmit={submitPass} aria-label="Change your passphrase">
                <div className="full settings-subhead">Change your passphrase</div>
                <Field inline label="Current passphrase">
                  <Input type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} className="settings-input" />
                </Field>
                <Field inline label="New passphrase" hint="At least 8 characters; a short sentence is easy to remember and hard to guess. There is no way to recover it if it is lost.">
                  <Input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} className="settings-input" />
                </Field>
                <Field inline label="Repeat the new one" error={passError}>
                  <Input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} className="settings-input" />
                </Field>
                <div className="form-actions">
                  <Button type="submit" variant="accent" disabled={!cur || !next || !confirm || changePass.isPending}>
                    {changePass.isPending ? 'Changing…' : 'Change passphrase'}
                  </Button>
                </div>
              </form>
            </Section>

            <UsersSection />

            <Section
              title="Backups"
              id="settings-backups"
              intro={me.hosted ? BACKUP_WORDS.introHosted : BACKUP_WORDS.introLocal}
              actions={
                <Button size="sm" variant="accent" onClick={runBackup} disabled={readOnly || backupNow.isPending} shortcut="b">
                  {backupNow.isPending ? 'Backing up…' : 'Back up now'}
                </Button>
              }
            >
              {info.isPending ? (
                <Loading />
              ) : info.data ? (
                <KeyFacts
                  items={[
                    { label: me.hosted ? 'Backups are saved on the server in' : 'Backups are saved in', value: info.data.backupsDir, mono: true, wide: true },
                    { label: me.hosted ? 'The case is kept on the server in' : 'The case is kept in', value: info.data.dataDir, mono: true, wide: true },
                    { label: 'Size of the case', value: fmtBytes(info.data.dbBytes), mono: true, title: 'The encrypted database; the files are kept beside it' },
                    { label: 'What it holds', value: countWords(info.data.counts), wide: true },
                  ]}
                />
              ) : (
                <div className="notice bad">Could not read where the case is kept.</div>
              )}
              {backup ? (
                <div className="stack tight">
                  <div className={`notice ${backup.warnings.length ? 'warn' : 'ok'}`} role="status">
                    <strong>Backup saved</strong> {me.hosted ? 'as' : 'to'} <span className="mono">{me.hosted ? (backup.name ?? backup.path) : backup.path}</span> ({fmtBytes(backup.bytes)}).
                    {backup.warnings.length ? ` ${backup.warnings.length} warning${backup.warnings.length === 1 ? '' : 's'} below.` : null} {me.hosted ? BACKUP_WORDS.restoreHosted : BACKUP_WORDS.restoreLocal}
                    {backup.name && me.isOwner ? (
                      <>
                        {' '}
                        <Button size="sm" variant="ghost" onClick={() => downloadBackup(backup.name!)}>
                          Download it
                        </Button>
                      </>
                    ) : null}
                  </div>
                  {backup.warnings.map((w, i) => (
                    <div key={i} className="notice warn" role="status">
                      {w}
                    </div>
                  ))}
                </div>
              ) : null}
              <BackupList />
            </Section>

            <Section
              title="AI"
              id="settings-ai"
              intro="CaseFile contacts only api.anthropic.com, only when you start something that needs Claude, and lists every request in the AI usage log."
              actions={
                <Button size="sm" onClick={runTest} disabled={readOnly || test.isPending} shortcut="t">
                  {test.isPending ? 'Testing…' : 'Test the connection'}
                </Button>
              }
            >
              {readOnly ? <p className="muted">{VIEWER_NOTE}</p> : null}
              <div className="form settings-form">
                <Field inline label="Claude" hint={s['ai.enabled'] ? undefined : 'Every request is blocked and listed as blocked in the AI usage log.'}>
                  <label className="settings-check">
                    <input type="checkbox" checked={s['ai.enabled']} onChange={toggleAi} disabled={readOnly} />
                    {s['ai.enabled'] ? 'Switched on' : 'Switched off'}
                  </label>
                </Field>
                <Field inline label="API key" hint={ownerOnly ? `${keyLine(s)} ${OWNER_NOTE}` : keyLine(s)}>
                  <form className="row" onSubmit={saveKey}>
                    <Input type="password" autoComplete="off" placeholder={s['ai.apiKeySet'] ? 'Enter a new key to replace it' : 'e.g. sk-ant-…'} value={apiKey} onChange={(e) => setApiKey(e.target.value)} className="settings-input" aria-label="API key" disabled={ownerOnly} />
                    <Button type="submit" variant="accent" disabled={ownerOnly || !apiKey.trim() || update.isPending}>
                      Save the key
                    </Button>
                    {s['ai.apiKeySource'] === 'settings' ? (
                      <Button variant="ghost" disabled={ownerOnly} onClick={() => patch({ 'ai.apiKey': '' }, 'Stored key removed.')}>
                        Remove the stored key
                      </Button>
                    ) : null}
                  </form>
                </Field>
                {testResult ? (
                  <div className="full">
                    <div className={`notice ${testResult.ok ? 'ok' : 'bad'}`} role="status">
                      {testResult.ok ? (
                        <>
                          <strong>It works.</strong> Claude answered the test.
                        </>
                      ) : (
                        <>
                          <strong>It did not work.</strong> {testFailWords(testResult.error)}
                        </>
                      )}
                    </div>
                  </div>
                ) : null}
              </div>
              <WebSearchSettings />
            </Section>

            <Section
              title="Advanced"
              id="settings-advanced"
              intro={me.hosted ? 'Which Claude models do the work and how hard they think. The defaults suit most uses.' : 'Which Claude models do the work, how hard they think, and local network access. The defaults suit most uses.'}
              actions={
                <Button size="sm" variant="ghost" aria-expanded={advancedOpen} aria-controls="settings-advanced-body" onClick={() => setAdvancedOpen(!advancedOpen)}>
                  {advancedOpen ? 'Hide' : 'Show'}
                </Button>
              }
            >
              {advancedOpen ? (
                <div id="settings-advanced-body" className="settings-advanced">
                  <div className="form settings-form">
                    <div className="full settings-subhead">Claude</div>
                    <Field inline label="Everyday model" hint="Reads documents, answers your questions, writes drafts.">
                      <Select options={MODEL_CHOICES.map((m) => ({ value: m, label: modelWords(m) }))} value={s['ai.models.standard']} onChange={(e) => patch({ 'ai.models.standard': e.target.value })} className="settings-select" disabled={readOnly} aria-label="Everyday model" />
                    </Field>
                    <Field inline label="Deep model" hint="Deeper reading passes, and the check across all the records (What Claude noticed).">
                      <Select options={MODEL_CHOICES.map((m) => ({ value: m, label: modelWords(m) }))} value={s['ai.models.deep']} onChange={(e) => patch({ 'ai.models.deep': e.target.value })} className="settings-select" disabled={readOnly} aria-label="Deep model" />
                    </Field>
                    <Field inline label="Thinking, in general" hint="For requests that set none of their own: sorting a document uses low, reading documents and the check across the records use the two below, and Ask uses each answer setting’s own.">
                      <Select options={EFFORT_OPTIONS} value={s['ai.effort']} onChange={(e) => patch({ 'ai.effort': e.target.value as Settings['ai.effort'] })} className="settings-select short" disabled={readOnly} aria-label="Thinking, in general" />
                    </Field>
                    <Field inline label="Thinking, reading documents" hint="Low leaves more room for the details themselves.">
                      <Select options={EFFORT_OPTIONS} value={s['ai.extraction.effort']} onChange={(e) => patch({ 'ai.extraction.effort': e.target.value as Settings['ai.extraction.effort'] })} className="settings-select short" disabled={readOnly} aria-label="Thinking, reading documents" />
                    </Field>
                    <Field inline label="Thinking, checking across the records" hint="At the highest setting the thinking can use all the room and leave no findings.">
                      <Select options={EFFORT_OPTIONS} value={s['ai.crossref.effort']} onChange={(e) => patch({ 'ai.crossref.effort': e.target.value as Settings['ai.crossref.effort'] })} className="settings-select short" disabled={readOnly} aria-label="Thinking, checking across the records" />
                    </Field>
                    <Field inline label="Pages read at a time" hint="Long documents are read this many pages at a time.">
                      <NumberSetting value={s['ai.maxPagesPerChunk']} min={1} max={200} onCommit={(n) => patch({ 'ai.maxPagesPerChunk': n })} disabled={readOnly} label="Pages read at a time" />
                    </Field>
                    <Field inline label="Carry on reading up to" hint="In dollars, per document. When a long document was not read to the end (a lock, a restart, a dropped connection), Claude carries on by itself up to this much; above it, it asks you once. 0 asks every time.">
                      <NumberSetting value={s['ai.autoResumeCeilingUsd'] ?? 50} min={0} max={1000} step={1} onCommit={(n) => patch({ 'ai.autoResumeCeilingUsd': n })} disabled={readOnly} label="Carry on reading up to, in dollars" />
                    </Field>
                  </div>
                  {me.hosted ? null : (
                    <>
                      <div className="settings-subhead">Local network access</div>
                      <NetworkSettings />
                    </>
                  )}
                </div>
              ) : null}
            </Section>
          </div>
        )}
      </div>
    </div>
  );
}
