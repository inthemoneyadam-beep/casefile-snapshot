/**
 * /imaging/viewer/$id — the DICOM viewer (slice N).
 *
 * `$id` is a document id of kind dicom (the instance shown), or a study key
 * (StudyInstanceUID, or `doc:<documentId>` for a file without UIDs) with
 * `?study=1`, which opens that study's first series at its first image
 * (`latest?study=1` opens the newest study). The URL always ends up naming
 * the instance on screen, so a link reproduces the view:
 *   ?frame=   frame of a multi-frame instance (1-based)
 *   ?wc=&ww=  a window chosen with the keys (absent: the file's own window)
 *   ?tags=1   the tag panel is open
 *   ?q=       filter for the studies list
 *
 * Left: every study under a header with its series. Centre: the image, decoded
 * and windowed on the server (uncompressed syntaxes only; a compressed file
 * says so and offers the original), with one status line under it in words.
 * Right: where the images sit in the case, the study, this image and, with i,
 * every element of the file. Read-only for every role.
 *
 * The header: File details (i, a toggle) and Download the original (o); under
 * More, the scan these images belong to, the file's document and the way back.
 * The toolbar: Find (study or series name), Window: (the file's own, or the CT
 * presets brain, bone, soft tissue; else the full range), then the keys.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { ApiError } from '../api/client';
import { clearFrameCache, originalUrl, seriesQuery, useDicomInstance, useDicomSeries, useDicomStudies, useDicomTags, type DicomSeriesSummary, type FrameImage, type FrameRequest } from '../api/dicom';
import { useRegisterCommands } from '../app/commands';
import { useBindings } from '../app/shortcuts';
import { useDebouncedSearch } from '../app/useDebouncedSearch';
import { PageHeader } from '../ui/PageHeader';
import { DateText } from '../ui/DateText';
import { SearchField, Segmented, Toolbar } from '../ui/Toolbar';
import { ToolbarKeys } from '../ui/Toolbar';
import { CT_PRESETS, windowChoice, windowSourceWords, type WindowChoice } from '../features/dicom/window';
import { useToast } from '../ui/Toast';
import { SeriesList, seriesLabel } from '../features/dicom/SeriesList';
import { DicomStage } from '../features/dicom/DicomStage';
import { DicomSidePanel } from '../features/dicom/DicomSidePanel';
import '../features/dicom/dicom.css';

/** `1`, `"1"` or `true` from a hand-typed or generated URL. */
const flag = z.union([z.literal(1), z.literal('1'), z.literal(true), z.literal('true')]).transform(() => 1 as const);
/** The router parses `?q=123` as a number; keep it text. */
const text = z.union([z.string(), z.number().transform(String)]);

const searchSchema = z.object({
  study: flag.optional().catch(undefined),
  frame: z.coerce.number().int().min(1).optional().catch(undefined),
  wc: z.coerce.number().min(-1e7).max(1e7).optional().catch(undefined),
  ww: z.coerce.number().gt(0).max(1e7).optional().catch(undefined),
  tags: flag.optional().catch(undefined),
  q: text.optional().catch(undefined),
});
export type ViewerSearch = z.infer<typeof searchSchema>;

export const Route = createFileRoute('/imaging_/viewer/$id')({
  validateSearch: (s: Record<string, unknown>): ViewerSearch => searchSchema.parse(s),
  component: ViewerPage,
});


/** Server-side downscale steps: stable cache keys while the window is resized. */
const SCALE_STEPS = [0.125, 0.25, 0.375, 0.5, 0.75, 1];

function scaleFor(columns: number | null | undefined, rows: number | null | undefined, box: { w: number; h: number }): number {
  if (!columns || !rows || !box.w || !box.h) return 1;
  const dpr = typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, 2) : 1;
  const need = Math.min(box.w / columns, box.h / rows) * dpr;
  if (need >= 1) return 1;
  return SCALE_STEPS.find((s) => s >= need) ?? 1;
}

const short = (n: number) => String(Number(n.toPrecision(5)));

interface Position {
  documentId: string;
  frame: number;
}

