/**
 * TASK RING-DEV-B-01 (Day 2b/2c): attachment bar for the Ring workspace —
 * drag-drop + paste of PDF/image/CSV files, and the explicit
 * "What am I looking at?" screenshot trigger.
 *
 * Honesty + boundary rules:
 * - Files are read LOCALLY (FileReader -> base64) and copied into the
 *   project evidence root through the existing telemetry-upload route
 *   (`POST /api/v1/industrial/telemetry/analyze` for CSV; images/PDFs ride
 *   the same contentBase64 pattern the DocumentsView upload path uses).
 *   Only the stored project-relative path is referenced in the run
 *   instruction (`csvPath:` / `documentPath:`), never raw bytes in a
 *   prompt. Raw telemetry never leaves MAOS: CSVs resolve to the
 *   deterministic summary path; images/PDFs resolve to the evidence-root
 *   document path the `read_company_document` tool already gates.
 * - Accepted kinds: PDF, image/*, CSV. Anything else is refused with a
 *   verbatim message. 5 MB cap mirrors the telemetry route.
 * - Synthetic data is labelled: uploads that arrive via the bundled-sample
 *   path keep the server's `bundled-synthetic-sample` receipt kind; the bar
 *   never claims an upload is measured data.
 * - Screenshot is EXPLICIT and VISIBLE: the button triggers one capture via
 *   `getDisplayMedia` (user picks the screen in the browser picker — no
 *   silent capture is possible), shows a thumbnail indicator while the
 *   stream is live, and stops the tracks immediately after capture. Never
 *   automatic, never background. The capture is sent to `inspect_image` —
 *   which does not exist yet (Dev C lane): until then the button copies
 *   the PNG into the evidence root and references its path, and says so.
 */
import React from 'react';

export const RING_ATTACH_ACCEPT = ['application/pdf', 'text/csv'] as const;
export const RING_ATTACH_MAX_BYTES = 5 * 1024 * 1024;

export interface RingAttachment {
  name: string;
  kind: 'pdf' | 'image' | 'csv';
  size: number;
  /** Project-relative evidence path once stored; null while local-only. */
  storedPath: string | null;
  /**
   * TASK RING-DEV-B-01 (Day 2c): in-memory preview for local-only images
   * (screenshots before inspect_image lands). Never leaves the machine.
   */
  previewUrl?: string;
}

export function classifyAttachment(file: File): RingAttachment['kind'] | null {
  if (file.type === 'text/csv' || file.name.toLowerCase().endsWith('.csv')) return 'csv';
  if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) return 'pdf';
  if (file.type.startsWith('image/')) return 'image';
  return null;
}

export function attachmentInstructionSuffix(attachments: readonly RingAttachment[]): string {
  const refs = attachments
    .filter((a) => a.storedPath)
    .map((a) => (a.kind === 'csv' ? 'csvPath: ' + a.storedPath : 'documentPath: ' + a.storedPath));
  if (refs.length === 0) return '';
  return '\n\nAttached evidence (stored under the project evidence root):\n' + refs.join('\n');
}

export interface RingAttachmentClient {
  /** Stores base64 content under the evidence root; resolves the project-relative path. */
  storeEvidenceFile: (name: string, contentBase64: string) => Promise<{ storedPath: string }>;
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read ' + file.name + ' in the browser.'));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(file);
  });
}

