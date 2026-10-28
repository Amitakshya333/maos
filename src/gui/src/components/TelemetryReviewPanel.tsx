import React, { useEffect, useRef, useState } from 'react';
import { apiAdapter } from '../api';
import type { IndustrialAnalysisAgentResponse, IndustrialTelemetryAnalysisResponse, JudgedRunResponse } from '../api/rest-client';

function fileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read the selected file.'));
    reader.onload = () => {
      const dataUrl = String(reader.result || '');
      const separator = dataUrl.indexOf(',');
      if (separator < 0) reject(new Error('The selected file could not be encoded.'));
      else resolve(dataUrl.slice(separator + 1));
    };
    reader.readAsDataURL(file);
  });
}

export const TelemetryReviewPanel: React.FC = () => {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [analysis, setAnalysis] = useState<IndustrialTelemetryAnalysisResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [busySource, setBusySource] = useState<'sample' | 'file' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [agentRequest, setAgentRequest] = useState('Summarize the measured vibration and temperature values against the configured demo thresholds. Do not infer causes or recommend an operating action.');
  const [agentResult, setAgentResult] = useState<IndustrialAnalysisAgentResponse | null>(null);
  const [agentPhase, setAgentPhase] = useState<'idle' | 'uploading' | 'requesting' | 'completed' | 'failed' | 'cancelled'>('idle');
  const [agentError, setAgentError] = useState<string | null>(null);
  const [reviewRun, setReviewRun] = useState<JudgedRunResponse | null>(null);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const agentController = useRef<AbortController | null>(null);

  useEffect(() => {
    const runId = window.localStorage.getItem('maos:last-industrial-judged-run');
    if (!runId?.startsWith('judged-run-agent-')) return;
    let active = true;
    void apiAdapter.getIndustrialJudgedRun(runId).then((run) => {
      if (active) setReviewRun(run);
    }).catch(() => {
      if (active) setReviewError('Could not reconnect to the saved review run. Check the authenticated service and approvals queue.');
    });
    return () => { active = false; };
  }, []);

  const runAnalysis = async (useSample: boolean) => {
    setBusy(true);
    setBusySource(useSample ? 'sample' : 'file');
    setError(null);
    setAnalysis(null);
    setAgentResult(null);
    setAgentPhase('idle');
    setAgentError(null);
    try {
      const response = useSample
        ? await apiAdapter.analyzeIndustrialTelemetry({ useBundledSample: true })
        : selectedFile
          ? await apiAdapter.analyzeIndustrialTelemetry({
              name: selectedFile.name,
              contentBase64: await fileAsBase64(selectedFile),
            })
          : null;
      if (!response) throw new Error('Choose a CSV file first, or use the bundled synthetic sample.');
      setAnalysis(response);
    } catch (err: unknown) {
      setError((err as Error).message || 'Telemetry analysis failed.');
    } finally {
      setBusy(false);
      setBusySource(null);
    }
  };

  const askAboutSelectedCsv = async () => {
    if (!selectedFile || busy || agentPhase === 'uploading' || agentPhase === 'requesting') return;
    const controller = new AbortController();
    agentController.current = controller;
    setAgentResult(null);
    setReviewRun(null);
    setReviewError(null);
    setAnalysis(null);
    setAgentError(null);
    setAgentPhase('uploading');
    try {
      const selectedReceipt = await apiAdapter.analyzeIndustrialTelemetry({
        name: selectedFile.name,
        contentBase64: await fileAsBase64(selectedFile),
      }, { signal: controller.signal, timeoutMs: 30_000 });
      if (controller.signal.aborted) return;
      setAnalysis(selectedReceipt);
      setAgentPhase('requesting');
      const result = await apiAdapter.analyzeIndustrialCsv({
        request: agentRequest,
        sourcePath: selectedReceipt.source.relativePath,
      }, { signal: controller.signal, timeoutMs: 65_000 });
      if (controller.signal.aborted) return;
      setAgentResult(result);
      setAgentPhase('completed');
    } catch (err: unknown) {
      if (controller.signal.aborted) {
        setAgentPhase('cancelled');
        setAgentError('Cancelled. No successful model result was returned; retry to start a new run.');
      } else {
        const message = (err as Error).message || 'The analysis request failed.';
        const timedOut = /timed out|timeout/i.test(message);
        setAgentPhase('failed');
        setAgentError(`${timedOut ? 'Timed out' : 'Failed'}: ${message} Retry is available.`);
      }
    } finally {
      if (agentController.current === controller) agentController.current = null;
    }
  };

  const cancelAgentRequest = () => agentController.current?.abort();

  const openAgentReview = async () => {
    if (!agentResult || reviewBusy) return;
    if (reviewRun) {
      window.location.hash = '#/approvals';
      return;
    }
    setReviewBusy(true);
    setReviewError(null);
    try {
      const run = await apiAdapter.prepareIndustrialAgentReview(agentResult.evidence.analysisId);
      setReviewRun(run);
      window.localStorage.setItem('maos:last-industrial-judged-run', run.runId);
      if (run.status === 'pending_approval') window.location.hash = '#/approvals';
    } catch (err: unknown) {
      setReviewError((err as Error).message || 'Could not prepare the persisted review package.');
    } finally {
      setReviewBusy(false);
    }
  };

  const verdictColor = analysis?.result.verdict === 'CRITICAL'
    ? '#ff7b72'
    : analysis?.result.verdict === 'WARNING' ? '#e3b341' : '#3fb950';

  return (
    <section
      aria-label="Local telemetry evidence review"
      style={{
        padding: 18,
        borderRadius: 10,
        border: '1px solid var(--border-color, #30363d)',
        background: 'var(--card-bg, #161b22)',
        marginBottom: 18,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 17 }}>Evidence review · CSV telemetry</h2>
          <p style={{ margin: '6px 0 0', color: 'var(--text-dim, #8b949e)', fontSize: 12, maxWidth: 690 }}>
            Select a CSV from this device or use the bundled synthetic sample. MAOS applies the displayed demo thresholds locally, records the source hash, and can replay the calculation from the CLI.
          </p>
        </div>
        <span style={{ color: '#8b949e', border: '1px solid #30363d', padding: '4px 8px', borderRadius: 14, fontSize: 10, letterSpacing: 0.5 }}>
          DEMO RULES · NOT OPERATING AUTHORIZATION
        </span>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: 14 }}>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, border: '1px solid #3d444d', borderRadius: 6, padding: '8px 11px', fontSize: 12, cursor: 'pointer', background: '#0d1117' }}>
          <span style={{ fontWeight: 600 }}>Choose CSV from this device</span>
          <input
            aria-label="Choose telemetry CSV from this device"
            type="file"
            accept=".csv,text/csv"
            onChange={(event) => {
              setSelectedFile(event.target.files?.[0] || null);
              setAnalysis(null);
              setAgentResult(null);
              setAgentPhase('idle');
              setAgentError(null);
              setError(null);
            }}
            disabled={busy || agentPhase === 'uploading' || agentPhase === 'requesting'}
            style={{ maxWidth: 230, fontSize: 11 }}
          />
        </label>
        <button
          className="btn-primary"
          type="button"
          disabled={!selectedFile || busy || agentPhase === 'uploading' || agentPhase === 'requesting'}
          onClick={() => void runAnalysis(false)}
          style={{ border: '1px solid #238636', borderRadius: 6, padding: '9px 12px', background: !selectedFile || busy ? '#21262d' : '#238636', color: '#fff', fontWeight: 600, cursor: !selectedFile || busy ? 'not-allowed' : 'pointer' }}
        >
          {busy && busySource === 'file' ? 'Analyzing…' : 'Analyze selected CSV'}
        </button>
        <button
          className="secondary-btn"
          type="button"
          disabled={busy || agentPhase === 'uploading' || agentPhase === 'requesting'}
          onClick={() => void runAnalysis(true)}
          style={{ border: '1px solid #484f58', borderRadius: 6, padding: '9px 12px', background: '#21262d', color: '#e6edf3', fontWeight: 600, cursor: busy ? 'not-allowed' : 'pointer' }}
        >
          {busy && busySource === 'sample' ? 'Loading sample…' : 'Use bundled synthetic sample'}
        </button>
        <span style={{ color: '#8b949e', fontSize: 11 }}>
          {selectedFile ? `${selectedFile.name} · ${(selectedFile.size / 1024).toFixed(1)} KB` : 'Required columns: vibration_rms_mm_s, bearing_temperature_c · max 5 MB'}
        </span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(220px, 1fr) auto auto', alignItems: 'end', gap: 10, marginTop: 12 }}>
        <label style={{ color: '#8b949e', fontSize: 11 }}>
          Request to the configured local model
          <textarea
            aria-label="Request about selected CSV"
            value={agentRequest}
            maxLength={4000}
            rows={2}
            onChange={(event) => setAgentRequest(event.target.value)}
            disabled={agentPhase === 'uploading' || agentPhase === 'requesting'}
            style={{ display: 'block', width: '100%', boxSizing: 'border-box', marginTop: 5, padding: 8, borderRadius: 6, color: '#e6edf3', background: '#0d1117', border: '1px solid #3d444d', font: 'inherit' }}
          />
        </label>
        <button
          type="button"
          aria-label="Ask about this CSV"
          disabled={!selectedFile || !agentRequest.trim() || busy || agentPhase === 'uploading' || agentPhase === 'requesting'}
          onClick={() => void askAboutSelectedCsv()}
          style={{ border: '1px solid #1f6feb', borderRadius: 6, padding: '9px 12px', background: !selectedFile || !agentRequest.trim() || busy || agentPhase === 'uploading' || agentPhase === 'requesting' ? '#21262d' : '#1f6feb', color: '#fff', fontWeight: 600, cursor: !selectedFile || agentPhase === 'uploading' || agentPhase === 'requesting' ? 'not-allowed' : 'pointer' }}
        >
          {agentPhase === 'uploading' ? 'Preparing selected CSV…' : agentPhase === 'requesting' ? 'Waiting for local model…' : 'Ask about this CSV'}
        </button>
        {(agentPhase === 'uploading' || agentPhase === 'requesting') && (
          <button type="button" onClick={cancelAgentRequest} style={{ border: '1px solid #da3633', borderRadius: 6, padding: '9px 12px', color: '#ff7b72', background: '#21262d' }}>
            Cancel request
          </button>
        )}
      </div>

      {agentPhase !== 'idle' && (
        <div role="status" aria-live="polite" style={{ marginTop: 10, color: agentPhase === 'failed' || agentPhase === 'cancelled' ? '#ff7b72' : '#8b949e', fontSize: 11 }}>
          Request: {agentPhase} · Tool execution: {agentResult ? 'completed' : agentPhase === 'requesting' ? 'awaiting model tool call' : agentPhase === 'failed' || agentPhase === 'cancelled' ? 'not confirmed' : 'not started'}
        </div>
      )}
      {agentError && <div role="alert" style={{ marginTop: 8, color: '#ff7b72', fontSize: 11 }}>{agentError}</div>}

      {agentResult && (
        <div data-testid="industrial-agent-result" style={{ marginTop: 14, border: '1px solid #30363d', borderRadius: 7, padding: 12, background: '#0d1117' }}>
          <h3 style={{ margin: '0 0 8px', color: '#e6edf3', fontSize: 14 }}>CSV analysis result · provider tool call completed</h3>
          <div style={{ color: '#8b949e', fontSize: 11, lineHeight: 1.7 }}>
            Selected source: <code>{selectedFile?.name}</code> · project path <code>{agentResult.evidence.source.selectedPath}</code><br />
            Provider: <code>{agentResult.provider}</code> · requested model: <code>{agentResult.requestedModel}</code> · provider-reported model: <code>{agentResult.reportedModel ?? 'unavailable'}</code><br />
            Request: completed · analysis tool: completed · receipt/replay checks: passed
          </div>
          <div style={{ marginTop: 10, paddingTop: 9, borderTop: '1px solid #30363d', fontSize: 11 }}>
            <strong style={{ color: '#3fb950' }}>Numeric findings · same-analyzer replay matched</strong>
            <div style={{ color: '#c9d1d9', marginTop: 5 }}>
              {String(agentResult.evidence.result.rowsAnalyzed)} rows · RMS vibration {Number(agentResult.evidence.result.overallVibrationRms).toFixed(3)} mm/s · peak vibration {Number(agentResult.evidence.result.peakVibration).toFixed(2)} mm/s · peak temperature {Number(agentResult.evidence.result.peakTemperature).toFixed(1)} °C · {String(agentResult.evidence.result.warningCount)} warnings / {String(agentResult.evidence.result.criticalCount)} critical · verdict {String(agentResult.evidence.result.verdict)}
            </div>
            <div style={{ marginTop: 5, color: '#8b949e' }}>Recomputed by the same TypeScript analyzer against the persisted source and rules; this is not an independent implementation check.</div>
            <div style={{ marginTop: 5, color: '#8b949e' }}>Receipt: <code>{agentResult.evidence.analysisId}</code> · <code>{agentResult.evidence.receiptPath}</code> · SHA-256 <code>{agentResult.evidence.receiptSha256}</code></div>
            <div style={{ marginTop: 5, color: '#8b949e' }}>Generated report: <code>{agentResult.reportPath}</code> · SHA-256 <code>{agentResult.reportSha256}</code></div>
            <div style={{ marginTop: 5, color: '#8b949e' }}>Audit record: sequence <code>{agentResult.audit.sequence}</code> · hash <code>{agentResult.audit.hash}</code></div>
          </div>
          <div style={{ marginTop: 10, paddingTop: 9, borderTop: '1px solid #30363d', fontSize: 11 }}>
            <strong style={{ color: '#e3b341' }}>Model-generated explanation · UNVERIFIED</strong>
            <p style={{ whiteSpace: 'pre-wrap', color: '#c9d1d9', margin: '5px 0 3px' }}>{agentResult.explanation}</p>
            <div style={{ color: '#8b949e' }}>The receipt reference proves which deterministic result was supplied; it does not establish that the model’s explanation is semantically correct.</div>
          </div>
          <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <button type="button" onClick={() => void openAgentReview()} disabled={reviewBusy}>
              {reviewBusy ? 'Preparing persisted review…' : reviewRun ? 'Open saved review in Approvals' : 'Send this receipt to human review'}
            </button>
            {reviewRun && <span role="status">Run {reviewRun.runId} · {reviewRun.status.replace('_', ' ')} · engineering verdict {String((reviewRun.details as any)?.engineeringVerdict || reviewRun.verdict)}</span>}
          </div>
          {reviewError && <div role="alert" style={{ marginTop: 8, color: '#ff7b72' }}>{reviewError}</div>}
        </div>
      )}

      {!agentResult && reviewRun && (
        <div role="status" style={{ marginTop: 12, padding: 10, border: '1px solid #30363d', borderRadius: 6 }}>
          Saved analysis review · run <code>{reviewRun.runId}</code> · {reviewRun.status.replace('_', ' ')} · engineering verdict {String((reviewRun.details as any)?.engineeringVerdict || reviewRun.verdict)}
          <button type="button" style={{ marginLeft: 10 }} onClick={() => { window.location.hash = '#/approvals'; }}>Resume in Approvals</button>
        </div>
      )}

      {error && (
        <div role="alert" style={{ marginTop: 12, border: '1px solid #da3633', color: '#ff7b72', borderRadius: 6, padding: '9px 11px', fontSize: 12 }}>
          {error}
        </div>
      )}

      {analysis && (
        <div style={{ marginTop: 16, borderTop: '1px solid #30363d', paddingTop: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <strong style={{ color: verdictColor, fontSize: 14 }}>RESULT: {analysis.result.verdict}</strong>
            <span style={{ color: '#8b949e', fontSize: 11 }}>{analysis.result.rowsAnalyzed} rows · {analysis.source.kind === 'bundled-synthetic-sample' ? 'bundled synthetic data' : analysis.source.kind === 'project-local-file' ? 'project-local file' : 'device upload'}</span>
            <code style={{ color: '#c9d1d9', fontSize: 11 }}>ID {analysis.analysisId}</code>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(145px, 1fr))', gap: 8, marginTop: 12 }}>
            {[
              ['Vibration RMS', `${analysis.result.overallVibrationRms.toFixed(3)} mm/s`],
              ['Peak vibration', `${analysis.result.peakVibration.toFixed(2)} mm/s`],
              ['Peak temperature', `${analysis.result.peakTemperature.toFixed(1)} °C`],
              ['Warnings / critical', `${analysis.result.warningCount} / ${analysis.result.criticalCount}`],
            ].map(([label, value]) => (
              <div key={label} style={{ background: '#0d1117', borderRadius: 6, padding: '9px 11px' }}>
                <div style={{ color: '#8b949e', fontSize: 10 }}>{label}</div>
                <div style={{ color: '#e6edf3', fontSize: 14, marginTop: 3, fontWeight: 600 }}>{value}</div>
              </div>
            ))}
          </div>

          <div style={{ marginTop: 12, fontSize: 11, color: '#8b949e' }}>
            Source SHA-256: <code style={{ color: '#c9d1d9', wordBreak: 'break-all' }}>{analysis.source.sha256}</code>
          </div>
          {analysis.result.findings.length > 0 ? (
            <div style={{ marginTop: 10, overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11, textAlign: 'left' }}>
                <thead>
                  <tr style={{ color: '#8b949e' }}>
                    <th style={{ padding: '6px 8px' }}>Row</th>
                    <th style={{ padding: '6px 8px' }}>Time</th>
                    <th style={{ padding: '6px 8px' }}>Measure</th>
                    <th style={{ padding: '6px 8px' }}>Reading</th>
                    <th style={{ padding: '6px 8px' }}>Demo limit</th>
                    <th style={{ padding: '6px 8px' }}>Level</th>
                  </tr>
                </thead>
                <tbody>
                  {analysis.result.findings.slice(0, 12).map((finding, index) => (
                    <tr key={`${finding.row}-${finding.field}-${index}`} style={{ borderTop: '1px solid #30363d' }}>
                      <td style={{ padding: '6px 8px' }}>{finding.row}</td>
                      <td style={{ padding: '6px 8px' }}>{finding.timestamp || '—'}</td>
                      <td style={{ padding: '6px 8px' }}>{finding.field === 'vibration_rms_mm_s' ? 'Vibration' : 'Temperature'}</td>
                      <td style={{ padding: '6px 8px' }}>{finding.value} {finding.unit}</td>
                      <td style={{ padding: '6px 8px' }}>{finding.threshold} {finding.unit}</td>
                      <td style={{ padding: '6px 8px', color: finding.severity === 'CRITICAL' ? '#ff7b72' : '#e3b341' }}>{finding.severity}</td>
                    </tr>
                  ))}
                  {analysis.result.findings.length > 12 && (
                    <tr><td colSpan={6} style={{ padding: 8, color: '#8b949e' }}>Showing first 12 of {analysis.result.findings.length} threshold findings.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          ) : (
            <p style={{ margin: '10px 0', color: '#8b949e', fontSize: 11 }}>No readings crossed the configured demo warning thresholds.</p>
          )}

          <div style={{ marginTop: 12, borderRadius: 6, padding: '10px 12px', background: '#0d1117', fontSize: 11 }}>
            <div style={{ color: '#8b949e' }}>Reproduce this analysis from PowerShell in <code>C:\maos</code>:</div>
            <code style={{ display: 'block', color: '#79c0ff', marginTop: 5, wordBreak: 'break-all' }}>
              node .\dist\cli\index.js industrial verify telemetry --analysis-id {analysis.analysisId} --json
            </code>
            <div style={{ color: '#8b949e', marginTop: 6 }}>Receipt: <code>{analysis.receiptPath}</code> · SHA-256 <code>{analysis.receiptSha256}</code></div>
          </div>
          <p style={{ color: '#8b949e', fontSize: 10, marginBottom: 0 }}>{analysis.disclaimer}</p>
        </div>
      )}
    </section>
  );
};
