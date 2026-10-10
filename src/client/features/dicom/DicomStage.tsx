/**
 * The image: one frame from GET /api/dicom/instances/:id/frame/:n.png on the
 * sunken background, scaled to fit with its aspect kept. The previous image
 * stays up while the next one loads (no flicker while scrolling a series);
 * a refusal (415 for a compressed syntax) says why in words and offers the
 * original instead.
 */
import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../../api/client';
import { cachedFrame, frameKey, loadFrame, prefetchFrames, type FrameImage, type FrameRefusal, type FrameRequest } from '../../api/dicom';
import { Button } from '../../ui/Button';

export interface StageProblem {
  status: number;
  message: string;
  /** compressed: an encapsulated transfer syntax; layout: a pixel layout this build does not read; null: anything else. */
  kind: 'compressed' | 'layout' | null;
  /** What the server named: the transfer syntax, or the layout ("photometric interpretation PALETTE COLOR"). */
  detail: string | null;
}

const PREFIX = /^not decodable in this build:\s*/i;

/** A reason the listing already gave (the file was indexed), in the same shape as a refusal from the frame endpoint. */
function problemFromReason(reason: string): StageProblem {
  if (!PREFIX.test(reason)) return { status: 404, message: reason, kind: null, detail: null };
  const detail = reason.replace(PREFIX, '');
  const layout = /photometric|bit|samples per pixel/i.test(detail);
  return { status: 415, message: reason, kind: layout ? 'layout' : 'compressed', detail };
}

export function DicomStage({
  request,
  knownProblem,
  alt,
  stageRef,
  onFrame,
  onProblem,
  prefetch,
  onDownload,
  idleText,
}: {
  request: FrameRequest | null;
  /** Known before asking (the series listing already says the file is compressed): no request is made. */
  knownProblem: string | null;
  alt: string;
  stageRef: React.RefObject<HTMLDivElement | null>;
  onFrame: (f: FrameImage | null) => void;
  onProblem?: (p: StageProblem | null) => void;
  /** Frames to warm after this one shows. */
  prefetch: () => FrameRequest[];
  onDownload: (() => void) | null;
  idleText: string;
}) {
  const [shown, setShown] = useState<FrameImage | null>(null);
  const [problem, setProblem] = useState<StageProblem | null>(null);
  const [pending, setPending] = useState(false);
  const cb = useRef({ onFrame, onProblem, prefetch });
  cb.current = { onFrame, onProblem, prefetch };
  const key = request ? frameKey(request) : '';

  useEffect(() => {
    if (!request) {
      const p = knownProblem ? problemFromReason(knownProblem) : null;
      setPending(false);
      setShown(null);
      setProblem(p);
      cb.current.onFrame(null);
      cb.current.onProblem?.(p);
      return;
    }
    let live = true;
    const show = (img: FrameImage) => {
      setShown(img);
      setProblem(null);
      setPending(false);
      cb.current.onFrame(img);
      cb.current.onProblem?.(null);
      prefetchFrames(cb.current.prefetch());
    };
    const hit = cachedFrame(request);
    if (hit) {
      show(hit);
      return;
    }
    setPending(true);
    loadFrame(request).then(
      (img) => live && show(img),
      (err: unknown) => {
        if (!live) return;
        const body = err instanceof ApiError ? (err.body as FrameRefusal | null) : null;
        const message = body?.error ?? (err instanceof Error ? err.message : String(err));
        const status = err instanceof ApiError ? err.status : 0;
        const p: StageProblem =
          status === 415
            ? { status, message, kind: body?.reason === 'compressed' ? 'compressed' : 'layout', detail: body?.reason === 'compressed' ? (body.transferSyntaxName ?? null) : message.replace(PREFIX, '') }
            : { status, message, kind: null, detail: null };
        setShown(null);
        setProblem(p);
        setPending(false);
        cb.current.onFrame(null);
        cb.current.onProblem?.(p);
      },
    );
    return () => {
      live = false;
    };
    // The request is identified by its key; knownProblem only matters without one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, knownProblem]);

  return (
    <div className={`dicom-stage${pending ? ' pending' : ''}`} ref={stageRef}>
      {problem ? (
        <div className="dicom-message" role="status">
          {problem.status === 415 ? (
            <>
              <strong>This viewer cannot show these images.</strong>
              <span>{problem.kind === 'compressed' ? 'They are stored compressed, and this viewer shows uncompressed images only.' : 'This viewer shows 8 and 16-bit greyscale and 8-bit colour images only.'}</span>
              {problem.detail ? <span className="muted small">How the file stores them: {problem.detail}.</span> : null}
              <span>The original file is kept as it is; download it to open it in another scan viewer.</span>
            </>
          ) : problem.status === 404 ? (
            <span>{problem.message || 'This image is not on file.'}</span>
          ) : (
            <span>Could not show this image: {problem.message}</span>
          )}
          {onDownload ? (
            <Button size="sm" variant="accent" onClick={onDownload} shortcut="o">
              Download the original
            </Button>
          ) : null}
        </div>
      ) : shown ? (
        <img src={shown.url} alt={alt} draggable={false} />
      ) : (
        <div className="dicom-message">
          <span>{pending ? 'Loading the image…' : idleText}</span>
        </div>
      )}
    </div>
  );
}