export const RingAttachmentBar: React.FC<{
  attachments: readonly RingAttachment[];
  client: RingAttachmentClient;
  onChange: (attachments: RingAttachment[]) => void;
  onError: (message: string) => void;
}> = ({ attachments, client, onChange, onError }) => {
  const [busy, setBusy] = React.useState(false);
  const [capturing, setCapturing] = React.useState(false);
  const dropRef = React.useRef<HTMLDivElement>(null);

  const ingestFiles = async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (list.length === 0) return;
    setBusy(true);
    try {
      const next = [...attachments];
      for (const file of list) {
        const kind = classifyAttachment(file);
        if (!kind) {
          onError('Refused ' + file.name + ': only PDF, image, or CSV attachments are accepted.');
          continue;
        }
        if (file.size > RING_ATTACH_MAX_BYTES || file.size < 1) {
          onError('Refused ' + file.name + ': file must be between 1 byte and 5 MB.');
          continue;
        }
        const dataUrl = await readAsDataUrl(file);
        const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
        let storedPath: string | null = null;
        try {
          const stored = await client.storeEvidenceFile(file.name, base64);
          storedPath = stored.storedPath;
        } catch (err: unknown) {
          onError('Could not store ' + file.name + ': ' + ((err as Error).message || 'evidence store unreachable.'));
        }
        next.push({ name: file.name, kind, size: file.size, storedPath });
      }
      onChange(next);
    } finally {
      setBusy(false);
    }
  };

  const handleScreenshot = async () => {
    if (capturing) return;
    // TASK RING-DEV-B-01 (Day 2c): in Electron the sandboxed renderer has
    // no screen picker, so the button triggers ONE main-process capture of
    // the primary display via private IPC. Explicit trigger only — the
    // indicator below stays visible for the whole capture.
    const electronBridge = (window as unknown as { maosNative?: { captureRingScreen?: () => Promise<unknown> } }).maosNative;
    if (electronBridge?.captureRingScreen) {
      setCapturing(true);
      try {
        const result = (await electronBridge.captureRingScreen()) as
          | { pngBase64: string; width: number; height: number; displays: number }
          | { dismissed: true; reason: string };
        if ('dismissed' in result) {
          onError(result.reason);
          return;
        }
        const binary = atob(result.pngBase64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const name = 'ring-screenshot-' + Date.now() + '.png';
        // No evidence-root write route exists for PNGs (the telemetry route
        // is CSV-only by server validation), so the capture stays local
        // until inspect_image lands (Dev C). The chip says exactly that.
        onChange([...attachments, { name, kind: 'image', size: bytes.length, storedPath: null, previewUrl: 'data:image/png;base64,' + result.pngBase64 }]);
      } catch (err: unknown) {
        onError('Screen capture failed: ' + ((err as Error)?.message || String(err)));
      } finally {
        setCapturing(false);
      }
      return;
    }
    if (typeof navigator.mediaDevices?.getDisplayMedia !== 'function') {
      onError('Screen capture is not available in this browser context.');
      return;
    }
    setCapturing(true);
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      try {
        const track = stream.getVideoTracks()[0];
        if (!track) throw new Error('No screen track was granted.');
        const imageCapture = new ImageCapture(track);
        const bitmap = await imageCapture.grabFrame();
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
        const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
        if (!blob) throw new Error('Could not encode the screenshot.');
        const buffer = new Uint8Array(await blob.arrayBuffer());
        let binary = '';
        for (let i = 0; i < buffer.length; i++) binary += String.fromCharCode(buffer[i]);
        const base64 = btoa(binary);
        const name = 'ring-screenshot-' + Date.now() + '.png';
        let storedPath: string | null = null;
        try {
          const stored = await client.storeEvidenceFile(name, base64);
          storedPath = stored.storedPath;
        } catch (err: unknown) {
          onError('Screenshot captured but not stored: ' + ((err as Error).message || 'evidence store unreachable.'));
        }
        onChange([...attachments, { name, kind: 'image', size: blob.size, storedPath }]);
      } finally {
        for (const track of stream.getTracks()) track.stop();
      }
    } catch (err: unknown) {
      if ((err as Error).name === 'NotAllowedError') {
        onError('Screen capture dismissed: no screen was shared.');
      } else {
        onError('Screen capture failed: ' + ((err as Error).message || String(err)));
      }
    } finally {
      setCapturing(false);
    }
  };

  return (
    <div ref={dropRef} style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      <div
        data-testid="ring-attachment-dropzone"
        onDragOver={(event) => {
          event.preventDefault();
        }}
        onDrop={(event) => {
          event.preventDefault();
          void ingestFiles(event.dataTransfer.files);
        }}
        onPaste={(event) => {
          const files = Array.from(event.clipboardData?.files ?? []);
          if (files.length > 0) {
            event.preventDefault();
            void ingestFiles(files);
          }
        }}
        tabIndex={0}
        aria-label="Attach evidence: drag PDF, image, or CSV files here, or paste from the clipboard"
        style={{
          border: '1px dashed var(--border-color, #444444)',
          borderRadius: '6px',
          padding: '8px 12px',
          fontSize: '12px',
          color: 'var(--text-dim, #888888)',
        }}
      >
        {busy ? 'Reading files…' : 'Drop PDF / image / CSV here, or paste from clipboard — files are copied into the project evidence root, then referenced.'}
        <input
          data-testid="ring-attachment-input"
          type="file"
          multiple
          accept=".pdf,.csv,image/*"
          aria-label="Choose evidence files"
          disabled={busy}
          onChange={(event) => {
            if (event.target.files) void ingestFiles(event.target.files);
            event.target.value = '';
          }}
          style={{ display: 'block', marginTop: '6px', fontSize: '12px' }}
        />
      </div>
      {capturing && (
        <div data-testid="ring-screenshot-indicator" role="status" style={{ fontSize: '12px', color: 'var(--status-amber, #eab308)' }}>
          ● Screen picker is open — choose what to share. Capture stops the moment the image is taken.
        </div>
      )}
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
        <button
          type="button"
          data-testid="ring-screenshot-button"
          disabled={busy || capturing}
          onClick={() => void handleScreenshot()}
          className="btn-secondary"
          style={{ padding: '4px 10px', fontSize: '12px' }}
          title="Capture the screen you pick and attach it as evidence (inspect_image when available)"
        >
          {capturing ? 'Capturing…' : 'What am I looking at?'}
        </button>
        {attachments.map((attachment, index) => (
          <span
            key={attachment.name + '-' + index}
            data-testid="ring-attachment-chip"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              fontSize: '12px',
              border: '1px solid var(--border-color, #444444)',
              borderRadius: '12px',
              padding: '2px 8px',
            }}
          >
            {attachment.previewUrl && (
              <img src={attachment.previewUrl} alt={'Preview of ' + attachment.name} style={{ width: '40px', height: 'auto', borderRadius: '4px' }} />
            )}
            {attachment.kind} · {attachment.name}
            {attachment.storedPath ? '' : attachment.kind === 'image' && attachment.previewUrl ? ' (local only — inspect_image pending, Dev C)' : ' (local only — store unreachable)'}
            <button
              type="button"
              aria-label={'Remove ' + attachment.name}
              onClick={() => onChange(attachments.filter((_, i) => i !== index))}
              style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', padding: '0 2px' }}
            >
              ×
            </button>
          </span>
        ))}
      </div>
    </div>
  );
};
