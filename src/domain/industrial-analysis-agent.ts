export interface IndustrialAnalysisAgentRequest {
  request: string;
  sourcePath: string;
}

export interface IndustrialAnalysisAgentResult {
  runId: string;
  provider: string;
  requestedModel: string;
  reportedModel: string | null;
  execution: 'provider-tool-call';
  explanation: string;
  reportPath: string;
  reportSha256: string;
  audit: { sequence: number; hash: string };
  evidence: {
    analysisId: string;
    receiptPath: string;
    receiptSha256: string;
    source: { selectedPath: string; evidencePath: string; sha256: string; bytes: number };
    rulesetSha256: string;
    disclaimer: string;
    result: Record<string, unknown>;
    verification: { valid: true; method: 'same-implementation-replay'; sourceHashMatched: true; rulesetHashMatched: true; recomputationMatched: true };
  };
}
