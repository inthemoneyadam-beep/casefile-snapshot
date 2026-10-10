import { useEffect, useRef, useState } from 'react';
import { IMAGING_MODALITIES } from '@shared/enums';
import { Dialog } from '../../ui/Dialog';
import { Button } from '../../ui/Button';
import { Field, Input, Select, Textarea } from '../../ui/Field';
import type { ImagingEntry, ImagingInput } from '../../api/imaging';
import type { DocumentLite, PersonLite } from '../../api/labs';
import { MODALITY_LONG_WORDS } from './words';

export interface ImagingFormDialogProps {
  open: boolean;
  onClose: () => void;
  entry?: ImagingEntry | null;
  documents: DocumentLite[];
  institutions: PersonLite[];
  busy: boolean;
  error?: string | null;
  onCreate: (input: ImagingInput) => void;
  onUpdate: (id: string, patch: ImagingInput) => void;
}

export function ImagingFormDialog({ open, onClose, entry, documents, institutions, busy, error, onCreate, onUpdate }: ImagingFormDialogProps) {
  const editing = Boolean(entry);
  const [title, setTitle] = useState('');
  const [modality, setModality] = useState('MRI');
  const [bodyPart, setBodyPart] = useState('');
  const [dateText, setDateText] = useState('');
  const [institutionId, setInstitutionId] = useState('');
  const [contrast, setContrast] = useState('');
  const [impression, setImpression] = useState('');
  const [findings, setFindings] = useState('');
  const [documentId, setDocumentId] = useState('');
  const [hasImages, setHasImages] = useState(false);
  const [notes, setNotes] = useState('');

  // Fill the fields when the dialog opens or switches to another study, never on a parent
  // re-render or a refetch, so typed text survives a server error. Latest entry via a ref.
  const entryRef = useRef(entry);
  entryRef.current = entry;
  const entryId = entry?.id ?? null;

  useEffect(() => {
    if (!open) return;
    const entry = entryRef.current;
    setTitle(entry?.title ?? '');
    setModality(entry?.modality ?? 'MRI');
    setBodyPart(entry?.bodyPart ?? '');
    setDateText(entry?.performedAtText ?? entry?.performedAt ?? '');
    setInstitutionId(entry?.institutionId ?? '');
    setContrast(entry?.contrast ?? '');
    setImpression(entry?.impression ?? '');
    setFindings(entry?.findings ?? '');
    setDocumentId(entry?.documentId ?? '');
    setHasImages(entry?.hasImages ?? false);
    setNotes(entry?.notes ?? '');
  }, [open, entryId]);

  const canSubmit = !busy && (title.trim().length > 0 || modality.length > 0);

  function submit() {
    if (!canSubmit) return;
    const input: ImagingInput = {
      title: title.trim() || null,
      modality,
      bodyPart: bodyPart.trim() || null,
      performedAtText: dateText.trim() || null,
      institutionId: institutionId || null,
      contrast: contrast.trim() || null,
      impression: impression.trim() || null,
      findings: findings.trim() || null,
      documentId: documentId || null,
      hasImages,
      notes: notes.trim() || null,
    };
    if (editing && entry) onUpdate(entry.id, input);
    else onCreate(input);
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={editing ? 'Edit the scan' : 'Add a scan'}
      width={760}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!canSubmit} onClick={submit} shortcut="ctrl+enter" title="Ctrl+Enter also saves">
            {editing ? 'Save' : 'Add the scan'}
          </Button>
        </>
      }
    >
      <div
        className="stack"
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && canSubmit) {
            e.preventDefault();
            submit();
          }
        }}
      >
        {error ? <div className="notice bad small">{error}</div> : null}
        <div className="imaging-form-grid">
          <Field label="Type of scan">
            <Select autoFocus value={modality} options={IMAGING_MODALITIES.map((m) => ({ value: m, label: MODALITY_LONG_WORDS[m] ?? m }))} onChange={(e) => setModality(e.target.value)} />
          </Field>
          <Field label="Body part">
            <Input value={bodyPart} onChange={(e) => setBodyPart(e.target.value)} placeholder="e.g. knee, lumbar spine" />
          </Field>
          <Field label="Name" hint="Left empty, it is the type and the body part (MRI brain).">
            <Input value={title} onChange={(e) => setTitle(e.target.value)} />
          </Field>
          <Field label="Date of the scan" hint="As written is fine: 2024-04-02, April 2024, 2023. Empty if not known.">
            <Input value={dateText} onChange={(e) => setDateText(e.target.value)} placeholder="e.g. 2024-04-02" />
          </Field>
          <Field label="Where it was done">
            <Select value={institutionId} options={institutions.map((p) => ({ value: p.id, label: p.name }))} placeholder="Not given" onChange={(e) => setInstitutionId(e.target.value)} />
          </Field>
          <Field label="Contrast">
            <Input value={contrast} onChange={(e) => setContrast(e.target.value)} placeholder="e.g. with and without gadolinium" />
          </Field>
          <div className="full">
            <Field label="Impression" hint="The report's conclusion, as written.">
              <Textarea value={impression} onChange={(e) => setImpression(e.target.value)} rows={3} />
            </Field>
          </div>
          <div className="full">
            <Field label="Findings" hint="What the report describes, as written.">
              <Textarea value={findings} onChange={(e) => setFindings(e.target.value)} rows={4} />
            </Field>
          </div>
          <Field label="The report">
            <Select value={documentId} options={documents.map((d) => ({ value: d.id, label: d.title }))} placeholder="Not in the case yet" onChange={(e) => setDocumentId(e.target.value)} />
          </Field>
          <Field label="Images">
            <label className="row" style={{ gap: 6 }}>
              <input type="checkbox" checked={hasImages} onChange={(e) => setHasImages(e.target.checked)} /> You have the images (on a disc, as files, or in the portal)
            </label>
          </Field>
          <div className="full">
            <Field label="Notes">
              <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
            </Field>
          </div>
        </div>
      </div>
    </Dialog>
  );
}