function ViewerPage() {
  const { id } = Route.useParams();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const qc = useQueryClient();
  const toast = useToast();
  const studyMode = search.study === 1;
  const frame = search.frame ?? 1;
  const showTags = search.tags === 1;

  const [qLocal, setQLocal] = useDebouncedSearch(search.q, (q) => void navigate({ search: (prev) => ({ ...prev, q }), replace: true }));

  const studies = useDicomStudies(search.q ?? '');
  const instance = useDicomInstance(studyMode ? null : id);
  const instanceData = instance.data && instance.data.documentId === id ? instance.data : null;

  // While stepping, the next instance's detail is still loading: the series it was reached from stands in.
  const seriesHint = useRef<{ id: string; key: string } | null>(null);
  const seriesKey = instanceData?.seriesKey ?? (seriesHint.current?.id === id ? seriesHint.current.key : null);
  const series = useDicomSeries(studyMode ? null : seriesKey);
  const seriesData = series.data ?? null;
  const tagsQuery = useDicomTags(studyMode ? null : id, showTags);

  const positions = useMemo<Position[]>(() => (seriesData ? seriesData.instances.flatMap((inst) => Array.from({ length: Math.max(1, inst.frames) }, (_, f) => ({ documentId: inst.documentId, frame: f + 1 }))) : []), [seriesData]);
  const posIndex = positions.findIndex((p) => p.documentId === id && p.frame === frame);
  const instIndex = seriesData ? seriesData.instances.findIndex((i) => i.documentId === id) : -1;
  const currentInst = seriesData && instIndex >= 0 ? seriesData.instances[instIndex] : null;
  const studyItems = studies.data?.items ?? [];
  const flatSeries = useMemo(() => studyItems.flatMap((s) => s.series), [studyItems]);
  const selectedSeriesKey = seriesData?.series.key ?? seriesKey;
  const study = seriesData?.study ?? studyItems.find((s) => s.key === instanceData?.studyKey) ?? null;
  const modality = instanceData?.modality ?? seriesData?.series.modality ?? null;
  const isCT = modality === 'CT';

  // Stage size, for the server-side downscale of large images.
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = stageRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => setBox({ w: Math.round(e.contentRect.width), h: Math.round(e.contentRect.height) }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => () => clearFrameCache(), []);

  const columns = currentInst?.columns ?? instanceData?.columns ?? null;
  const rows = currentInst?.rows ?? instanceData?.rows ?? null;
  const scale = scaleFor(columns, rows, box);
  const known = Boolean(currentInst || instanceData);
  const knownProblem = currentInst && !currentInst.decodable ? currentInst.reason : instanceData && !instanceData.decodable ? instanceData.reason : null;
  const request: FrameRequest | null = !studyMode && known && !knownProblem ? { documentId: id, frame, wc: search.wc, ww: search.ww, scale } : null;
  const [shown, setShown] = useState<FrameImage | null>(null);

  // ?study=1: open the study's first series at its first image.
  const [opening, setOpening] = useState<string | null>(null);
  const studyMissing = studyMode && studies.isSuccess && !search.q && !studyItems.some((s) => s.key === id || s.studyUid === id) && !(id === 'latest' && studyItems.length);
  useEffect(() => {
    if (!studyMode || !studies.data) return;
    const st = studies.data.items.find((s) => s.key === id || s.studyUid === id) ?? (id === 'latest' ? studies.data.items[0] : undefined);
    if (st?.series[0]) void openSeries(st.series[0].key, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [studyMode, studies.data, id]);

  async function openSeries(key: string, replace = false) {
    setOpening(key);
    try {
      const d = await qc.fetchQuery(seriesQuery(key));
      const first = d.instances[0];
      if (!first) return;
      seriesHint.current = { id: first.documentId, key: d.series.key };
      // A new series opens with its own window.
      void navigate({ to: '/imaging/viewer/$id', params: { id: first.documentId }, search: (prev) => ({ tags: prev.tags, q: prev.q }), replace });
    } catch (err) {
      toast(err instanceof ApiError ? `Could not open the series: ${err.message}` : 'Could not open the series', 'bad');
    } finally {
      setOpening(null);
    }
  }

  function goTo(index: number) {
    const L = latest.current;
    const p = L.positions[index];
    if (!p) return;
    // Keys repeat faster than the route re-renders: the next press steps from here, not from the last render.
    L.posIndex = index;
    if (L.selectedSeriesKey) seriesHint.current = { id: p.documentId, key: L.selectedSeriesKey };
    void navigate({ to: '/imaging/viewer/$id', params: { id: p.documentId }, search: (prev) => ({ ...prev, study: undefined, frame: p.frame > 1 ? p.frame : undefined }), replace: true });
  }
  function step(delta: number) {
    const L = latest.current;
    if (!L.positions.length) return;
    const from = L.posIndex < 0 ? (delta > 0 ? -1 : L.positions.length) : L.posIndex;
    const to = Math.max(0, Math.min(L.positions.length - 1, from + delta));
    if (to !== L.posIndex) goTo(to);
  }
  function stepTo(index: number) {
    const L = latest.current;
    if (!L.positions.length) return;
    const to = index < 0 ? L.positions.length - 1 : 0;
    if (to !== L.posIndex) goTo(to);
  }
  function stepSeries(delta: number) {
    const L = latest.current;
    if (!L.flatSeries.length) return;
    const at = L.flatSeries.findIndex((s) => s.key === L.selectedSeriesKey);
    const to = at < 0 ? (delta > 0 ? 0 : L.flatSeries.length - 1) : at + delta;
    if (to < 0 || to >= L.flatSeries.length) {
      toast(delta > 0 ? 'This is the last series' : 'This is the first series');
      return;
    }
    void openSeries(L.flatSeries[to].key);
  }

  /** The window on screen: the URL's, else what the server applied, else the file's. */
  function effectiveWindow(): { center: number; width: number } | null {
    const L = latest.current;
    const base = L.shown?.window ?? L.instanceData?.defaultWindow ?? null;
    if (L.wc !== undefined && L.ww !== undefined) return { center: L.wc, width: L.ww };
    if (!base) return null;
    return { center: L.wc ?? base.center, width: L.ww ?? base.width };
  }
  function setWindow(center: number, width: number) {
    const r = (n: number) => Number(n.toPrecision(6));
    const wc = r(center);
    const ww = r(Math.max(width, 0.001));
    // As with stepping: a repeated key adjusts from this value even before the URL change renders.
    latest.current.wc = wc;
    latest.current.ww = ww;
    void navigate({ search: (prev) => ({ ...prev, wc, ww }), replace: true });
  }
  function noWindow() {
    toast(latest.current.shown ? 'This image is in colour: it has no window to adjust' : 'No image is shown');
  }
  function adjustWidth(factor: number) {
    const w = effectiveWindow();
    if (w) setWindow(w.center, w.width * factor);
    else noWindow();
  }
  function adjustCenter(sign: 1 | -1) {
    const w = effectiveWindow();
    if (w) setWindow(w.center + sign * 0.1 * w.width, w.width);
    else noWindow();
  }
  function resetWindow() {
    latest.current.wc = undefined;
    latest.current.ww = undefined;
    void navigate({ search: (prev) => ({ ...prev, wc: undefined, ww: undefined }), replace: true });
  }
  function preset(n: 2 | 3 | 4) {
    const L = latest.current;
    if (L.isCT) {
      const p = CT_PRESETS[n];
      setWindow(p.center, p.width);
      return;
    }
    if (n !== 2) return;
    const range = L.shown?.range ?? L.instanceData?.range ?? null;
    if (!range) return noWindow();
    setWindow((range.min + range.max) / 2, Math.max(range.max - range.min, 1));
  }
  function toggleTags() {
    void navigate({ search: (prev) => ({ ...prev, tags: prev.tags ? undefined : 1 }), replace: true });
  }
  function download() {
    const L = latest.current;
    if (L.studyMode || !L.id) return;
    const a = document.createElement('a');
    a.href = originalUrl(L.id);
    a.download = L.filename ?? '';
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
  function openDocument() {
    void navigate({ to: '/documents/$id', params: { id: latest.current.id } });
  }

  const linkedImaging = study?.imagingStudies.find((s) => s.linked) ?? null;
  const latest = useRef({ id, studyMode, positions, posIndex, flatSeries, selectedSeriesKey, shown, instanceData, wc: search.wc, ww: search.ww, isCT, filename: currentInst?.filename ?? instanceData?.filename ?? null, linkedImaging });
  latest.current = { id, studyMode, positions, posIndex, flatSeries, selectedSeriesKey, shown, instanceData, wc: search.wc, ww: search.ww, isCT, filename: currentInst?.filename ?? instanceData?.filename ?? null, linkedImaging };
  const hasImage = () => !latest.current.studyMode;

  useBindings(
    [
      { keys: 'j', description: 'Next image in the series', group: 'Page', run: () => step(1) },
      { keys: 'k', description: 'Previous image in the series', group: 'Page', run: () => step(-1) },
      { keys: 'ArrowDown', description: 'Next image', group: 'Page', run: () => step(1) },
      { keys: 'ArrowUp', description: 'Previous image', group: 'Page', run: () => step(-1) },
      { keys: 'ArrowRight', description: 'Next image', group: 'Page', run: () => step(1) },
      { keys: 'ArrowLeft', description: 'Previous image', group: 'Page', run: () => step(-1) },
      { keys: 'PageDown', description: 'Ten images on', group: 'Page', run: () => step(10) },
      { keys: 'PageUp', description: 'Ten images back', group: 'Page', run: () => step(-10) },
      { keys: 'Home', description: 'First image of the series', group: 'Page', run: () => stepTo(0) },
      { keys: 'End', description: 'Last image of the series', group: 'Page', run: () => stepTo(-1) },
      { keys: ']', description: 'Next series', group: 'Page', run: () => stepSeries(1) },
      { keys: '[', description: 'Previous series', group: 'Page', run: () => stepSeries(-1) },
      { keys: 'w', description: 'Less contrast: window width up 10 percent', group: 'Page', when: hasImage, run: () => adjustWidth(1.1) },
      { keys: 's', description: 'More contrast: window width down 10 percent', group: 'Page', when: hasImage, run: () => adjustWidth(1 / 1.1) },
      { keys: 'a', description: 'Brighter: window centre down by 10 percent of the width', group: 'Page', when: hasImage, run: () => adjustCenter(-1) },
      { keys: 'd', description: 'Darker: window centre up by 10 percent of the width', group: 'Page', when: hasImage, run: () => adjustCenter(1) },
      { keys: 'r', description: "Reset the window to the file's own", group: 'Page', run: () => resetWindow() },
      { keys: '1', description: "Window preset: the file's own", group: 'Page', run: () => resetWindow() },
      { keys: '2', description: 'Window preset: brain (CT), else the full value range', group: 'Page', when: hasImage, run: () => preset(2) },
      { keys: '3', description: 'Window preset: bone (CT)', group: 'Page', when: () => latest.current.isCT, run: () => preset(3) },
      { keys: '4', description: 'Window preset: soft tissue (CT)', group: 'Page', when: () => latest.current.isCT, run: () => preset(4) },
      { keys: 'i', description: 'Show or hide every detail stored in the file', group: 'Page', run: () => toggleTags() },
      { keys: 'o', description: 'Download the original file', group: 'Page', when: hasImage, run: () => download() },
    ],
    [],
  );

  useRegisterCommands(
    [
      { id: 'dicom.next-series', title: 'Scan images: next series', group: 'Imaging', keywords: 'viewer images scan dicom', shortcut: ']', run: () => stepSeries(1) },
      { id: 'dicom.prev-series', title: 'Scan images: previous series', group: 'Imaging', keywords: 'viewer images scan dicom', shortcut: '[', run: () => stepSeries(-1) },
      { id: 'dicom.tags', title: 'Scan images: show or hide every detail in the file', group: 'Imaging', keywords: 'tags header elements metadata dicom', shortcut: 'i', run: () => toggleTags() },
      { id: 'dicom.reset', title: "Scan images: back to the file's own window", group: 'Imaging', keywords: 'window level contrast brightness reset dicom', shortcut: 'r', run: () => resetWindow() },
      { id: 'dicom.brain', title: 'Scan images: brain window (CT 40 / 80)', group: 'Imaging', keywords: 'preset window level dicom', shortcut: '2', when: () => latest.current.isCT, run: () => preset(2) },
      { id: 'dicom.bone', title: 'Scan images: bone window (CT 400 / 1800)', group: 'Imaging', keywords: 'preset window level dicom', shortcut: '3', when: () => latest.current.isCT, run: () => preset(3) },
      { id: 'dicom.soft', title: 'Scan images: soft tissue window (CT 40 / 400)', group: 'Imaging', keywords: 'preset window level dicom', shortcut: '4', when: () => latest.current.isCT, run: () => preset(4) },
      { id: 'dicom.full', title: "Scan images: window over the image's full range", group: 'Imaging', keywords: 'preset window level dicom', shortcut: '2', when: () => !latest.current.isCT, run: () => preset(2) },
      { id: 'dicom.download', title: 'Scan images: download the original file', group: 'Imaging', keywords: 'export save dcm dicom', shortcut: 'o', when: hasImage, run: () => download() },
      { id: 'dicom.document', title: 'Scan images: open the document of this file', group: 'Imaging', keywords: 'source provenance dicom', when: hasImage, run: () => openDocument() },
      {
        id: 'dicom.imaging',
        title: 'Scan images: open the scan these images are attached to',
        group: 'Imaging',
        keywords: 'report impression',
        when: () => Boolean(latest.current.linkedImaging),
        run: () => {
          const s = latest.current.linkedImaging;
          if (s) void navigate({ to: '/imaging', search: { id: s.id } });
        },
      },
    ],
    [],
  );

  // What the centre says when there is no image to show.
  const instanceMissing = !studyMode && instance.isError && instance.error instanceof ApiError && instance.error.status === 404;
  // No image files at all says so first, whatever the address asked for ("latest" included).
  const noFiles = studies.isSuccess && !studyItems.length && !search.q;
  const idleText = noFiles
    ? 'No scan image files yet. The image files from a scan disc or portal (.dcm) appear here once they are added under Documents.'
    : studyMode
      ? studyMissing
        ? 'That study is not here (it may have been deleted). Choose a series on the left.'
        : 'Opening the study…'
      : instanceMissing
        ? 'That image file is not here (it was deleted, or it is not a scan image file). Choose a series on the left.'
        : instance.isError
          ? `Could not read this file: ${instance.error instanceof Error ? instance.error.message : 'error'}`
          : 'Reading the file…';

  const nInstances = seriesData?.instances.length ?? 0;
  const framesHere = currentInst?.frames ?? instanceData?.frames ?? 1;
  // The previous instance's detail stays up while the next one loads (same series: same spacing and thickness).
  const panelInstance = instance.data ?? null;
  const spacing = panelInstance?.pixelSpacing ?? null;
  const progress = positions.length > 1 && posIndex >= 0 ? (posIndex / (positions.length - 1)) * 100 : posIndex === 0 ? 100 : 0;
  const title = study?.description ?? seriesData?.series.description ?? instanceData?.studyDescription ?? 'Scan images';
  const leftEmpty = studies.isPending ? 'Loading the studies…' : studies.isError ? `Could not load the studies: ${studies.error instanceof Error ? studies.error.message : 'error'}` : search.q ? 'No study or series matches. Clear the Find box to see them all.' : 'No scan image files yet.';
  const choice: WindowChoice = windowChoice({ wc: search.wc, ww: search.ww, isCT, range: shown?.range ?? instanceData?.range ?? null });
  function chooseWindow(c: WindowChoice) {
    if (c === 'file') resetWindow();
    else if (c === 'brain') preset(2);
    else if (c === 'bone') preset(3);
    else if (c === 'soft') preset(4);
    else if (c === 'full') preset(2);
  }

  const prefetch = (): FrameRequest[] => {
    const L = latest.current;
    if (L.posIndex < 0) return [];
    return [1, 2, 3, -1]
      .map((d) => L.positions[L.posIndex + d])
      .filter((p): p is Position => Boolean(p))
      .map((p) => ({ documentId: p.documentId, frame: p.frame, wc: L.wc, ww: L.ww, scale }));
  };

  const windowOptions: Array<{ value: WindowChoice; label: string; title: string }> = isCT
    ? [
        { value: 'file', label: "File's own", title: "The window saved in the file (key 1)" },
        { value: 'brain', label: 'Brain', title: 'CT brain window, 40 / 80 (key 2)' },
        { value: 'bone', label: 'Bone', title: 'CT bone window, 400 / 1800 (key 3)' },
        { value: 'soft', label: 'Soft tissue', title: 'CT soft tissue window, 40 / 400 (key 4)' },
      ]
    : [
        { value: 'file', label: "File's own", title: 'The window saved in the file (key 1)' },
        { value: 'full', label: 'Full range', title: "Spread over every value in the image (key 2)" },
      ];

  return (
    <div className="page">
      <PageHeader
        title={title}
        meta={
          study ? (
            <span className="mono">
              <DateText iso={study.date} precision={study.datePrecision} text={study.dateText} />
              {study.modalities.length ? ` · ${study.modalities.join(', ')}` : ''} · {study.seriesCount} series · {study.instanceCount} image{study.instanceCount === 1 ? '' : 's'}
            </span>
          ) : null
        }
        intro="The image files of a scan (DICOM), one series at a time. Step through the images with j and k; nothing here changes the files."
        actions={{
          secondary: [
            { label: 'File details', onClick: () => toggleTags(), shortcut: 'i', pressed: showTags, disabled: studyMode || noFiles, title: showTags ? 'Hide every detail stored in the file' : 'Every detail stored in the file, with its name' },
            { label: 'Download the original', onClick: () => download(), shortcut: 'o', disabled: studyMode, title: 'Save the original file, unchanged, to open it in another scan viewer' },
          ],
          more: [
            { label: 'Open the scan these images belong to', onClick: () => linkedImaging && void navigate({ to: '/imaging', search: { id: linkedImaging.id } }), hidden: !linkedImaging, title: 'The scan in Scans and imaging that these images are attached to' },
            { label: 'Open the document of this file', onClick: () => openDocument(), disabled: studyMode, title: 'The file in Documents, with where it came from' },
            'separator',
            { label: 'Back to Scans and imaging', onClick: () => void navigate({ to: '/imaging' }) },
          ],
        }}
      />
      <Toolbar label="Find and window">
        <SearchField label="Find" placeholder="Study or series name" value={qLocal} onChange={setQLocal} width={200} />
        <Segmented
          label="Window"
          value={choice}
          onChange={chooseWindow}
          options={windowOptions.map((o) => ({ ...o, disabled: studyMode }))}
        />
        <ToolbarKeys
          items={[
            ['j/k', 'image'],
            ['[/]', 'series'],
            ['w/s', 'contrast'],
            ['a/d', 'brightness'],
            ['r', 'reset'],
            ['i', 'file details'],
            ['o', 'original'],
          ]}
        />
      </Toolbar>
      <div className="page-body flush">
        <div className="dicom-viewer">
          <div className="dicom-col">
            <SeriesList studies={studyItems} selectedKey={opening ?? selectedSeriesKey} onOpen={(s: DicomSeriesSummary) => void openSeries(s.key)} emptyText={leftEmpty} footer={studies.data ? <span>{studies.data.instances} file{studies.data.instances === 1 ? '' : 's'}</span> : null} />
          </div>
          <div className="dicom-col">
            <DicomStage
              request={request}
              knownProblem={knownProblem}
              alt={`${seriesLabel({ description: seriesData?.series.description ?? instanceData?.seriesDescription ?? null, modality, number: seriesData?.series.number ?? null })}${instIndex >= 0 ? `, image ${instIndex + 1} of ${nInstances}` : ''}`}
              stageRef={stageRef}
              onFrame={setShown}
              prefetch={prefetch}
              onDownload={studyMode ? null : download}
              idleText={idleText}
            />
            <div className="dicom-scrub" aria-hidden>
              <span style={{ width: `${progress}%` }} />
            </div>
            <div className="dicom-status" role="status">
              {seriesData && instIndex >= 0 ? (
                <span className="lead">
                  Image <span className="mono">{instIndex + 1}</span> of <span className="mono">{nInstances}</span>
                  {framesHere > 1 ? (
                    <>
                      {' '}
                      · frame <span className="mono">{frame}</span> of <span className="mono">{framesHere}</span>
                    </>
                  ) : null}
                </span>
              ) : (
                <span className="muted">{opening ? 'Opening the series…' : studyMode ? '' : series.isPending && seriesKey ? 'Reading the series…' : ''}</span>
              )}
              {shown?.window ? (
                <span title="Window centre / width: brightness and contrast">
                  Window <span className="mono">{short(shown.window.center)} / {short(shown.window.width)}</span> <span className="muted">({windowSourceWords(shown.window.source)})</span>
                </span>
              ) : shown ? (
                <span className="muted">Colour image: no window</span>
              ) : null}
              {spacing ? (
                <span>
                  Pixels <span className="mono">{spacing.map((v) => short(v)).join(' × ')} mm</span>
                </span>
              ) : null}
              {panelInstance?.sliceThickness ? (
                <span>
                  Slices <span className="mono">{short(panelInstance.sliceThickness)} mm</span>
                </span>
              ) : null}
              {currentInst?.sliceLocation !== null && currentInst?.sliceLocation !== undefined ? (
                <span>
                  At <span className="mono">{short(currentInst.sliceLocation)} mm</span>
                </span>
              ) : null}
              <span className="spacer" />
              {columns && rows ? (
                <span className="muted">
                  <span className="mono">
                    {columns} × {rows}
                  </span>
                  {shown && scale < 1 ? ` · shown at ${Math.round(scale * 100)}%` : ''}
                </span>
              ) : null}
            </div>
          </div>
          <DicomSidePanel
            study={study}
            instance={studyMode ? null : panelInstance}
            showTags={showTags}
            tags={tagsQuery.data?.items ?? null}
            tagsLoading={tagsQuery.isFetching && !tagsQuery.data}
            tagsError={tagsQuery.error instanceof Error ? tagsQuery.error.message : null}
            onToggleTags={() => toggleTags()}
          />
        </div>
      </div>
    </div>
  );
}
